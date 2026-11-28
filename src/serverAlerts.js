// Сигналы на телефон: терминал отдаёт список оповещений о цене вашему серверу (tools/alertd),
// а сервер следит за ценой и присылает push-уведомление на телефон, даже когда терминал закрыт.
// Ключ хранится только в этом браузере. Без ключа модуль ничего не делает.
// Ключ можно передать ссылкой вида https://сайт/#alertkey=КЛЮЧ — её показывает установщик на сервере.
import { draw, drawingLevels, DRAWING_NAMES } from './drawings.js'

const LS = 'terminal.alertKey'
// ключ из ссылки: запоминаем и убираем из адресной строки
try {
  const m = location.hash.match(/alertkey=([\w-]{16,})/)
  if (m) {
    localStorage.setItem(LS, m[1])
    history.replaceState(null, '', location.pathname + location.search)
  }
} catch {}
// у каждого устройства свой номер: так телефон и компьютер не стирают оповещения друг друга
const deviceId = () => {
  try {
    let id = localStorage.getItem('terminal.deviceId')
    if (!id) localStorage.setItem('terminal.deviceId', (id = Math.random().toString(36).slice(2) + Date.now().toString(36)))
    return id
  } catch {
    return 'x'
  }
}
const readKey = () => {
  try { return localStorage.getItem(LS) || '' } catch { return '' }
}

export function initServerAlerts({ onFired, onFiredDrawing }) {
  let key = readKey()
  let state = { text: '', ok: null } // что показать в меню
  let subscribed = false // этот телефон/браузер подписан на уведомления
  const listeners = new Set()
  const setState = (text, ok) => {
    state = { text, ok }
    listeners.forEach((f) => f())
  }

  function mine() {
    const out = []
    for (const k of draw.keys()) {
      const [market, symbol] = k.split(':')
      for (const d of draw.list(k)) {
        if (d.type === 'alert' && d.active) out.push({ id: d.id, market, symbol, price: d.price, dir: d.dir, armed: d.created || 0 })
        // оповещение на линии («пересечение»): отправляем текущий уровень линии (у наклонных он каждый раз новый)
        if (d.alert?.active && d.alert.mode === 'cross') {
          drawingLevels(d, Date.now() / 1000).forEach((level, i) => {
            if (level > 0) out.push({ id: `${d.id}#${i}`, market, symbol, price: level, dir: 'cross', label: DRAWING_NAMES[d.type], armed: d.alert.created || 0 })
          })
        }
      }
    }
    return out
  }

  async function call(path, body) {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Key': key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (r.status === 403) throw new Error('Неверный ключ')
    if (!r.ok) throw new Error('Сервер ответил ' + r.status)
    return r.json()
  }

  let busy = false
  async function sync() {
    if (!key || busy) return
    busy = true
    try {
      const res = await call('/api/alerts/sync', { alerts: mine(), device: deviceId() })
      for (const f of res.fired || []) {
        const base = String(f.id).split('#')[0]
        for (const k of draw.keys()) {
          const d = draw.find(k, base)
          if (!d) continue
          if (d.type === 'alert' && d.active) onFired(k, d, f.price)
          else if (d.alert?.active && d.alert.mode === 'cross') onFiredDrawing(k, d, f.price)
        }
      }
      const n = (res.push || 0) + (res.telegram ? 1 : 0)
      setState(n ? `включено, на сервере оповещений: ${res.active}` : 'сервер работает, но ни один телефон не подписан', !!n)
    } catch (e) {
      setState(e.message === 'Неверный ключ' ? e.message : 'нет связи с сервером', false)
    } finally {
      busy = false
    }
  }

  let timer = 0
  const later = () => {
    clearTimeout(timer)
    timer = setTimeout(sync, 800)
  }
  draw.subscribe(later)
  // ссылку с ключом вставили в уже открытую вкладку: страница не перезагружается, поэтому читаем ключ сами
  addEventListener('hashchange', () => {
    const m = location.hash.match(/alertkey=([\w-]{16,})/)
    if (!m) return
    history.replaceState(null, '', location.pathname + location.search)
    api.setKey(m[1])
  })
  setInterval(sync, 30000)
  if (key) sync()

  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  async function refreshSub() {
    try {
      subscribed = supported() ? !!(await (await navigator.serviceWorker.ready).pushManager.getSubscription()) : false
    } catch {
      subscribed = false
    }
    listeners.forEach((f) => f())
  }
  if (key) refreshSub()

  const api = {
    supported,
    isSubscribed: () => subscribed,
    // терминал сам поймал сигнал: попросить сервер разослать его остальным устройствам (id — у оповещений о цене и линий)
    async fired(id, text, price, armed) {
      if (!key) return
      try {
        let endpoint = ''
        if (supported()) endpoint = (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.endpoint || ''
        await call('/api/alerts/fired', { id, text, price, endpoint, armed: armed || 0 })
      } catch {}
    },
    // подписать этот телефон/браузер на уведомления
    async enable() {
      if (!supported()) return setState('этот браузер не умеет push. На iPhone добавьте сайт на экран «Домой» и откройте оттуда', false)
      try {
        if ((await Notification.requestPermission()) !== 'granted') return setState('уведомления запрещены — разрешите их в настройках сайта', false)
        const reg = await navigator.serviceWorker.ready
        const { key: pub } = await (await fetch('/api/push/key')).json()
        const pad = '='.repeat((4 - (pub.length % 4)) % 4)
        const bin = atob((pub + pad).replace(/-/g, '+').replace(/_/g, '/'))
        const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(bin, (c) => c.charCodeAt(0)) }))
        await call('/api/push/subscribe', { subscription: sub.toJSON() })
        await refreshSub()
        await sync()
      } catch (e) {
        setState('не получилось включить: ' + (e.message || e), false)
      }
    },
    isOn: () => !!key,
    state: () => state,
    onChange: (f) => listeners.add(f),
    setKey(k) {
      key = (k || '').trim()
      try {
        key ? localStorage.setItem(LS, key) : localStorage.removeItem(LS)
      } catch {}
      state = { text: key ? 'проверяю…' : '', ok: null }
      listeners.forEach((f) => f())
      if (key) {
        sync()
        refreshSub()
      }
    },
    async test() {
      try {
        const r = await call('/api/alerts/test', {})
        setState(r.ok ? 'проверочное уведомление отправлено — смотрите телефон' : 'не вышло: ни один телефон не подписан (нажмите «Включить на этом устройстве»)', !!r.ok)
      } catch (e) {
        setState(e.message, false)
      }
    },
  }
  return api
}
