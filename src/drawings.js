// Рисование на графике: линии, лучи, прямоугольники, Фибоначчи.
//
// Как устроено:
//  • draw — общее хранилище рисунков. Рисунки привязаны к монете (рынок + тикер), поэтому
//    уровень, нарисованный на дневке, виден и на пятиминутке, и во всех окнах с этой монетой.
//    Точки хранятся как «время + цена», а не пиксели, — так они не уезжают при прокрутке.
//  • DrawingsPrimitive — «слой» поверх графика, который рисует эти рисунки.
//  • DrawingController — обрабатывает мышь в окне: ставит точки, выделяет, перетаскивает.

const STORAGE = 'my-terminal-drawings'
const SETTINGS = 'my-terminal-draw-settings'

// Инструменты: сколько точек нужно поставить
export const TOOLS = [
  { code: 'cursor', title: 'Курсор (Esc)', points: 0 },
  { code: 'hline', title: 'Горизонтальная линия (Alt+H)', points: 1 },
  { code: 'hray', title: 'Горизонтальный луч (Alt+J)', points: 1 },
  { code: 'vline', title: 'Вертикальная линия (Alt+V)', points: 1 },
  { code: 'trend', title: 'Линия тренда (Alt+T)', points: 2 },
  { code: 'ray', title: 'Луч', points: 2 },
  { code: 'rect', title: 'Прямоугольник (Alt+R)', points: 2 },
  { code: 'fib', title: 'Коррекция по Фибоначчи (Alt+F)', points: 2 },
]
const toolInfo = (code) => TOOLS.find((t) => t.code === code)

export const COLORS = ['#2962ff', '#26a69a', '#ef5350', '#ff9800', '#e040fb', '#ffeb3b', '#ffffff', '#787b86']

// Уровни Фибоначчи и их цвета (как в TradingView)
const FIB = [
  [0, '#787b86'],
  [0.236, '#f23645'],
  [0.382, '#ff9800'],
  [0.5, '#4caf50'],
  [0.618, '#089981'],
  [0.786, '#00bcd4'],
  [1, '#787b86'],
]

// ---------- Хранилище ----------

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback
  } catch {
    return fallback
  }
}
const data = readJson(STORAGE, {}) // { 'futures:BTCUSDT': [рисунок, …] }
const settings = { color: '#2962ff', width: 2, dash: false, magnet: false, hidden: false, ...readJson(SETTINGS, {}) }
const listeners = new Set()

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

export const draw = {
  tool: 'cursor',
  ctrl: false, // зажата Ctrl — магнит включается временно
  selected: null, // { key, id } — выделенный рисунок
  settings,

  list: (key) => data[key] || [],
  find: (key, id) => (data[key] || []).find((d) => d.id === id),

  add(key, d) {
    ;(data[key] ||= []).push(d)
    this.save()
    emit()
  },
  // save = false — во время перетаскивания: перерисовываем, но в память браузера пишем в конце
  update(key, id, patch, save = true) {
    const d = this.find(key, id)
    if (!d) return
    Object.assign(d, patch)
    if (save) this.save()
    emit()
  },
  remove(key, id) {
    data[key] = (data[key] || []).filter((d) => d.id !== id)
    if (this.selected?.id === id) this.selected = null
    this.save()
    emit()
  },
  clear(key) {
    delete data[key]
    this.selected = null
    this.save()
    emit()
  },
  select(key, id) {
    this.selected = key && id ? { key, id } : null
    emit()
  },
  selectedDrawing() {
    return this.selected ? this.find(this.selected.key, this.selected.id) : null
  },
  setTool(code) {
    this.tool = code
    emit()
  },
  setCtrl(on) {
    if (this.ctrl === on) return
    this.ctrl = on
    emit()
  },
  setSetting(name, value) {
    settings[name] = value
    localStorage.setItem(SETTINGS, JSON.stringify(settings))
    emit()
  },
  save() {
    localStorage.setItem(STORAGE, JSON.stringify(data))
  },
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}
function emit() {
  for (const fn of listeners) fn()
}

