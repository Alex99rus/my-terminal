// Оповещения о цене.
//
// Оповещение — это особый «рисунок» (тип 'alert'): горизонтальная линия на монете.
// Поэтому его можно двигать мышью и удалять так же, как линии. А этот файл:
//  • следит за ценами всех монет, на которых есть оповещения (даже не открытых на графике);
//  • когда цена дошла до уровня — показывает окошко, играет звук, шлёт уведомление браузера;
//  • рисует список оповещений по кнопке 🔔 вверху.
import { draw, makeAlert, ALERT_COLOR, ALERT_DONE_COLOR, drawingLevels, DRAWING_NAMES } from './drawings.js'
import { subscribeTickers } from './binance.js'
import { smart, describe, openSmartDialog, initSmartAlerts } from './smartAlerts.js'
import { marketShort } from './markets.js'
import { initServerAlerts } from './serverAlerts.js'

function decimalsFor(price) {
  if (price >= 1000) return 2
  if (price >= 1) return 4
  if (price >= 0.01) return 6
  return 8
}
const fmt = (p) => p.toLocaleString('ru-RU', { minimumFractionDigits: decimalsFor(p), maximumFractionDigits: decimalsFor(p) })
const splitKey = (key) => {
  const [market, symbol] = key.split(':')
  return { market, symbol }
}

// Все оповещения о цене: [{ key, d }]
function allAlerts() {
  const out = []
  for (const key of draw.keys()) for (const d of draw.list(key)) if (d.type === 'alert') out.push({ key, d })
  return out
}
// Рисунки, на которых стоит оповещение: [{ key, d }]
function drawingAlerts() {
  const out = []
  for (const key of draw.keys()) for (const d of draw.list(key)) if (d.alert) out.push({ key, d })
  return out
}
const TF_NAMES = { '5m': '5м', '15m': '15м', '1h': '1ч', '4h': '4ч', '1d': '1Д' }

/**
 * getPanes() — окна графиков; getActivePane() — активное окно
 * onOpen(symbol, market) — открыть монету (щелчок по оповещению в списке)
 */
