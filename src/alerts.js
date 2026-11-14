// Оповещения о цене.
//
// Оповещение — это особый «рисунок» (тип 'alert'): горизонтальная линия на монете.
// Поэтому его можно двигать мышью и удалять так же, как линии. А этот файл:
//  • следит за ценами всех монет, на которых есть оповещения (даже не открытых на графике);
//  • когда цена дошла до уровня — показывает окошко, играет звук, шлёт уведомление браузера;
//  • рисует список оповещений по кнопке 🔔 вверху.
import { draw, makeAlert, ALERT_COLOR, ALERT_DONE_COLOR } from './drawings.js'
import { subscribeTickers } from './binance.js'

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

// Все оповещения: [{ key, d }]
function allAlerts() {
  const out = []
  for (const key of draw.keys()) for (const d of draw.list(key)) if (d.type === 'alert') out.push({ key, d })
  return out
}

/**
 * getPanes() — окна графиков; getActivePane() — активное окно
 * onOpen(symbol, market) — открыть монету (щелчок по оповещению в списке)
 */
export function initAlerts({ getPanes, getActivePane, onOpen }) {
  // ---------- Проверка цены ----------
  function check(key, price) {
    for (const d of draw.list(key)) {
      if (d.type !== 'alert' || !d.active) continue
      if ((d.dir === 'up' && price >= d.price) || (d.dir === 'down' && price <= d.price)) trigger(key, d, price)
    }
  }

  function trigger(key, d, price) {
    draw.update(key, d.id, { active: false, color: ALERT_DONE_COLOR, triggeredAt: Date.now(), triggerPrice: price })
    const { symbol, market } = splitKey(key)
    const text = `${symbol} ${d.dir === 'up' ? 'вырос до' : 'упал до'} ${fmt(d.price)}`
    popup(text, symbol, market)
    beep()
    navigator.vibrate?.([200, 100, 200])
    if (window.Notification?.permission === 'granted') {
      try {
        new Notification('🔔 Оповещение', { body: text + ` (цена ${fmt(price)})`, tag: d.id })
      } catch {}
    }
    flashTitle(`🔔 ${symbol} ${fmt(d.price)}`)
  }

  // Цены монет с оповещениями — раз в секунду, даже если монета не открыта на графике
  let subs = []
  let subsKey = ''
  function resubscribe() {
    const byMarket = {}
    for (const { key, d } of allAlerts()) {
      if (!d.active) continue
      const { market, symbol } = splitKey(key)
      ;(byMarket[market] ||= new Set()).add(symbol)
    }
    const sig = JSON.stringify(Object.entries(byMarket).map(([m, s]) => [m, [...s].sort()]).sort())
    if (sig === subsKey) return // набор монет не поменялся — ничего не делаем
    subsKey = sig
    for (const off of subs) off()
    subs = Object.entries(byMarket).map(([market, symbols]) =>
      subscribeTickers(market, [...symbols], (t) => check(`${market}:${t.symbol}`, t.last)),
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
    const all = allAlerts().sort((a, b) => b.d.active - a.d.active || (b.d.triggeredAt || b.d.created || 0) - (a.d.triggeredAt || a.d.created || 0))
    const active = all.filter((a) => a.d.active).length
    btn.querySelector('.count').textContent = active || ''
    btn.classList.toggle('active', active > 0)
    if (!menu.classList.contains('open')) return
    if (!all.length) {
      menu.innerHTML = `<div class="al-empty">Оповещений нет.<br>Выберите 🔔 на панели слева и щёлкните по графику на нужной цене — или нажмите <b>Alt+A</b>, наведя мышь на цену.</div>`
      return
    }
    const time = (ms) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    menu.innerHTML =
      all
        .map(({ key, d }) => {
          const { symbol, market } = splitKey(key)
          return `<div class="al-row ${d.active ? '' : 'done'}" data-key="${key}" data-id="${d.id}">
            <span class="al-sym">${symbol}<em>${market === 'futures' ? 'фьюч' : 'спот'}</em></span>
            <span class="al-price">${d.dir === 'up' ? '▲' : '▼'} ${fmt(d.price)}</span>
            <span class="al-status">${d.active ? 'ждёт' : 'сработало ' + time(d.triggeredAt)}</span>
            ${d.active ? '' : '<button class="al-restart" title="Запустить снова">↻</button>'}
            <button class="al-del" title="Удалить">✕</button>
          </div>`
        })
        .join('') + (all.some((a) => !a.d.active) ? '<button class="al-clear">Удалить сработавшие</button>' : '')

    for (const row of menu.querySelectorAll('.al-row')) {
      const { key, id } = row.dataset
      row.onclick = (e) => {
        if (e.target.closest('.al-del')) return draw.remove(key, id)
        if (e.target.closest('.al-restart')) {
          const pane = getPanes().find((p) => p.key === key)
          const d = draw.find(key, id)
          const last = pane?.bars.at(-1)?.close
          return draw.update(key, id, { active: true, color: ALERT_COLOR, triggeredAt: null, dir: last != null && d.price < last ? 'down' : d.dir })
        }
        const { symbol, market } = splitKey(key)
        onOpen(symbol, market)
        menu.classList.remove('open')
      }
    }
    menu.querySelector('.al-clear')?.addEventListener('click', () => {
      for (const { key, d } of allAlerts()) if (!d.active) draw.remove(key, d.id)
    })
  }

  // Любое изменение рисунков: обновить подписки, кнопку и список
  draw.subscribe(() => {
    askPermission()
    resubscribe()
    renderMenu()
  })
  resubscribe()
  renderMenu()

  return { check }
}