// ---------- Перевод «время/цена» ⇄ «пиксели» ----------

/**
 * chart — график, getSeries — главная серия, getBars — свечи окна, getSec — длина свечи в секундах.
 * Время, которого нет среди свечей (например, точка с часового графика на дневном),
 * ставится пропорционально внутри свечи; за краями истории — продолжаем шаг свечей.
 */
export function makeAdapter(chart, getSeries, getBars, getSec) {
  const ts = () => chart.timeScale()

  function timeToLogical(t) {
    const bars = getBars()
    const n = bars.length
    if (!n) return null
    const sec = getSec()
    if (t < bars[0].time) return (t - bars[0].time) / sec
    if (t >= bars[n - 1].time) return n - 1 + (t - bars[n - 1].time) / sec
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (bars[mid].time <= t) lo = mid
      else hi = mid - 1
    }
    return lo + (t - bars[lo].time) / (bars[lo + 1].time - bars[lo].time)
  }

  function logicalToTime(l) {
    const bars = getBars()
    const n = bars.length
    if (!n) return null
    const sec = getSec()
    const i = Math.round(l)
    if (i < 0) return bars[0].time + i * sec
    if (i > n - 1) return bars[n - 1].time + (i - (n - 1)) * sec
    return bars[i].time
  }

  // Библиотека умеет переводить в пиксели только целый номер свечи,
  // поэтому дробный (точка внутри свечи) считаем между двумя соседними
  function logicalToX(l) {
    const i = Math.floor(l)
    const x0 = ts().logicalToCoordinate(i)
    if (x0 == null || l === i) return x0
    const x1 = ts().logicalToCoordinate(i + 1)
    return x1 == null ? x0 : x0 + (x1 - x0) * (l - i)
  }

  return {
    timeToX(t) {
      const l = timeToLogical(t)
      return l == null ? null : logicalToX(l)
    },
    xToTime(x) {
      const l = ts().coordinateToLogical(x)
      return l == null ? null : logicalToTime(l)
    },
    barAtX(x) {
      const l = ts().coordinateToLogical(x)
      return l == null ? null : getBars()[Math.round(l)] || null
    },
    priceToY: (p) => getSeries().priceToCoordinate(p),
    yToPrice: (y) => getSeries().coordinateToPrice(y),
    width: () => ts().width(), // ширина области графика без шкалы цен
    format: (p) => getSeries().priceFormatter().format(p),
  }
}

// ---------- Геометрия ----------

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = dx * dx + dy * dy
  let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

// Продлить отрезок p1→p2 далеко за p2 (для луча)
function extend(x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  return [x2 + (dx / len) * 10000, y2 + (dy / len) * 10000]
}

const fibPrice = (d, level) => d.p2.price + (d.p1.price - d.p2.price) * level

// Экранные координаты рисунка: точки, за которые можно тянуть, и линии, по которым ловим щелчок
function geometry(d, a, width) {
  const X = (t) => a.timeToX(t)
  const Y = (p) => a.priceToY(p)
  switch (d.type) {
    case 'hline': {
      const y = Y(d.price)
      if (y == null) return null
      return { anchors: [], lines: [[0, y, width, y]] }
    }
    case 'hray': {
      const x = X(d.time)
      const y = Y(d.price)
      if (x == null || y == null) return null
      return { anchors: [{ part: 'p1', x, y }], lines: [[x, y, width + 10000, y]] }
    }
    case 'vline': {
      const x = X(d.time)
      if (x == null) return null
      return { anchors: [], lines: [[x, -10000, x, 10000]] }
    }
    case 'trend':
    case 'ray':
    case 'rect':
    case 'fib': {
      const x1 = X(d.p1.time)
      const y1 = Y(d.p1.price)
      const x2 = X(d.p2.time)
      const y2 = Y(d.p2.price)
      if ([x1, y1, x2, y2].some((v) => v == null)) return null
      const anchors = [
        { part: 'p1', x: x1, y: y1 },
        { part: 'p2', x: x2, y: y2 },
      ]
      if (d.type === 'trend') return { anchors, lines: [[x1, y1, x2, y2]], x1, y1, x2, y2 }
      if (d.type === 'ray') return { anchors, lines: [[x1, y1, ...extend(x1, y1, x2, y2)]], x1, y1, x2, y2 }
      if (d.type === 'rect') {
        anchors.push({ part: 'p1x2', x: x2, y: y1 }, { part: 'p2x1', x: x1, y: y2 })
        return {
          anchors,
          lines: [[x1, y1, x2, y1], [x2, y1, x2, y2], [x2, y2, x1, y2], [x1, y2, x1, y1]],
          box: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
          x1, y1, x2, y2,
        }
      }
      // fib: горизонтальные уровни между двумя точками
      const left = Math.min(x1, x2)
      const right = Math.max(x1, x2)
      const levels = FIB.map(([lv, color]) => ({ lv, color, y: Y(fibPrice(d, lv)) })).filter((l) => l.y != null)
      return {
        anchors,
        lines: [[x1, y1, x2, y2], ...levels.map((l) => [left, l.y, right, l.y])],
        levels, left, right, x1, y1, x2, y2,
      }
    }
  }
  return null
}

