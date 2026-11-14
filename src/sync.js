// Синхронизация между устройствами (компьютер, телефон…) без своего сервера.
//
// Как устроено:
//  • при включении создаётся случайный «код синхронизации». Из него выводятся два ключа:
//    ключ подписи (по нему серверы узнают «наши» сообщения) и ключ шифрования;
//  • каждый «документ» (рисунки, списки, оповещения…) шифруется на устройстве (AES-GCM)
//    и отправляется на общедоступные серверы сети Nostr. Серверы хранят последнюю версию
//    и сразу рассылают её другим устройствам с тем же кодом. Прочитать данные без кода нельзя;
//  • если документ изменили на двух устройствах, остаётся более позднее изменение.
// Раскладка окон и открытая монета у каждого устройства свои — их не синхронизируем.
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import qrcode from 'qrcode-generator'

const META = 'my-terminal-sync'
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom']
const KIND = 30078 // «данные приложения»: сервер хранит только последнюю версию каждого документа

// ---------- Что синхронизируем ----------
// Обычные документы — целиком ключ хранилища браузера
const PLAIN = {
  drawings: 'my-terminal-drawings', // рисунки и оповещения на графике
  drawSettings: 'my-terminal-draw-settings', // цвет линий, риск в $, магнит
  watchlists: 'my-terminal-watchlists',
  smartAlerts: 'my-terminal-smart-alerts',
  chartStyle: 'my-terminal-chart-style',
  paper: 'my-terminal-paper',
  screener: 'my-terminal-screener',
  lockedLR: 'my-terminal-lr', // сигналы и настройки закрытого индикатора (сам пароль не передаётся)
}
// Из общих настроек терминала берём только «не зависящие от экрана» поля
const MAIN_KEY = 'my-terminal-v2'
const MAIN_FIELDS = ['indicators', 'volume', 'chartType', 'sync', 'snap']

const readJson = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key))
  } catch {
    return null
  }
}
const DOCS = [
  ...Object.entries(PLAIN).map(([name, key]) => ({
    name,
    keys: [key],
    read: () => localStorage.getItem(key),
    write: (json) => origSetItem.call(localStorage, key, json),
  })),
  {
    name: 'terminal',
    keys: [MAIN_KEY],
    read: () => {
      const s = readJson(MAIN_KEY)
      if (!s) return null
      const pick = {}
      for (const f of MAIN_FIELDS) if (s[f] !== undefined) pick[f] = s[f]
      return JSON.stringify(pick)
    },
    write: (json) => origSetItem.call(localStorage, MAIN_KEY, JSON.stringify({ ...(readJson(MAIN_KEY) || {}), ...JSON.parse(json) })),
  },
]
const WATCHED = new Set(DOCS.flatMap((d) => d.keys))

// ---------- Ключи и шифрование ----------
const b64u = (bytes) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64u = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
export const validCode = (code) => /^[A-Za-z0-9_-]{43}$/.test(code || '')
const newCode = () => b64u(crypto.getRandomValues(new Uint8Array(32)))

async function deriveKeys(code) {
  const sk = sha256(utf8ToBytes('my-terminal-sign:' + code))
  const raw = sha256(utf8ToBytes('my-terminal-enc:' + code))
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)), aes, salt: code }
}
// имя документа на сервере тоже скрыто: хэш от имени и кода
const docTag = (keys, name) => bytesToHex(sha256(utf8ToBytes('doc:' + name + ':' + keys.salt))).slice(0, 32)

async function pipe(bytes, stream) {
  const w = stream.writable.getWriter()
  w.write(bytes)
  w.close()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}
