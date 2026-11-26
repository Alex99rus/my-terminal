// Сигналы на телефон: терминал отдаёт список оповещений о цене вашему серверу (tools/alertd),
// а сервер следит за ценой и шлёт сообщение в Телеграм, даже когда терминал закрыт.
// Ключ хранится только в этом браузере. Без ключа модуль ничего не делает.
import { draw } from './drawings.js'

const LS = 'terminal.alertKey'
const readKey = () => {
  try { return localStorage.getItem(LS) || '' } catch { return '' }
}

export function initServerAlerts({ onFired }) {
  let key = readKey()
  let state = { text: '', ok: null } // что показать в меню
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
        if (d.type === 'alert' && d.active) out.push({ id: d.id, market, symbol, price: d.price, dir: d.dir })
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
      const res = await call('/api/alerts/sync', { alerts: mine() })
      for (const f of res.fired || []) {
        for (const k of draw.keys()) {
          const d = draw.find(k, f.id)
          if (d && d.type === 'alert' && d.active) onFired(k, d, f.price)
        }
      }
      setState(res.telegram ? `включено, на сервере ${res.active}` : 'сервер работает, но Телеграм не настроен', !!res.telegram)
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
  setInterval(sync, 30000)
  if (key) sync()

  return {
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
      if (key) sync()
    },
    async test() {
      try {
        const r = await call('/api/alerts/test', {})
        setState(r.ok ? 'проверочное сообщение отправлено — смотрите телефон' : 'не удалось отправить в Телеграм', !!r.ok)
      } catch (e) {
        setState(e.message, false)
      }
    },
  }
}