/** Что под мышью: { d, part } — part это 'p1', 'p2' (точка) или 'body' (весь рисунок) */
export function hitTest(list, a, x, y) {
  const width = a.width()
  const sel = draw.selected
  // сначала точки выделенного рисунка — за них тянут
  for (const d of list) {
    if (sel?.id !== d.id) continue
    const g = geometry(d, a, width)
    for (const p of g?.anchors || []) if (Math.hypot(p.x - x, p.y - y) <= 7) return { d, part: p.part }
  }
  // потом линии; сверху — последние нарисованные
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i]
    const g = geometry(d, a, width)
    if (!g) continue
    for (const [x1, y1, x2, y2] of g.lines) if (distToSegment(x, y, x1, y1, x2, y2) <= 5) return { d, part: 'body' }
    if (g.box && x >= g.box[0] && x <= g.box[2] && y >= g.box[1] && y <= g.box[3]) return { d, part: 'body' }
  }
  return null
}

// ---------- Слой, который рисует ----------

export class DrawingsPrimitive {
  /** adapter — перевод координат, getKey — какая монета в окне, showSelection — рисовать точки выделения */
  constructor(adapter, getKey, showSelection = true, scale = 1, getSnap = null) {
    this.a = adapter
    this.getSnap = getSnap // точка, к которой сейчас «прилип» магнит (рисуем кружок)
    this.k = scale // для снимков: толщина линий и шрифт крупнее
    this.getKey = getKey
    this.showSelection = showSelection
    const self = this
    this._view = {
      zOrder: () => 'top',
      renderer: () => ({
        draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => self.render(context, mediaSize)),
      }),
    }
  }
  attached({ requestUpdate }) {
    this._request = requestUpdate
  }
  detached() {
    this._request = null
  }
  requestUpdate() {
    this._request?.()
  }
  paneViews() {
    return [this._view]
  }

  // Подписи цены на правой шкале для горизонтальных линий и точек выделенного рисунка
  priceAxisViews() {
    if (settings.hidden) return []
    const out = []
    const a = this.a
    const label = (price, color) => {
      const y = a.priceToY(price)
      if (y == null) return
      out.push({
        coordinate: () => y,
        text: () => a.format(price),
        textColor: () => (color === '#ffffff' || color === '#ffeb3b' ? '#000' : '#fff'),
        backColor: () => color,
        visible: () => true,
        tickVisible: () => true,
      })
    }
    const key = this.getKey()
    for (const d of draw.list(key)) {
      if (d.type === 'hline' || d.type === 'hray') label(d.price, d.color)
      else if (this.showSelection && draw.selected?.id === d.id && d.p1) {
        label(d.p1.price, d.color)
        label(d.p2.price, d.color)
      }
    }
    return out
  }

  render(ctx, size) {
    this.renderSnap(ctx)
    if (settings.hidden) return
    const key = this.getKey()
    const list = draw.list(key)
    if (!list.length) return
    const width = this.a.width()
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, width, size.height) // не рисуем поверх шкалы цен
    ctx.clip()
    for (const d of list) {
      const g = geometry(d, this.a, width)
      if (!g) continue
      const selected = this.showSelection && draw.selected?.id === d.id
      ctx.strokeStyle = d.color
      const k = this.k
      ctx.lineWidth = d.width * k
      ctx.setLineDash(d.dash ? [6 * k, 4 * k] : [])

      if (d.type === 'rect') {
        const [l, t, r, b] = g.box
        ctx.fillStyle = d.color + '26'
        ctx.fillRect(l, t, r - l, b - t)
      }
      if (d.type === 'fib') {
        this.renderFib(ctx, d, g)
      } else {
        ctx.beginPath()
        for (const [x1, y1, x2, y2] of g.lines) {
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
        }
        ctx.stroke()
      }
      if (selected) {
        ctx.setLineDash([])
        for (const p of g.anchors) {
          ctx.beginPath()
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2)
          ctx.fillStyle = '#0e1116'
          ctx.fill()
          ctx.lineWidth = 2
          ctx.strokeStyle = d.color
          ctx.stroke()
        }
      }
    }
    ctx.restore()
  }

  // Магнит: кружок на цене свечи, к которой прилипнет точка
  renderSnap(ctx) {
    const p = this.getSnap?.()
    if (!p) return
    const x = this.a.timeToX(p.time)
    const y = this.a.priceToY(p.price)
    if (x == null || y == null) return
    ctx.save()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.arc(x, y, 6, 0, Math.PI * 2)
    ctx.fillStyle = '#2962ff40'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = '#2962ff'
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, 2, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.restore()
  }

  renderFib(ctx, d, g) {
    const { levels, left, right } = g
    // заливка между соседними уровнями
    for (let i = 0; i < levels.length - 1; i++) {
      ctx.fillStyle = levels[i + 1].color + '1f'
      const top = Math.min(levels[i].y, levels[i + 1].y)
      ctx.fillRect(left, top, right - left, Math.abs(levels[i + 1].y - levels[i].y))
    }
    const k = this.k
    ctx.font = `${11 * k}px -apple-system, "Segoe UI", Roboto, sans-serif`
    ctx.textBaseline = 'bottom'
    for (const l of levels) {
      ctx.strokeStyle = l.color
      ctx.beginPath()
      ctx.moveTo(left, l.y)
      ctx.lineTo(right, l.y)
      ctx.stroke()
      ctx.fillStyle = l.color
      const text = `${l.lv} (${this.a.format(fibPrice(d, l.lv))})`
      ctx.fillText(text, left + 4 * k, l.y - 2 * k)
    }
    // диагональ от точки к точке — пунктиром
    ctx.strokeStyle = d.color
    ctx.setLineDash([4 * k, 4 * k])
    ctx.lineWidth = k
    ctx.beginPath()
    ctx.moveTo(g.x1, g.y1)
    ctx.lineTo(g.x2, g.y2)
    ctx.stroke()
  }
}