// сжать (gzip) и зашифровать
async function seal(aes, text) {
  const raw = utf8ToBytes(text)
  const gzip = typeof CompressionStream !== 'undefined'
  const body = gzip ? await pipe(raw, new CompressionStream('gzip')) : raw
  const plain = new Uint8Array(body.length + 1)
  plain[0] = gzip ? 1 : 0
  plain.set(body, 1)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, plain))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return b64u(out)
}
async function unseal(aes, data) {
  const raw = unb64u(data)
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, aes, raw.slice(12)))
  const body = plain[0] === 1 ? await pipe(plain.slice(1), new DecompressionStream('gzip')) : plain.slice(1)
  return new TextDecoder().decode(body)
}
function signEvent(keys, tag, content) {
  const created_at = Math.floor(Date.now() / 1000)
  const tags = [['d', tag]]
  const id = sha256(utf8ToBytes(JSON.stringify([0, keys.pk, created_at, KIND, tags, content])))
  return { id: bytesToHex(id), pubkey: keys.pk, created_at, kind: KIND, tags, content, sig: bytesToHex(schnorr.sign(id, keys.sk)) }
}
const hash = (s) => (s == null ? '' : bytesToHex(sha256(utf8ToBytes(s))).slice(0, 16))

// ---------- Состояние ----------
let meta = readJson(META) || {} // { code, docs: { name: { ts, hash } } }
meta.docs ||= {}
const saveMeta = () => origSetItem.call(localStorage, META, JSON.stringify(meta))

let keys = null
const sockets = new Map() // адрес → { ws, ok }
let status = 'off' // off | connecting | ok | error
let lastSync = 0
const listeners = new Set()
const emit = () => listeners.forEach((fn) => fn())
let pendingReload = false
let startedAt = Date.now()
// Пока ни один сервер не прислал «всё, что есть» (EOSE), свои данные не отправляем:
// иначе на новом устройстве его пустые данные могли бы затереть настоящие
let ready = false

// ---------- Следим за изменениями в хранилище браузера ----------
const origSetItem = Storage.prototype.setItem
Storage.prototype.setItem = function (key, value) {
  // пришли данные с другого устройства и страница вот-вот перезагрузится — старые данные
  // из памяти этой страницы не должны их затереть
  if (this === localStorage && pendingReload && WATCHED.has(key)) return
  origSetItem.call(this, key, value)
  if (this === localStorage && keys && WATCHED.has(key)) schedulePush()
}

let pushTimer = 0
function schedulePush() {
  clearTimeout(pushTimer)
  pushTimer = setTimeout(pushChanged, 1500) // копим изменения 1,5 секунды и отправляем разом
}

// Отправить документы, которые изменились с прошлой отправки
async function pushChanged(force = false) {
  if (!keys || !ready) return
  for (const doc of DOCS) {
    const json = doc.read()
    if (json == null) continue
    const h = hash(json)
    const m = (meta.docs[doc.name] ||= { ts: 0, hash: '' })
    if (!force && m.hash === h) continue
    if (m.hash !== h || !m.ts) m.ts = Date.now()
    m.hash = h
    saveMeta()
    const content = await seal(keys.aes, JSON.stringify({ ts: m.ts, v: json }))
    const ev = signEvent(keys, docTag(keys, doc.name), content)
    for (const s of sockets.values()) if (s.ws.readyState === 1) s.ws.send(JSON.stringify(['EVENT', ev]))
  }
  lastSync = Date.now()
  emit()
}

// Пришёл документ с другого устройства
async function receive(ev) {
  const tag = ev.tags?.find((t) => t[0] === 'd')?.[1]
  const doc = DOCS.find((d) => docTag(keys, d.name) === tag)
  if (!doc) return
  let env
  try {
    env = JSON.parse(await unseal(keys.aes, ev.content))
  } catch {
    return // не наш ключ или повреждено
  }
  const m = (meta.docs[doc.name] ||= { ts: 0, hash: '' })
  const h = hash(env.v)
  if (h === m.hash || env.ts <= m.ts) return // у нас то же самое или новее
  doc.write(env.v)
  meta.docs[doc.name] = { ts: env.ts, hash: h }
  saveMeta()
  lastSync = Date.now()
  pendingReload = true
  scheduleApply()
}

