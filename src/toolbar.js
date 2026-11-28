// Панель инструментов рисования (слева) и панель настроек выделенного рисунка (сверху).
import { draw, TOOLS, COLORS, TEXT_SIZES, ALERTABLE, ALERT_COLOR } from './drawings.js'
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
    <span class="prices"></span>
    <label class="rr" title="Риск/прибыль: во сколько раз цель дальше от входа, чем стоп. Введите число (например 3) — цель встанет на 3R. Стрелки ↑↓ или колёсико — на 0,1, с Shift — на 1">R:R <input type="text" inputmode="decimal"></label>
    <label class="risk" title="Сколько долларов вы готовы потерять, если сработает стоп">Риск $ <input type="number" min="1" step="1"></label>
    <button class="flip" title="Перевернуть: лонг ⇄ шорт">⇅</button>
    <button class="to-paper" title="Выставить эту позицию на демо-счёт: ордер на вход, стоп и тейк">▶ В демо</button>
    <button class="to-real" title="Подставить эту позицию в панель «Реал» (настоящий счёт): вход, стоп, тейк и объём по риску. Ничего не отправляется, пока вы не подтвердите">▶ В реал</button>
    <span class="dp-sep s4"></span>
    <span class="bell-wrap">
      <button class="bell" title="Оповещение на этой линии">${ICONS.alert}</button>
      <div class="bell-menu">
        <div class="bm-title">Оповещение, когда цена…</div>
        <button data-mode="cross">пересечёт линию (сразу)</button>
        <div class="bm-title">…или свеча закроется</div>
        <div class="bm-dirs">
          <button data-dir="above" title="Сигнал, когда свеча закроется выше линии">▲ выше</button>
          <button data-dir="below" title="Сигнал, когда свеча закроется ниже линии">▼ ниже</button>
          <button data-dir="any" title="Сигнал при закрытии по любую сторону линии">⇅ любая</button>
        </div>
        <div class="bm-tfs">
          <button data-mode="close" data-tf="5m">5м</button>
          <button data-mode="close" data-tf="15m">15м</button>
          <button data-mode="close" data-tf="1h">1ч</button>
          <button data-mode="close" data-tf="4h">4ч</button>
          <button data-mode="close" data-tf="1d">1Д</button>
        </div>
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
  // направление «свеча закроется выше / ниже / по любую сторону» — выбирается до таймфрейма
  let closeDir = 'any'
  const DIR_TEXT = { above: 'выше линии', below: 'ниже линии', any: 'по другую сторону линии' }
  const showDir = () => {
    for (const b of bellMenu.querySelectorAll('[data-dir]')) b.classList.toggle('current', b.dataset.dir === closeDir)
  }
  for (const b of bellMenu.querySelectorAll('[data-dir]')) {
    b.onclick = (e) => {
      e.stopPropagation()
      closeDir = b.dataset.dir
      showDir()
      // если у линии уже стоит оповещение по закрытию — сразу меняем направление
      const sel = draw.selected
      const d = draw.selectedDrawing?.()
      if (sel && d?.alert?.mode === 'close') {
        draw.update(sel.key, sel.id, { alert: { ...d.alert, dir: closeDir, active: true, created: Date.now() } })
        hint(`🔔 Оповещение: свеча ${TF_LABEL[d.alert.tf] || d.alert.tf} закроется ${DIR_TEXT[closeDir]}`)
      }
    }
  }
  const TF_LABEL = { '5m': '5м', '15m': '15м', '1h': '1ч', '4h': '4ч', '1d': '1Д' }
  for (const b of bellMenu.querySelectorAll('[data-mode]')) {
    b.onclick = () => {
      const sel = draw.selected
      if (!sel) return
      bellMenu.classList.remove('open')
      if (b.dataset.mode === 'off') return draw.update(sel.key, sel.id, { alert: null })
      if (window.Notification?.permission === 'default') Notification.requestPermission()
      const close = b.dataset.mode === 'close'
      draw.update(sel.key, sel.id, { alert: { active: true, mode: b.dataset.mode, tf: b.dataset.tf || null, dir: close ? closeDir : undefined, created: Date.now() } })
      hint(close ? `🔔 Оповещение: когда свеча ${TF_LABEL[b.dataset.tf]} закроется ${DIR_TEXT[closeDir]}` : '🔔 Оповещение: когда цена пересечёт линию')
    }
  }


  // ---------- Цена цифрами ----------
  // Поля цены выделенного рисунка: ввели число и нажали Enter — линия встала на точную цену.
  const pricesBox = props.querySelector('.prices')
  let pricesKey = ''
  const priceFields = (d) => {
    if (d.entry) return [['Вход', 'entry'], ['Стоп', 'stop'], ['Цель', 'target']]
    if (d.p1 && d.p2) return [['Цена 1', 'p1'], ['Цена 2', 'p2']]
    if (d.type !== 'text' && d.price != null) return [['Цена', 'price']]
    return []
  }
  const getPrice = (d, f) => (f === 'entry' ? d.entry.price : f === 'p1' || f === 'p2' ? d[f].price : d[f])
  // число без пробелов и лишних хвостов, чтобы его можно было править руками
  const plain = (p) => String(+p.toFixed(p >= 1000 ? 2 : p >= 1 ? 4 : p >= 0.01 ? 6 : 8))
  function commitPrice(input) {
    const sel = draw.selected
    const d = draw.selectedDrawing()
    if (!d) return
    const f = input.dataset.field
    const v = parseFloat(input.value.replace(/\s/g, '').replace(',', '.'))
    const revert = () => (input.value = plain(getPrice(d, f)))
    if (!(v > 0) || !isFinite(v)) return revert()
    if (v === getPrice(d, f)) return revert()
    // у позиции стоп и цель должны стоять с нужных сторон от входа
    if (d.entry) {
      const long = d.type === 'long'
      const entry = f === 'entry' ? v : d.entry.price
      const stop = f === 'stop' ? v : d.stop
      const target = f === 'target' ? v : d.target
      const ok = long ? stop < entry && entry < target : target < entry && entry < stop
      if (!ok) {
        hint(long ? '⚠️ У лонга стоп должен быть ниже входа, а цель выше' : '⚠️ У шорта стоп должен быть выше входа, а цель ниже')
        return revert()
      }
    }
    let patch
    if (f === 'entry') patch = { entry: { ...d.entry, price: v } }
    else if (f === 'p1' || f === 'p2') patch = { [f]: { ...d[f], price: v } }
    else patch = { [f]: v }
    // оповещение передвинули — оно снова ждёт; направление считаем от текущей цены (как при перетаскивании)
    if (d.type === 'alert') {
      const last = paper.price(sel.key)
      Object.assign(patch, { active: true, color: ALERT_COLOR, dir: last != null && v < last ? 'down' : 'up' })
    }
    draw.update(sel.key, sel.id, patch)
  }
  // Шаг цены на одну клетку (как на шкале графика этой монеты); с Shift — на десять клеток
  function stepPrice(input, dir, big) {
    const sel = draw.selected
    const d = draw.selectedDrawing()
    if (!d) return
    const f = input.dataset.field
    const pane = [...getPanes()].find((p) => p.key === sel.key)
    const dec = pane?.decimals ?? 2
    const tick = 10 ** -dec
    const typed = parseFloat(input.value.replace(/\s/g, '').replace(',', '.'))
    const base = isFinite(typed) && typed > 0 ? typed : getPrice(d, f)
    // считаем в клетках: цена между клетками (288.0657) сначала встаёт на ближайшую клетку в нужную сторону
    const q = base / tick
    const onGrid = Math.abs(q - Math.round(q)) < 1e-6
    const n = (onGrid ? Math.round(q) + dir : dir > 0 ? Math.ceil(q) : Math.floor(q)) + dir * ((big ? 10 : 1) - 1)
    const next = +(n * tick).toFixed(dec)
    input.value = plain(next)
    commitPrice(input)
    const cur = draw.selectedDrawing()
    if (cur) input.value = plain(getPrice(cur, f)) // что реально применилось (или прежнее, если сторона неверная)
  }
  // ---------- Риск/прибыль (R:R) ----------
  // Показывает, во сколько раз цель дальше от входа, чем стоп. Ввели число — цель переставляется на это расстояние.
  const rrInput = props.querySelector('.rr input')
  const rrOf = (d) => Math.abs(d.target - d.entry.price) / (Math.abs(d.entry.price - d.stop) || 1e-12)
  const fmtRR = (v) => v.toFixed(2).replace('.', ',')
  function commitRR(v) {
    const sel = draw.selected
    const d = draw.selectedDrawing()
    if (!d?.entry) return
    if (!(v > 0) || v > 1000 || !isFinite(v)) return
    const pane = [...getPanes()].find((p) => p.key === sel.key)
    const dec = pane?.decimals ?? 2
    const risk = Math.abs(d.entry.price - d.stop)
    const target = +(d.entry.price + (d.type === 'long' ? 1 : -1) * risk * v).toFixed(dec)
    if (target > 0 && target !== d.target) draw.update(sel.key, sel.id, { target })
  }
  const readRR = () => parseFloat(rrInput.value.replace(/\s/g, '').replace(',', '.'))
  const resetRR = () => {
    const d = draw.selectedDrawing()
    if (d?.entry) rrInput.value = fmtRR(rrOf(d))
  }
  const stepRR = (dir, big) => {
    const d = draw.selectedDrawing()
    if (!d?.entry) return
    const base = readRR() > 0 ? readRR() : rrOf(d)
    const next = Math.round((base + dir * (big ? 1 : 0.1)) * 100) / 100
    if (next > 0) commitRR(next)
    resetRR()
  }
  rrInput.addEventListener('change', () => {
    commitRR(readRR())
    resetRR()
  })
  rrInput.addEventListener('focus', () => rrInput.select())
  rrInput.addEventListener('wheel', (e) => {
    e.preventDefault()
    e.stopPropagation()
    stepRR(e.deltaY < 0 ? 1 : -1, e.shiftKey)
  }, { passive: false })
  rrInput.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      stepRR(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey)
    } else if (e.key === 'Enter') rrInput.blur()
    else if (e.key === 'Escape') {
      resetRR()
      rrInput.blur()
    }
  })

  function renderPrices(d) {
    const fields = d ? priceFields(d) : []
    const key = d ? d.id + ':' + fields.map((x) => x[1]).join() : ''
    if (key !== pricesKey) {
      pricesKey = key
      pricesBox.innerHTML = fields.map(([label, f]) => `<label title="Введите цену и нажмите Enter. Стрелки ↑↓ или колёсико — на один шаг цены, с Shift — на десять шагов">${label} <input type="text" inputmode="decimal" data-field="${f}"></label>`).join('')
      for (const input of pricesBox.querySelectorAll('input')) {
        input.addEventListener('change', () => commitPrice(input))
        input.addEventListener('focus', () => input.select())
        input.addEventListener('wheel', (e) => {
          e.preventDefault() // колёсико над полем меняет цену, а не прокручивает страницу
          e.stopPropagation()
          stepPrice(input, e.deltaY < 0 ? 1 : -1, e.shiftKey)
        }, { passive: false })
        input.addEventListener('keydown', (e) => {
          e.stopPropagation() // Delete, стрелки и Esc — полю, а не графику
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            stepPrice(input, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey)
          } else if (e.key === 'Enter') input.blur()
          else if (e.key === 'Escape') {
            const cur = draw.selectedDrawing()
            if (cur) input.value = plain(getPrice(cur, input.dataset.field))
            input.blur()
          }
        })
      }
    }
    for (const input of pricesBox.querySelectorAll('input')) {
      if (d && document.activeElement !== input) input.value = plain(getPrice(d, input.dataset.field))
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

  // ▶ В реал: позиция с графика → форма панели «Реал» (отправка только после подтверждения там)
  props.querySelector('.to-real').onclick = () => {
    const sel = draw.selected
    const d = draw.selectedDrawing()
    if (!d?.entry) return
    const last = paper.price(sel.key)
    const risk = Math.abs(d.entry.price - d.stop)
    if (!risk) return hint('⚠️ Стоп совпадает со входом')
    const usd = (draw.settings.risk / risk) * d.entry.price
    dispatchEvent(new CustomEvent('real-prefill', { detail: { key: sel.key, long: d.type === 'long', entry: d.entry.price, stop: d.stop, target: d.target, usd, last, hint } }))
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
      for (const b of bellMenu.querySelectorAll('[data-mode]')) {
        const on = d.alert && b.dataset.mode === d.alert.mode && (b.dataset.tf || null) === (d.alert.tf || null)
        b.classList.toggle('current', !!on)
      }
      if (d.alert?.mode === 'close') closeDir = d.alert.dir || 'any'
      showDir()
      for (const b of props.querySelectorAll('.size')) b.classList.toggle('active', +b.dataset.size === d.size)
      if (document.activeElement !== riskInput) riskInput.value = draw.settings.risk
      for (const b of props.querySelectorAll('.color')) b.classList.toggle('active', b.dataset.color === d.color)
      for (const b of props.querySelectorAll('.width')) b.classList.toggle('active', +b.dataset.width === d.width)
      props.querySelector('.dash').classList.toggle('active', !!d.dash)
    }
    renderPrices(d)
    if (d?.entry && document.activeElement !== rrInput) rrInput.value = fmtRR(rrOf(d))
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
  // Стрелки двигают выделенный рисунок на один шаг цены / одну свечу, с Shift — на десять.
  // Слушаем раньше остальных (capture), чтобы ↑↓ не переключали монету в списке, пока что-то выделено.
  window.addEventListener('keydown', (e) => {
    if (!draw.selected || e.ctrlKey || e.altKey || e.metaKey || e.target.closest('input, select, textarea')) return
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
    const panes = [...getPanes()].filter((p) => p.key === draw.selected.key)
    const pane = panes.find((p) => p.isActive) || panes[0]
    const n = e.shiftKey ? 10 : 1
    const dy = e.key === 'ArrowUp' ? n : e.key === 'ArrowDown' ? -n : 0
    const dx = e.key === 'ArrowRight' ? n : e.key === 'ArrowLeft' ? -n : 0
    if (pane?.drawCtl.nudge(dy, dx)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }, true)
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