// ---------- Мышь: ставим точки, выделяем, тянем ----------

export class DrawingController {
  /** pane — окно графика (Pane из pane.js) */
  constructor(pane) {
    this.pane = pane
    this.el = pane.chartEl
    this.mode = null // 'place' — ставим вторую точку, 'drag' — тянем рисунок
    this.blocking = false // не отдаём события графику (чтобы он не прокручивался)
    const el = this.el
    const opt = { capture: true, passive: false }
    el.addEventListener('pointerdown', (e) => this.down(e), opt)
    el.addEventListener('pointermove', (e) => this.move(e), opt)
    el.addEventListener('pointerup', (e) => this.up(e), opt)
    el.addEventListener('pointercancel', (e) => this.up(e), opt)
    // График слушает мышь сам — пока мы что-то рисуем или тянем, «перехватываем» её
    const stop = (e) => {
      if (this.blocking) {
        e.stopPropagation()
        if (e.cancelable) e.preventDefault()
      }
    }
    for (const t of ['mousedown', 'touchstart', 'dblclick']) el.addEventListener(t, stop, opt)
    for (const t of ['mousemove', 'touchmove']) {
      el.addEventListener(t, (e) => this.mode === 'drag' && stop(e), opt)
    }
    el.addEventListener('pointerleave', () => this.setSnap(null))
    // магнит включили/выключили, сменили инструмент, зажали Ctrl — перекрестие липнет или нет
    this.offDraw = draw.subscribe(() => this.updateMagnet())
    this.snap = null
  }