// Применить пришедшие изменения: проще и надёжнее всего — перезагрузить страницу.
// Делаем это, когда пользователь ничего не делает 3 секунды (не мешаем рисовать и вводить текст).
let applyTimer = 0
let lastInput = 0
for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel'])
  addEventListener(ev, () => (lastInput = Date.now()), { capture: true, passive: true })
function scheduleApply() {
  clearTimeout(applyTimer)
  applyTimer = setTimeout(() => {
    if (!pendingReload) return
    const typing = document.activeElement?.matches?.('input, textarea, select, [contenteditable]')
    if (Date.now() - startedAt < 8000 || document.hidden || (Date.now() - lastInput > 3000 && !typing)) location.reload()
    else {
      showBanner()
      scheduleApply() // попробуем ещё раз чуть позже
    }
  }, 1000)
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden && pendingReload) location.reload()
})
function showBanner() {
  if (document.querySelector('.sync-banner')) return
  const el = document.createElement('div')
  el.className = 'sync-banner'
  el.innerHTML = '🔄 Есть изменения с другого устройства <button>Обновить</button>'
  el.querySelector('button').onclick = () => location.reload()
  document.body.append(el)
}

// ---------- Серверы ----------
function connect() {
  status = 'connecting'
  ready = false
  emit()
  for (const url of RELAYS) openRelay(url)

  function openRelay(url, delay = 0) {
    setTimeout(() => {
      if (!keys) return
      const ws = new WebSocket(url)
      const s = { ws, ok: false }
      sockets.set(url, s)
      ws.onopen = () => {
        s.ok = true
        ws.send(JSON.stringify(['REQ', 'my-terminal', { kinds: [KIND], authors: [keys.pk] }]))
        updateStatus()
      }
      ws.onmessage = (e) => {
        let msg
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        if (msg[0] === 'EVENT' && msg[2]?.pubkey === keys.pk) receive(msg[2])
        // сервер прислал всё, что у него есть, — теперь можно отправлять своё (то, чего там ещё нет)
        if (msg[0] === 'EOSE' && !ready) {
          ready = true
          setTimeout(() => pushChanged(), 300)
        }
      }
      ws.onclose = () => {
        s.ok = false
        updateStatus()
        if (keys && sockets.get(url) === s) openRelay(url, Math.min(30000, (delay || 2000) * 2)) // переподключение
      }
      ws.onerror = () => {}
    }, delay)
  }
}
function updateStatus() {
  const ok = [...sockets.values()].filter((s) => s.ok).length
  status = ok ? 'ok' : 'error'
  emit()
}
function disconnect() {
  const old = [...sockets.values()]
  sockets.clear()
  for (const s of old) s.ws.close()
  status = 'off'
  emit()
}

// ---------- Включить / выключить ----------
async function enable(code) {
  meta = { code, docs: {} } // новые метки времени: первым делом берём версии с серверов
  saveMeta()
  keys = await deriveKeys(code)
  startedAt = Date.now()
  connect()
}
function disable() {
  keys = null
  meta = { docs: {} }
  saveMeta()
  disconnect()
}
export const syncLink = () => `${location.origin}${location.pathname}#sync=${meta.code}`

// ---------- Запуск ----------
export async function initSync() {
  // открыли ссылку синхронизации (#sync=…) — подключаемся
  const m = location.hash.match(/sync=([A-Za-z0-9_-]{43})/)
  if (m) {
    history.replaceState(null, '', location.pathname + location.search)
    if (m[1] !== meta.code) {
      await enable(m[1])
      return
    }
  }
  if (validCode(meta.code)) {
    keys = await deriveKeys(meta.code)
    connect()
  }
}

// ---------- Окно «Синхронизация» ----------
export function onSyncStatus(fn) {
  listeners.add(fn)
  fn()
  return () => listeners.delete(fn)
}
export const syncStatus = () => ({ status, lastSync, relays: [...sockets.entries()].map(([u, s]) => [u, s.ok]) })