export function initAlerts({ getPanes, getActivePane, onOpen }) {
  // ---------- Проверка цены ----------
  const lastPrice = new Map() // монета → предыдущая цена (чтобы заметить пересечение линии)
  const liveAt = new Map() // монета → когда последний раз пришла цена из открытого окна

  // source: 'live' — цена из окна графика (по каждой сделке), 'ticker' — раз в секунду
  function check(key, price, source = 'live') {
    // если монета открыта в окне — её цена свежее, а секундная может отставать:
    // смешивать их нельзя, иначе у самой линии можно поймать ложное «пересечение»
    if (source === 'live') liveAt.set(key, Date.now())
    else if (Date.now() - (liveAt.get(key) || 0) < 5000) return
    const prev = lastPrice.get(key)
    lastPrice.set(key, price)
    const now = Date.now() / 1000
    for (const d of draw.list(key)) {
      // оповещение о цене
      if (d.type === 'alert' && d.active) {
        if ((d.dir === 'up' && price >= d.price) || (d.dir === 'down' && price <= d.price)) trigger(key, d, price)
      }
      // оповещение на рисунке: цена пересекла линию (между прошлой и новой ценой)
      if (d.alert?.active && d.alert.mode === 'cross' && prev != null && prev !== price) {
        for (const level of drawingLevels(d, now)) {
          if ((prev - level) * (price - level) <= 0) {
            draw.update(key, d.id, { alert: { ...d.alert, active: false, triggeredAt: Date.now() } })
            const { symbol, market } = splitKey(key)
            notify(`${symbol} ${price > prev ? 'пересёк вверх' : 'пересёк вниз'}: ${DRAWING_NAMES[d.type]} (${fmt(level)})`, symbol, market)
            break
          }
        }
      }
    }
  }

  function trigger(key, d, price) {
    draw.update(key, d.id, { active: false, color: ALERT_DONE_COLOR, triggeredAt: Date.now(), triggerPrice: price })
    const { symbol, market } = splitKey(key)
    notify(`${symbol} ${d.dir === 'up' ? 'вырос до' : 'упал до'} ${fmt(d.price)}`, symbol, market)
  }

  // Общий сигнал для всех видов оповещений: окошко, звук, вибрация, уведомление, заголовок
  function notify(text, symbol, market) {
    popup(text, symbol, market)
    beep()
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([200, 100, 200])
    if (window.Notification?.permission === 'granted') {
      try {
        new Notification('🔔 Оповещение', { body: text })
      } catch {}
    }
    flashTitle(`🔔 ${text}`)
  }

  // Цены монет с оповещениями — раз в секунду, даже если монета не открыта на графике
  let subs = []
  let subsKey = ''
  function resubscribe() {
    const byMarket = {}
    for (const { key, d } of [...allAlerts(), ...drawingAlerts()]) {
      if (d.type === 'alert' ? !d.active : !(d.alert.active && d.alert.mode === 'cross')) continue
      const { market, symbol } = splitKey(key)
      ;(byMarket[market] ||= new Set()).add(symbol)
    }
    const sig = JSON.stringify(Object.entries(byMarket).map(([m, s]) => [m, [...s].sort()]).sort())
    if (sig === subsKey) return // набор монет не поменялся — ничего не делаем
    subsKey = sig
    for (const off of subs) off()
    subs = Object.entries(byMarket).map(([market, symbols]) =>
      subscribeTickers(market, [...symbols], (t) => check(`${market}:${t.symbol}`, t.last, 'ticker')),
    )
  }

  // ---------- Окошко, звук, заголовок ----------
  const stack = document.createElement('div')
  stack.className = 'alert-stack'
  document.body.append(stack)
  function popup(text, symbol, market) {
    const el = document.createElement('div')
    el.className = 'alert-pop'
    el.innerHTML = `<b>🔔 Оповещение</b><span>${text}</span><div><button class="open">Открыть</button><button class="ok">OK</button></div>`
    el.querySelector('.ok').onclick = () => el.remove()
    el.querySelector('.open').onclick = () => {
      onOpen(symbol, market)
      el.remove()
    }
    stack.append(el)
  }

  let audio = null
  // браузер разрешает звук только после первого щелчка или нажатия клавиши
  const unlock = () => {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)()
    audio.resume?.()
  }
  document.addEventListener('pointerdown', unlock)
  document.addEventListener('keydown', unlock)
  function beep() {
    if (!audio) return
    const t = audio.currentTime
    for (const [start, freq] of [[0, 880], [0.22, 1175], [0.44, 880]]) {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t + start)
      gain.gain.exponentialRampToValueAtTime(0.25, t + start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + start + 0.18)
      osc.connect(gain).connect(audio.destination)
      osc.start(t + start)
      osc.stop(t + start + 0.2)
    }
  }

  let titleTimer = 0
  function flashTitle(text) {
    clearInterval(titleTimer)
    const original = document.title
    let on = false
    titleTimer = setInterval(() => {
      on = !on
      document.title = on ? text : original
    }, 900)
    const stop = () => {
      clearInterval(titleTimer)
      document.title = original
      window.removeEventListener('focus', stop)
      document.removeEventListener('pointerdown', stop)
    }
    window.addEventListener('focus', stop)
    document.addEventListener('pointerdown', stop)
  }

  // Новое оповещение — спросить разрешение на уведомления браузера (один раз)
  let known = new Set(allAlerts().map((a) => a.d.id))
  function askPermission() {
    const all = allAlerts()
    const fresh = all.some((a) => !known.has(a.d.id))
    known = new Set(all.map((a) => a.d.id))
    if (fresh && window.Notification?.permission === 'default') Notification.requestPermission()
  }

  // ---------- Alt+A — оповещение на цене под курсором ----------
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.code !== 'KeyA' || e.target.closest('input, select, textarea')) return
    e.preventDefault()
    const pane = getPanes().find((p) => p.hovered && p.crosshairPrice != null) || getActivePane()
    if (!pane?.bars.length) return
    const last = pane.bars.at(-1).close
    const price = pane.hovered && pane.crosshairPrice != null ? pane.crosshairPrice : last
    const d = makeAlert(price, last)
    draw.add(pane.key, d)
    draw.select(pane.key, d.id)
  })

  // ---------- Сигналы на телефон (через сервер и Телеграм) ----------
  const phone = initServerAlerts({
    // сервер уже поймал уровень (терминал был закрыт или не успел) — помечаем как сработавшее
    onFired: (key, d, price) => {
      draw.update(key, d.id, { active: false, color: ALERT_DONE_COLOR, triggeredAt: Date.now(), triggerPrice: price })
      const { symbol, market } = splitKey(key)
      popup(`${symbol} ${d.dir === 'up' ? 'вырос до' : 'упал до'} ${fmt(d.price)} (пока терминал был закрыт)`, symbol, market)
    },
    // то же для оповещения на линии
    onFiredDrawing: (key, d, price) => {
      draw.update(key, d.id, { alert: { ...d.alert, active: false, triggeredAt: Date.now() } })
      const { symbol, market } = splitKey(key)
      popup(`${symbol}: цена дошла до линии «${DRAWING_NAMES[d.type]}» (сейчас ${fmt(price)}) — пока терминал был закрыт`, symbol, market)
    },
  })
  phone.onChange(() => renderMenu())

  // ---------- Список оповещений (кнопка 🔔) ----------
  const btn = document.getElementById('alertsBtn')
  const menu = document.getElementById('alertsMenu')
  btn.onclick = () => {
    menu.classList.toggle('open')
    renderMenu()
  }
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.alerts-pick')) menu.classList.remove('open')
  })

  function renderMenu() {
    const time = (ms) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    const tag = (market) => `<em>${marketShort(market)}</em>`
    const status = (active, at) => (active ? 'ждёт' : at ? 'сработало ' + time(at) : 'выкл.')
    // все три вида в одном списке: [{ html, active, at }]
    const rows = []
    for (const { key, d } of allAlerts()) {
      const { symbol, market } = splitKey(key)
      rows.push({
        active: d.active, at: d.triggeredAt || d.created,
        html: `<div class="al-row ${d.active ? '' : 'done'}" data-kind="price" data-key="${key}" data-id="${d.id}">
          <span class="al-sym">${symbol}${tag(market)}</span>
          <span class="al-desc">${d.dir === 'up' ? '▲' : '▼'} ${fmt(d.price)}</span>
          <span class="al-status">${status(d.active, d.triggeredAt)}</span>
          ${d.active ? '<i></i>' : '<button class="al-restart" title="Запустить снова">↻</button>'}
          <button class="al-del" title="Удалить">✕</button></div>`,
      })
    }
    for (const { key, d } of drawingAlerts()) {
      const { symbol, market } = splitKey(key)
      const how = d.alert.mode === 'close' ? `закрытие ${TF_NAMES[d.alert.tf] || d.alert.tf}${d.alert.dir === 'above' ? ' выше' : d.alert.dir === 'below' ? ' ниже' : ''}` : 'пересечение'
      rows.push({
        active: d.alert.active, at: d.alert.triggeredAt || d.alert.created,
        html: `<div class="al-row ${d.alert.active ? '' : 'done'}" data-kind="drawing" data-key="${key}" data-id="${d.id}">
          <span class="al-sym">${symbol}${tag(market)}</span>
          <span class="al-desc">✏️ ${DRAWING_NAMES[d.type]}, ${how}</span>
          <span class="al-status">${status(d.alert.active, d.alert.triggeredAt)}</span>
          ${d.alert.active ? '<i></i>' : '<button class="al-restart" title="Запустить снова">↻</button>'}
          <button class="al-del" title="Снять оповещение с рисунка">✕</button></div>`,
      })
    }
    for (const a of smart.list()) {
      rows.push({
        active: a.active, at: a.triggeredAt || a.created,
        html: `<div class="al-row ${a.active ? '' : 'done'}" data-kind="smart" data-key="${a.market}:${a.symbol}" data-id="${a.id}">
          <span class="al-sym">${a.symbol}${tag(a.market)}</span>
          <span class="al-desc">🧠 ${describe(a)}${a.repeat === 'every' ? ' ↺' : ''}</span>
          <span class="al-status">${status(a.active, a.triggeredAt)}</span>
          ${a.active ? '<i></i>' : '<button class="al-restart" title="Запустить снова">↻</button>'}
          <button class="al-del" title="Удалить">✕</button></div>`,
      })
    }
    const active = rows.filter((r) => r.active).length
    btn.querySelector('.count').textContent = active || ''
    btn.classList.toggle('active', active > 0)
    if (!menu.classList.contains('open')) return
    rows.sort((x, y) => y.active - x.active || (y.at || 0) - (x.at || 0))

    menu.innerHTML =
      `<button class="al-smart">＋ Умное оповещение</button>` +
      (rows.length
        ? rows.map((r) => r.html).join('')
        : `<div class="al-empty">Оповещений нет.<br>
            • <b>о цене</b> — 🔔 на панели слева и щелчок по графику, или <b>Alt+A</b>;<br>
            • <b>на линии</b> — выделите линию и нажмите 🔔 в панели сверху;<br>
            • <b>по индикаторам и движению цены</b> — кнопка «Умное оповещение».</div>`) +
      (rows.some((r) => !r.active) ? '<button class="al-clear">Удалить сработавшие</button>' : '') +
      `<div class="al-phone"><button class="al-phone-key">📱 Сигналы на телефон: ${phone.isOn() ? 'вкл.' : 'выкл.'}</button>` +
      (phone.isOn() && !phone.isSubscribed() ? '<button class="al-phone-sub">🔔 Включить на этом устройстве</button>' : '') +
      (phone.isOn() ? '<button class="al-phone-test">Проверить</button>' : '') +
      (phone.state().text ? `<div class="al-phone-st ${phone.state().ok === false ? 'bad' : ''}">${phone.state().text}</div>` : '') +
      '</div>'

    menu.querySelector('.al-smart').onclick = () => {
      menu.classList.remove('open')
      const p = getActivePane()
      openSmartDialog({ symbol: p?.symbol || 'BTCUSDT', market: p?.market || 'futures', price: p?.bars.at(-1)?.close || 0 })
    }
    for (const row of menu.querySelectorAll('.al-row')) {
      const { key, id, kind } = row.dataset
      row.onclick = (e) => {
        const del = e.target.closest('.al-del')
        const restart = e.target.closest('.al-restart')
        if (kind === 'smart') {
          if (del) return smart.remove(id)
          if (restart) return smart.restart(id)
        } else if (kind === 'drawing') {
          const d = draw.find(key, id)
          if (del) return draw.update(key, id, { alert: null })
          if (restart) return draw.update(key, id, { alert: { ...d.alert, active: true, triggeredAt: null, created: Date.now() } })
        } else {
          if (del) return draw.remove(key, id)
          if (restart) {
            const pane = getPanes().find((p) => p.key === key)
            const d = draw.find(key, id)
            const last = pane?.bars.at(-1)?.close
            return draw.update(key, id, { active: true, color: ALERT_COLOR, triggeredAt: null, dir: last != null && d.price < last ? 'down' : d.dir })
          }
        }
        const { symbol, market } = splitKey(key)
        onOpen(symbol, market)
        menu.classList.remove('open')
      }
    }
    menu.querySelector('.al-phone-key').onclick = () => {
      const k = window.prompt(
        phone.isOn()
          ? 'Секретный ключ сохранён. Вставьте новый или оставьте пустым, чтобы выключить сигналы на телефон:'
          : 'Вставьте секретный ключ, который показал сервер после установки (проще открыть на телефоне ссылку, которую он тоже показал):',
        '',
      )
      if (k !== null) {
        phone.setKey(k)
        if (k.trim()) phone.enable()
      }
    }
    menu.querySelector('.al-phone-sub')?.addEventListener('click', () => phone.enable())
    menu.querySelector('.al-phone-test')?.addEventListener('click', () => phone.test())
    menu.querySelector('.al-clear')?.addEventListener('click', () => {
      for (const { key, d } of allAlerts()) if (!d.active) draw.remove(key, d.id)
      for (const { key, d } of drawingAlerts()) if (!d.alert.active) draw.update(key, d.id, { alert: null })
      for (const a of [...smart.list()]) if (!a.active) smart.remove(a.id)
    })
  }

  // Любое изменение рисунков: обновить подписки, кнопку и список
  draw.subscribe(() => {
    askPermission()
    resubscribe()
    renderMenu()
  })
  smart.subscribe(renderMenu)
  initSmartAlerts({ onNotify: notify })
  resubscribe()
  renderMenu()

  return { check, notify }
}