  destroy() {
    this.offDraw()
  }

  // Магнит работает, когда он включён (или зажата Ctrl) и мы рисуем или тянем точку рисунка
  get magnetActive() {
    return (settings.magnet || draw.ctrl) && (draw.tool !== 'cursor' || this.mode === 'place' || this.dragInfo?.part?.startsWith('p'))
  }

  // Перекрестие «прилипает» к ценам свечи: открытие, максимум, минимум, закрытие
  updateMagnet() {
    const on = this.magnetActive
    if (on !== this.magnetOn) {
      this.magnetOn = on
      this.pane.chart.applyOptions({ crosshair: { mode: on ? 3 : 0 } }) // 3 — MagnetOHLC, 0 — обычное
    }
    if (!on) this.setSnap(null)
  }

  setSnap(p) {
    if (!p && !this.snap) return
    this.snap = p
    this.pane.drawPrim?.requestUpdate()
  }

  get key() {
    return this.pane.key
  }
  get a() {
    return this.pane.adapter
  }

  local(e) {
    const r = this.el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  // Внутри ли области свечей (не на шкале цен и не на шкале времени)
  inside(x, y) {
    const ts = this.pane.chart.timeScale()
    // только верхняя панель со свечами (под ней могут быть панели индикаторов)
    const mainHeight = this.pane.chart.panes()[0].getHeight()
    return x >= 0 && x <= ts.width() && y >= 0 && y <= mainHeight
  }

  // Точка под мышью: время + цена. С магнитом (или с зажатым Ctrl) цена липнет к ближайшей
  // из цен свечи: открытие, максимум, минимум, закрытие
  point(x, y, e) {
    const a = this.a
    const time = a.xToTime(x)
    let price = a.yToPrice(y)
    if ((settings.magnet || draw.ctrl || e?.ctrlKey) && price != null) {
      const bar = a.barAtX(x)
      if (bar) {
        let best = Infinity
        for (const v of [bar.open, bar.high, bar.low, bar.close]) {
          const dist = Math.abs(a.priceToY(v) - y)
          if (dist < best) {
            best = dist
            price = v
          }
        }
      }
    }
    return time == null || price == null ? null : { time, price }
  }

  grab(e) {
    this.blocking = true
    e.stopPropagation()
    if (e.cancelable) e.preventDefault()
    try {
      this.el.setPointerCapture(e.pointerId)
    } catch {}
  }

  down(e) {
    if (e.button !== 0) return
    const { x, y } = this.local(e)
    if (!this.inside(x, y)) return

    // вторая точка для линии / прямоугольника / Фибоначчи
    if (this.mode === 'place') {
      this.finishPlace(x, y, e)
      this.grab(e)
      return
    }

    const tool = draw.tool
    if (tool !== 'cursor') {
      const p = this.point(x, y, e)
      if (!p) return
      const s = settings
      const d = { id: uid(), type: tool, color: s.color, width: s.width, dash: s.dash }
      if (toolInfo(tool).points === 1) {
        if (tool === 'hline') d.price = p.price
        if (tool === 'vline') d.time = p.time
        if (tool === 'hray') Object.assign(d, p)
        draw.add(this.key, d)
        draw.select(this.key, d.id)
        draw.setTool('cursor')
      } else {
        d.p1 = p
        d.p2 = { ...p }
        draw.add(this.key, d)
        draw.select(this.key, d.id)
        this.mode = 'place'
        this.placeId = d.id
        this.placeStart = { x, y }
      }
      if (settings.hidden) draw.setSetting('hidden', false)
      this.grab(e)
      return
    }

    // курсор: щёлкнули по рисунку — выделяем и начинаем тянуть
    if (settings.hidden) return
    const hit = hitTest(draw.list(this.key), this.a, x, y)
    if (hit) {
      draw.select(this.key, hit.d.id)
      this.mode = 'drag'
      this.dragInfo = { id: hit.d.id, part: hit.part, start: { x, y }, orig: JSON.parse(JSON.stringify(hit.d)) }
      this.grab(e)
      this.updateMagnet()
    } else if (draw.selected) {
      draw.select(null)
    }
  }

  move(e) {
    const { x, y } = this.local(e)
    // магнит: показываем, к какой цене прилипнет точка
    if (this.magnetActive && this.inside(x, y)) this.setSnap(this.point(x, y, e))
    else this.setSnap(null)
    if (this.mode === 'place') {
      const p = this.point(x, y, e)
      if (p) draw.update(this.key, this.placeId, { p2: p }, false)
      return
    }
    if (this.mode === 'drag') {
      this.applyDrag(x, y, e)
      return
    }
    // подсказка курсором: над рисунком — «рука» или «перемещение»
    let cls = ''
    if (draw.tool !== 'cursor') cls = 'cursor-draw'
    else if (!settings.hidden && this.inside(x, y)) {
      const hit = hitTest(draw.list(this.key), this.a, x, y)
      if (hit) cls = hit.part === 'body' ? 'cursor-move' : 'cursor-point'
    }
    if (cls !== this.cursorCls) {
      this.el.classList.remove('cursor-draw', 'cursor-move', 'cursor-point')
      if (cls) this.el.classList.add(cls)
      this.cursorCls = cls
    }
  }

  up(e) {
    if (this.mode === 'place') {
      // нарисовали «протяжкой» (зажали — потянули — отпустили) — тоже готово
      const { x, y } = this.local(e)
      if (Math.hypot(x - this.placeStart.x, y - this.placeStart.y) > 6) this.finishPlace(x, y, e)
    } else if (this.mode === 'drag') {
      this.mode = null
      this.dragInfo = null
      draw.save()
      this.updateMagnet()
    }
    this.blocking = this.mode === 'place'
    try {
      this.el.releasePointerCapture(e.pointerId)
    } catch {}
  }

  finishPlace(x, y, e) {
    const p = this.point(x, y, e)
    if (p) draw.update(this.key, this.placeId, { p2: p })
    this.mode = null
    this.blocking = false
    draw.setTool('cursor')
    this.updateMagnet()
  }

  cancel() {
    if (this.mode === 'place') draw.remove(this.key, this.placeId)
    this.mode = null
    this.blocking = false
  }

  applyDrag(x, y, e) {
    const { id, part, start, orig } = this.dragInfo
    const a = this.a
    const dx = x - start.x
    const dy = y - start.y
    const shiftT = (t) => a.xToTime(a.timeToX(t) + dx) ?? t
    const shiftP = (p) => a.yToPrice(a.priceToY(p) + dy) ?? p
    const pt = this.point(x, y, e)
    let patch
    if (part === 'p1' && orig.p1) patch = pt && { p1: pt }
    else if (part === 'p2') patch = pt && { p2: pt }
    else if (part === 'p1' && orig.type === 'hray') patch = pt && { time: pt.time, price: pt.price }
    else if (part === 'p1x2') patch = pt && { p1: { time: orig.p1.time, price: pt.price }, p2: { time: pt.time, price: orig.p2.price } }
    else if (part === 'p2x1') patch = pt && { p1: { time: pt.time, price: orig.p1.price }, p2: { time: orig.p2.time, price: pt.price } }
    else {
      // тянем весь рисунок
      patch = {}
      if (orig.price != null) patch.price = shiftP(orig.price)
      if (orig.time != null) patch.time = shiftT(orig.time)
      if (orig.p1) {
        patch.p1 = { time: shiftT(orig.p1.time), price: shiftP(orig.p1.price) }
        patch.p2 = { time: shiftT(orig.p2.time), price: shiftP(orig.p2.price) }
      }
    }
    if (patch) draw.update(this.key, id, patch, false)
  }
}
