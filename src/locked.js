// Закрытые индикаторы: код лежит на сайте только в зашифрованном виде (AES-256-GCM).
// У каждого допущенного человека свой пароль. Пароль → ключ (PBKDF2, 200 000 повторов) →
// им расшифровывается главный ключ → им расшифровывается код индикатора.
// Без пароля код не прочитать и не запустить. Пароли раздаёт разработчик (см. tools/lock.mjs).

export const LOCKED = [
  {
    id: 'lr',
    name: 'Level Break + Retest',
    title: 'Пробой уровня и ретест: сканер до 13 инструментов, вход, стоп и тейк',
  },
]
const PASS_KEY = 'my-terminal-locked' // пароли, введённые на этом устройстве (не синхронизируются)
const BASE = import.meta.env.BASE_URL || './'
const plugins = {} // id → запущенный индикатор
let api = null
const listeners = new Set()
const emit = () => listeners.forEach((fn) => fn())
export const onLockedChange = (fn) => listeners.add(fn)

const enc = new TextEncoder()
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const normPass = (p) => String(p || '').trim().toUpperCase().replace(/\s+/g, '')

const readPasses = () => {
  try {
    return JSON.parse(localStorage.getItem(PASS_KEY)) || {}
  } catch {
    return {}
  }
}
const writePasses = (o) => localStorage.setItem(PASS_KEY, JSON.stringify(o))

async function decryptPlugin(id, password) {
  const pass = normPass(password)
  const get = (f) => fetch(`${BASE}locked/${f}`, { cache: 'no-cache' })
  const meta = await (await get(`${id}.keys.json`)).json()
  const pid = hex(await crypto.subtle.digest('SHA-256', enc.encode(`${id}:${pass}`))).slice(0, 16)
  const entry = meta.entries.find((e) => e.id === pid)
  if (!entry) throw new Error('wrong')
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey'])
  const kek = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(entry.salt), iterations: meta.iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  const master = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(entry.iv) }, kek, unb64(entry.key))
  const mk = await crypto.subtle.importKey('raw', master, 'AES-GCM', false, ['decrypt'])
  const body = new Uint8Array(await (await get(`${id}.bin`)).arrayBuffer())
  const code = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: body.slice(0, 12) }, mk, body.slice(12))
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  try {
    return (await import(/* @vite-ignore */ url)).default
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function unlock(id, password) {
  const install = await decryptPlugin(id, password)
  plugins[id]?.destroy()
  plugins[id] = install({ ...api, logout: () => lockOut(id) })
  writePasses({ ...readPasses(), [id]: normPass(password) })
  emit()
}

export function lockOut(id) {
  plugins[id]?.destroy()
  delete plugins[id]
  const p = readPasses()
  delete p[id]
  writePasses(p)
  emit()
}

export const isUnlocked = (id) => !!plugins[id]
export const lockedState = (id) => (plugins[id] ? (plugins[id].enabled ? 'on' : 'off') : 'locked')

/** Запуск: открыть индикаторы, пароли к которым уже вводили на этом устройстве */
export async function initLocked(terminalApi, toast) {
  api = terminalApi
  for (const [id, pass] of Object.entries(readPasses())) {
    try {
      await unlock(id, pass)
    } catch (e) {
      if (e.message === 'wrong') {
        lockOut(id)
        toast('🔒 Доступ к закрытому индикатору закрыт: пароль больше не действует')
      }
    }
  }
}

/** Щелчок по закрытому индикатору: открыт — настройки, иначе — спросить пароль */
export function openLocked(id) {
  if (plugins[id]) return plugins[id].openSettings()
  const def = LOCKED.find((d) => d.id === id)
  document.querySelector('.lock-overlay')?.remove()
  const o = document.createElement('div')
  o.className = 'modal-overlay lock-overlay open'
  o.innerHTML = `
    <div class="modal lock-modal">
      <div class="modal-head"><b>🔒 ${def.name}</b><button class="modal-close">✕</button></div>
      <p>Это закрытый индикатор. Он доступен только тем, кому разработчик выдал личный пароль.</p>
      <form class="lock-form"><input type="password" placeholder="Пароль, например LR-XXXX-XXXX-XXXX" autocomplete="off"><button>Открыть</button></form>
      <div class="lock-err"></div>
      <p class="muted">Хотите получить доступ? <a href="https://t.me/vedmedik45" target="_blank" rel="noopener">Напишите разработчику в Telegram</a></p>
    </div>`
  document.body.append(o)
  const input = o.querySelector('input')
  const close = () => o.remove()
  o.querySelector('.modal-close').onclick = close
  o.addEventListener('pointerdown', (e) => e.target === o && close())
  o.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') close()
  })
  o.querySelector('form').onsubmit = async (e) => {
    e.preventDefault()
    const btn = o.querySelector('form button')
    btn.disabled = true
    btn.textContent = 'Проверяю…'
    try {
      await unlock(id, input.value)
      close()
      plugins[id].openSettings()
    } catch (err) {
      o.querySelector('.lock-err').textContent = err.message === 'wrong' ? 'Неверный пароль' : 'Не удалось открыть: ' + err.message
      btn.disabled = false
      btn.textContent = 'Открыть'
    }
  }
  setTimeout(() => input.focus(), 50)
}
