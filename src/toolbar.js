// Панель инструментов рисования (слева) и панель настроек выделенного рисунка (сверху).
import { draw, TOOLS, COLORS, TEXT_SIZES, ALERTABLE } from './drawings.js'
import { paper, fmtQty, fmtPrice } from './paper.js'

// Значки — маленькие картинки SVG, нарисованные линиями
const svg = (inner) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
const ICONS = {
  cursor: svg('<path d="M6 3l12 9-5.5 1.2L15 20l-2.4 1-2.6-6.6L6 18z"/>'),
  hline: svg('<path d="M3 12h18"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'),
  hray: svg('<path d="M7 12h14"/><circle cx="6" cy="12" r="2"/>'),
  vline: svg('<path d="M12 3v18"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'),
  trend: svg('<path d="M6 18L18 6"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/>'),
  ray: svg('<path d="M6 18L21 3"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="12" r="2"/>'),
  rect: svg('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  fib: svg('<path d="M3 5h18M3 9.5h18M3 14h18M3 19h18"/>'),
  // лонг — зелёная стрелка вверх, шорт — красная стрелка вниз
  long: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#26a69a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V5"/><path d="M5 11l7-7 7 7"/></svg>',
  short: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#ef5350" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v15"/><path d="M5 13l7 7 7-7"/></svg>',
  ruler: svg('<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>'),
  text: svg('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  alert: svg('<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>'),
  magnet: svg('<path d="M6 4v8a6 6 0 0012 0V4"/><path d="M6 8h4M14 8h4"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0122 12s-1 2-3 4M6.3 6.3C3.6 8 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
}

/**
 * getActiveKey() — монета активного окна (для «Удалить все рисунки»)
 * getPanes() — все окна (чтобы отменить незаконченный рисунок по Esc)
 */
export function initToolbar({ getActiveKey, getPanes, onStep }) {
  const bar = document.getElementById('toolbar')
  const props = document.getElementById('drawProps')

  // ---------- Кнопки слева ----------
  const toolButtons = TOOLS.map((t) => {
    const b = document.createElement('button')
    b.innerHTML = ICONS[t.code]
    b.title = t.title
    b.onclick = () => {
      cancelPlacing()
      draw.setTool(draw.tool === t.code ? 'cursor' : t.code) // повторный щелчок — выключить
    }
    bar.append(b)
    return [t.code, b]
  })
  bar.append(Object.assign(document.createElement('div'), { className: 'sep' }))

  const magnetBtn = document.createElement('button')
  magnetBtn.innerHTML = ICONS.magnet
  magnetBtn.title = 'Магнит: точки липнут к ценам свечей (или держите Ctrl)'
  magnetBtn.onclick = () => {
    const on = !draw.settings.magnet
    draw.setSetting('magnet', on)
    hint(on ? '🧲 Магнит включён: при рисовании точка прилипает к открытию, максимуму, минимуму или закрытию свечи' : 'Магнит выключен')
  }

  const hideBtn = document.createElement('button')
  hideBtn.onclick = () => draw.setSetting('hidden', !draw.settings.hidden)

  const clearBtn = document.createElement('button')
  clearBtn.innerHTML = ICONS.trash
  clearBtn.title = 'Удалить все рисунки этой монеты'
  clearBtn.onclick = () => {
    const key = getActiveKey()
    if (!key || !draw.list(key).length) return
    if (confirm(`Удалить все рисунки ${key.split(':')[1]}?`)) draw.clear(key)
  }
  bar.append(magnetBtn, hideBtn, clearBtn)

  // Предыдущая / следующая монета из списка или скринера
  if (onStep) {
    bar.append(Object.assign(document.createElement('div'), { className: 'sep' }))
    const chevron = (d) => `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`
    for (const [dir, icon, title] of [[-1, chevron('M5 12.5 10 7.5l5 5'), 'Предыдущая монета из списка / скринера (Alt+↑)'], [1, chevron('M5 7.5l5 5 5-5'), 'Следующая монета из списка / скринера (Alt+↓)']]) {
      const b = document.createElement('button')
      b.className = 'step-btn'
      b.innerHTML = icon
      b.title = title
      b.onclick = () => onStep(dir)
      bar.append(b)
    }
  }

  // Ссылка на TradingView — так требует лицензия библиотеки графиков Lightweight Charts
  const credit = document.createElement('a')
  credit.className = 'tv-credit'
  credit.href = 'https://www.tradingview.com/'
  credit.target = '_blank'
  credit.rel = 'noopener'
  credit.title = 'Графики: TradingView Lightweight Charts™ — Copyright © TradingView, Inc. https://www.tradingview.com/'
  credit.textContent = 'TV'
  bar.append(credit)

  // ---------- Настройки выделенного рисунка ----------
  props.innerHTML = `
    <div class="colors">${COLORS.map((c) => `<button class="color" data-color="${c}" style="background:${c}" title="Цвет"></button>`).join('')}</div>
    <span class="dp-sep s1"></span>
    ${[1, 2, 3, 4].map((w) => `<button class="width" data-width="${w}" title="Толщина ${w}"><i style="height:${w}px"></i></button>`).join('')}
    <span class="dp-sep s2"></span>
    <button class="dash" title="Пунктир"><i></i></button>
    <span class="dp-sep s3"></span>
    <span class="sizes">${TEXT_SIZES.map((sz) => `<button class="size" data-size="${sz}" title="Размер ${sz}" style="font-size:${Math.min(sz, 18)}px">A</button>`).join('')}</span>
    <label class="risk" title="Сколько долларов вы готовы потерять, если сработает стоп">Риск $ <input type="number" min="1" step="1"></label>
    <button class="flip" title="Перевернуть: лонг ⇄ шорт">⇅</button>
    <button class="to-paper" title="Выставить эту позицию на демо-счёт: ордер на вход, стоп и тейк">▶ В демо</button>
    <span class="dp-sep s4"></span>
    <span class="bell-wrap">
      <button class="bell" title="Оповещение на этой линии">${ICONS.alert}</button>
      <div class="bell-menu">
        <div class="bm-title">Оповещение, когда цена…</div>
        <button data-mode="cross">пересечёт линию (сразу)</button>
        <div class="bm-title">…или свеча закроется по другую сторону линии</div>
        <button data-mode="close" data-tf="15m">закрытие 15м</button>
        <button data-mode="close" data-tf="1h">закрытие 1ч</button>
        <button data-mode="close" data-tf="4h">закрытие 4ч</button>
        <button data-mode="close" data-tf="1d">закрытие 1Д</button>
        <button data-mode="off" class="bm-off">выключить оповещение</button>
      </div>
    </span>
    <button class="delete" title="Удалить (Delete)">${ICONS.trash}</button>`

  // меняем выделенный рисунок и запоминаем как стиль для следующих
  const change = (patch) => {
    const sel = draw.selected
    if (sel) draw.update(sel.key, sel.id, patch)
    for (const [k, v] of Object.entries(patch)) draw.setSetting(k, v)
  }
  for (const b of props.querySelectorAll('.color')) b.onclick = () => change({ color: b.dataset.color })
  for (const b of props.querySelectorAll('.width')) b.onclick = () => change({ width: +b.dataset.width })
  props.querySelector('.dash').onclick = () => change({ dash: !draw.selectedDrawing()?.dash })
  for (const b of props.querySelectorAll('.size')) {
    b.onclick = () => {
      const sel = draw.selected
      if (sel) draw.update(sel.key, sel.id, { size: +b.dataset.size })
      draw.setSetting('textSize', +b.dataset.size)
    }
  }
  const riskInput = props.querySelector('.risk input')
  riskInput.onchange = () => {
    const v = parseFloat(riskInput.value.replace(',', '.'))
    if (v > 0) draw.setSetting('risk', v)
  }
  riskInput.addEventListener('keydown', (e) => e.stopPropagation())
  // 🔔 оповещение на линии: при пересечении или на закрытии свечи
  const bellMenu = props.querySelector('.bell-menu')
  props.querySelector('.bell').onclick = () => bellMenu.classList.toggle('open')
  for (const b of bellMenu.querySelectorAll('button')) {
    b.onclick = () => {
      const sel = draw.selected
      if (!sel) return
      bellMenu.classList.remove('open')
      if (b.dataset.mode === 'off') return draw.update(sel.key, sel.id, { alert: null })
      if (window.Notification?.permission === 'default') Notification.requestPermission()
      draw.update(sel.key, sel.id, { alert: { active: true, mode: b.dataset.mode, tf: b.dataset.tf || null, created: Date.now() } })
      hint(b.dataset.mode === 'cross' ? '🔔 Оповещение: когда цена пересечёт линию' : `🔔 Оповещение: когда свеча ${b.textContent.replace('закрытие ', '')} закроется по другую сторону линии`)
    }
  }

  // ▶ В демо: позиция с графика → ордер на демо-счёте (вход, стоп, тейк, объём по риску)
  props.querySelector('.to-paper').onclick = () => {
    const sel = draw.selected
    const d = draw.selectedDrawing()
    if (!d?.entry) return
    const last = paper.price(sel.key)
    if (!last) return hint('⚠️ Нет текущей цены этой монеты — откройте её в окне графика')
    const long = d.type === 'long'
    const entry = d.entry.price
    const qty = +(draw.settings.risk / Math.abs(entry - d.stop)).toPrecision(6)
    // вход почти по текущей цене — по рынку; ниже/выше — лимитом или стопом
    let type = 'market'
    if (Math.abs(entry - last) / last > 0.0005) type = (long ? entry < last : entry > last) ? 'limit' : 'stop'
    const err = paper.placeOrder({ key: sel.key, side: long ? 'buy' : 'sell', type, qty, price: entry, sl: d.stop, tp: d.target })
    if (err) return hint('⚠️ ' + err)
    hint(type === 'market'
      ? `💼 Открыт ${long ? 'лонг' : 'шорт'} ${fmtQty(qty)} по рынку со стопом и тейком`
      : `💼 Выставлен ${type === 'limit' ? 'лимитный' : 'стоп'} ордер ${fmtQty(qty)} по ${fmtPrice(entry)} со стопом и тейком`)
  }

  // лонг ⇄ шорт: стоп и цель меняются местами
  props.querySelector('.flip').onclick = () => {
    const sel = draw.selected
    const d = draw.selectedDrawing()
    if (!d?.entry) return
    draw.update(sel.key, sel.id, { type: d.type === 'long' ? 'short' : 'long', stop: d.target, target: d.stop })
  }
  props.querySelector('.delete').onclick = () => deleteSelected()
  // щелчки по панели не должны снимать выделение
  props.addEventListener('pointerdown', (e) => e.stopPropagation())

  function deleteSelected() {
    const sel = draw.selected
    if (sel) draw.remove(sel.key, sel.id)
  }
  function cancelPlacing() {
    for (const p of getPanes()) p.drawCtl.cancel()
  }

  // ---------- Обновление вида ----------
  function render() {
    for (const [code, b] of toolButtons) b.classList.toggle('active', draw.tool === code)
    magnetBtn.classList.toggle('active', draw.settings.magnet || draw.ctrl)
    hideBtn.innerHTML = draw.settings.hidden ? ICONS.eyeOff : ICONS.eye
    hideBtn.title = draw.settings.hidden ? 'Показать рисунки' : 'Скрыть рисунки'
    hideBtn.classList.toggle('active', draw.settings.hidden)

    const d = draw.selectedDrawing()
    props.classList.toggle('show', !!d)
    if (!d) bellMenu.classList.remove('open')
    if (d) {
      // для разных рисунков — разные настройки
      const isPos = d.type === 'long' || d.type === 'short'
      const isText = d.type === 'text'
      const isAlert = d.type === 'alert'
      props.dataset.kind = isPos ? 'position' : isText ? 'text' : isAlert ? 'alert' : 'line'
      props.dataset.alertable = ALERTABLE.includes(d.type) ? '1' : ''
      const bell = props.querySelector('.bell')
      bell.classList.toggle('active', !!d.alert?.active)
      for (const b of bellMenu.querySelectorAll('button')) {
        const on = d.alert && b.dataset.mode === d.alert.mode && (b.dataset.tf || null) === (d.alert.tf || null)
        b.classList.toggle('current', !!on)
      }
      for (const b of props.querySelectorAll('.size')) b.classList.toggle('active', +b.dataset.size === d.size)
      if (document.activeElement !== riskInput) riskInput.value = draw.settings.risk
      for (const b of props.querySelectorAll('.color')) b.classList.toggle('active', b.dataset.color === d.color)
      for (const b of props.querySelectorAll('.width')) b.classList.toggle('active', +b.dataset.width === d.width)
      props.querySelector('.dash').classList.toggle('active', !!d.dash)
    }
    document.body.classList.toggle('drawing', draw.tool !== 'cursor')
  }
  draw.subscribe(render)
  render()

  // Короткое сообщение внизу экрана
  let hintTimer
  function hint(text) {
    const el = document.getElementById('toast')
    if (!el) return
    el.textContent = text
    el.classList.add('show')
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => el.classList.remove('show'), 3500)
  }

  // Ctrl — временный магнит (пока держите)
  document.addEventListener('keydown', (e) => e.key === 'Control' && draw.setCtrl(true))
  document.addEventListener('keyup', (e) => e.key === 'Control' && draw.setCtrl(false))
  window.addEventListener('blur', () => draw.setCtrl(false))

  // ---------- Клавиши ----------
  const HOTKEYS = { KeyH: 'hline', KeyJ: 'hray', KeyV: 'vline', KeyT: 'trend', KeyR: 'rect', KeyF: 'fib' } // Alt+A — в alerts.js
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return
    if (e.key === 'Escape') {
      cancelPlacing()
      draw.setTool('cursor')
      draw.select(null)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && draw.selected) {
      e.preventDefault()
      deleteSelected()
    } else if (e.altKey && HOTKEYS[e.code]) {
      e.preventDefault()
      cancelPlacing()
      draw.setTool(HOTKEYS[e.code])
    }
  })
}