export function openSyncDialog() {
  document.querySelector('.sync-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay sync-overlay open'
  document.body.append(overlay)
  const onKey = (e) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    close()
  }
  document.addEventListener('keydown', onKey, true)
  const close = () => {
    off()
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
  }

  function render() {
    if (!keys) {
      overlay.innerHTML = `
        <div class="modal sync-modal">
          <div class="modal-head"><b>🔄 Синхронизация устройств</b><button class="modal-close">✕</button></div>
          <p>Рисунки, оповещения, списки монет, индикаторы, настройки и демо-счёт будут одинаковыми на компьютере, телефоне и других устройствах.</p>
          <p class="muted">Регистрация не нужна. Данные шифруются на устройстве и хранятся на общедоступных серверах сети Nostr — без вашего кода их не прочитать. Раскладка окон и открытая монета у каждого устройства свои.</p>
          <button class="sync-main">Включить синхронизацию</button>
          <div class="sync-or">или, если синхронизация уже включена на другом устройстве:</div>
          <div class="sync-join"><input placeholder="Вставьте ссылку или код" autocomplete="off"><button>Подключиться</button></div>
        </div>`
      overlay.querySelector('.sync-main').onclick = async () => {
        await enable(newCode())
        render()
      }
      const input = overlay.querySelector('.sync-join input')
      overlay.querySelector('.sync-join button').onclick = async () => {
        const code = input.value.match(/[A-Za-z0-9_-]{43}/)?.[0]
        if (!validCode(code)) return alert('Это не похоже на код синхронизации — скопируйте ссылку целиком')
        await enable(code)
        render()
      }
    } else {
      const link = syncLink()
      const qr = qrcode(0, 'M')
      qr.addData(link)
      qr.make()
      const st = syncStatus()
      const relays = st.relays.filter(([, ok]) => ok).length
      overlay.innerHTML = `
        <div class="modal sync-modal">
          <div class="modal-head"><b>🔄 Синхронизация включена</b><button class="modal-close">✕</button></div>
          <div class="sync-state ${st.status}">
            ${st.status === 'ok' ? `● Подключено к серверам: ${relays} из ${RELAYS.length}` : st.status === 'connecting' ? '○ Подключаюсь…' : '● Нет связи с серверами синхронизации — изменения отправятся, когда связь появится'}
            ${st.lastSync ? ` · последний обмен в ${new Date(st.lastSync).toLocaleTimeString('ru-RU')}` : ''}
          </div>
          <p><b>Как подключить телефон или другой компьютер:</b> наведите камеру телефона на QR-код или откройте на устройстве эту ссылку.</p>
          <div class="sync-qr">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
          <div class="sync-join"><input value="${link}" readonly><button class="copy">Копировать</button></div>
          <p class="warn">⚠️ Ссылка — это ключ к вашим данным: кто её получит, сможет их читать и менять. Не публикуйте её.</p>
          <button class="sync-off">Отключить синхронизацию на этом устройстве</button>
        </div>`
      overlay.querySelector('.copy').onclick = async (e) => {
        try {
          await navigator.clipboard.writeText(link)
          e.target.textContent = 'Скопировано ✓'
        } catch {
          overlay.querySelector('.sync-join input').select()
        }
      }
      overlay.querySelector('.sync-off').onclick = () => {
        if (!confirm('Отключить синхронизацию на этом устройстве? Данные на устройстве останутся.')) return
        disable()
        render()
      }
    }
    overlay.querySelector('.modal-close').onclick = close
  }
  overlay.addEventListener('pointerdown', (e) => e.target === overlay && close())
  overlay.addEventListener('keydown', (e) => e.stopPropagation())
  const off = onSyncStatus(() => overlay.isConnected && !overlay.querySelector('input:focus') && render())
}
