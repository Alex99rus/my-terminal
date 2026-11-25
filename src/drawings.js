import { style } from './chartSettings.js'
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
  { code: 'alert', title: 'Оповещение о цене (Alt+A)', points: 1 },
  { code: 'long', title: 'Длинная позиция (лонг)', points: 1 },
  { code: 'short', title: 'Короткая позиция (шорт)', points: 1 },
  { code: 'ruler', title: 'Линейка (или Shift + щелчок)', points: 0 },
  { code: 'text', title: 'Текст', points: 1 },
]
export const TEXT_SIZES = [12, 14, 18, 24]

// Цвета линии оповещения: ждёт / сработало
export const ALERT_COLOR = '#ff9800'
export const ALERT_DONE_COLOR = '#787b86'

/** Новое оповещение на цене price. lastPrice — текущая цена: по ней понимаем, ждём роста или падения */
export function makeAlert(price, lastPrice) {
  return {
    id: uid(),
    type: 'alert',
    price,
    dir: lastPrice != null && price < lastPrice ? 'down' : 'up', // цена должна упасть до уровня или вырасти
    active: true,
    created: Date.now(),
    color: ALERT_COLOR,
    width: 1,
    dash: true,
  }
}
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
const settings = {
  color: '#2962ff', width: 2, dash: false, magnet: false, hidden: false,
  risk: 100, // риск на сделку в долларах — для расчёта объёма позиции
  textSize: 14,
  ...readJson(SETTINGS, {}),
}
const listeners = new Set()

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

export const draw = {
  tool: 'cursor',
  ctrl: false, // зажата Ctrl — магнит включается временно
  selected: null, // { key, id } — выделенный рисунок
  settings,

  list: (key) => data[key] || [],
  keys: () => Object.keys(data), // все монеты, на которых есть рисунки
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
    logical: timeToLogical, // номер свечи (дробный) для времени
    bars: getBars,
    sec: getSec,
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
    case 'long':
    case 'short': {
      const x1 = X(d.entry.time)
      let x2 = X(d.endTime)
      const yE = Y(d.entry.price)
      const yS = Y(d.stop)
      const yT = Y(d.target)
      if ([x1, x2, yE, yS, yT].some((v) => v == null)) return null
      if (x2 < x1 + 20) x2 = x1 + 20
      const top = Math.min(yS, yT)
      const bottom = Math.max(yS, yT)
      return {
        anchors: [
          { part: 'entry', x: x1, y: yE },
          { part: 'stop', x: x1, y: yS },
          { part: 'target', x: x1, y: yT },
          { part: 'end', x: x2, y: yE },
        ],
        lines: [[x1, yE, x2, yE], [x1, yS, x2, yS], [x1, yT, x2, yT]],
        box: [x1, top, x2, bottom],
        x1, x2, yE, yS, yT,
      }
    }
    case 'text': {
      const x = X(d.time)
      const y = Y(d.price)
      if (x == null || y == null) return null
      const lines = (d.text || '').split('\n')
      const w = Math.max(...lines.map((l) => l.length)) * d.size * 0.58 + 8
      const h = lines.length * d.size * 1.25 + 6
      return { anchors: [], lines: [], box: [x - 4, y - 3, x + w, y + h], x, y, textLines: lines }
    }
    case 'alert':
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

// «3д 4ч», «45мин»
function duration(sec) {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d) return `${d}д${h ? ' ' + h + 'ч' : ''}`
  if (h) return `${h}ч${m ? ' ' + m + 'мин' : ''}`
  return `${m}мин`
}

/**
 * Цены линии рисунка в момент времени t (для оповещений на рисунках).
 * Наклонная линия тренда — цена на линии именно в это время; у Фибоначчи — все уровни.
 * Пустой массив — в это время линии нет (например, время за пределами отрезка).
 */
export function drawingLevels(d, t) {
  const along = (p1, p2) => p1.price + ((p2.price - p1.price) * (t - p1.time)) / (p2.time - p1.time || 1)
  switch (d.type) {
    case 'hline':
      return [d.price]
    case 'hray':
      return t >= d.time ? [d.price] : []
    case 'trend': {
      const [a, b] = d.p1.time <= d.p2.time ? [d.p1, d.p2] : [d.p2, d.p1]
      return t >= a.time && t <= b.time ? [along(d.p1, d.p2)] : []
    }
    case 'ray': {
      const forward = d.p2.time >= d.p1.time
      return (forward ? t >= d.p1.time : t <= d.p1.time) ? [along(d.p1, d.p2)] : []
    }
    case 'rect': {
      const t1 = Math.min(d.p1.time, d.p2.time)
      const t2 = Math.max(d.p1.time, d.p2.time)
      return t >= t1 && t <= t2 ? [d.p1.price, d.p2.price] : []
    }
    case 'fib':
      return t >= Math.min(d.p1.time, d.p2.time) ? FIB.map(([lv]) => fibPrice(d, lv)) : []
  }
  return []
}
export const ALERTABLE = ['hline', 'hray', 'trend', 'ray', 'rect', 'fib']
export const DRAWING_NAMES = {
  hline: 'горизонтальная линия', hray: 'горизонтальный луч', trend: 'линия тренда',
  ray: 'луч', rect: 'прямоугольник', fib: 'Фибоначчи',
}

/**
 * Расчёт позиции: соотношение прибыль/риск (R), объём по риску в долларах и ход сделки
 * по свечам после входа: что раньше коснулось — стоп или цель (если в одной свече оба — считаем стоп).
 */
export function positionStats(d, a) {
  const risk = Math.abs(d.entry.price - d.stop) || 1e-12
  const rr = Math.abs(d.target - d.entry.price) / risk
  const qty = settings.risk / risk
  const long = d.type === 'long'
  const bars = a.bars()
  let outcome = null
  const last = bars.at(-1)
  if (last && d.entry.time <= last.time) {
    const start = Math.max(0, Math.ceil(a.logical(d.entry.time)))
    for (let i = start; i < bars.length; i++) {
      const b = bars[i]
      const hitStop = long ? b.low <= d.stop : b.high >= d.stop
      const hitTarget = long ? b.high >= d.target : b.low <= d.target
      if (hitStop) {
        outcome = { closed: true, byTarget: false, time: b.time, price: d.stop, r: -1 }
        break
      }
      if (hitTarget) {
        outcome = { closed: true, byTarget: true, time: b.time, price: d.target, r: rr }
        break
      }
    }
    if (!outcome) {
      const r = ((last.close - d.entry.price) / risk) * (long ? 1 : -1)
      outcome = { closed: false, time: last.time, price: last.close, r }
    }
  }
  return { rr, qty, outcome }
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
  constructor(adapter, getKey, showSelection = true, scale = 1, getSnap = null, getMeasure = null) {
    this.a = adapter
    this.getMeasure = getMeasure // линейка (временная, не сохраняется)
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
    const out = []
    const a = this.a
    const label = (price, color, prefix = '') => {
      const y = a.priceToY(price)
      if (y == null) return
      out.push({
        coordinate: () => y,
        text: () => prefix + a.format(price),
        textColor: () => (color === '#ffffff' || color === '#ffeb3b' ? '#000' : '#fff'),
        backColor: () => color,
        visible: () => true,
        tickVisible: () => true,
      })
    }
    const key = this.getKey()
    for (const d of draw.list(key)) {
      if (d.type === 'alert') label(d.price, d.color, '🔔 ')
      else if (settings.hidden) continue
      else if (d.type === 'hline' || d.type === 'hray') label(d.price, d.color)
      else if (this.showSelection && draw.selected?.id === d.id && d.entry) {
        label(d.target, '#26a69a')
        label(d.entry.price, '#787b86')
        label(d.stop, '#ef5350')
      } else if (this.showSelection && draw.selected?.id === d.id && d.p1) {
        label(d.p1.price, d.color)
        label(d.p2.price, d.color)
      }
    }
    return out
  }

  render(ctx, size) {
    this.renderSnap(ctx)
    this.renderMeasure(ctx)
    const key = this.getKey()
    const list = draw.list(key)
    if (!list.length) return
    const width = this.a.width()
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, width, size.height) // не рисуем поверх шкалы цен
    ctx.clip()
    for (const d of list) {
      if (settings.hidden && d.type !== 'alert') continue // «скрыть рисунки» оповещения не прячет
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
      } else if (d.type === 'long' || d.type === 'short') {
        // цифры позиции — только у выбранной (и на снимках); иначе — только цветные зоны
        this.renderPosition(ctx, d, g, selected || !this.showSelection)
      } else if (d.type === 'text') {
        this.renderText(ctx, d, g, selected)
      } else {
        ctx.beginPath()
        for (const [x1, y1, x2, y2] of g.lines) {
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
        }
        ctx.stroke()
      }
      if (d.alert) this.renderBell(ctx, d, g, width)
      if (selected) {
        ctx.setLineDash([])
        for (const p of g.anchors) {
          ctx.beginPath()
          ctx.arc(p.x, p.y, 5, 0, Math.PI * 2)
          ctx.fillStyle = style.bg || '#0e1116' // точки-ручки — цветом фона графика
          ctx.fill()
          ctx.lineWidth = 2
          ctx.strokeStyle = d.color
          ctx.stroke()
        }
      }
    }
    ctx.restore()
  }

  // Колокольчик у рисунка, на котором стоит оповещение (серый — уже сработало)
  renderBell(ctx, d, g, width) {
    const k = this.k
    let x
    let y
    if (d.type === 'hline') [x, y] = [width - 22 * k, g.lines[0][1]]
    else if (g.anchors.length) {
      const p = g.anchors.reduce((a, b) => (b.x > a.x ? b : a))
      ;[x, y] = [p.x + 10 * k, p.y]
    } else return
    ctx.save()
    ctx.setLineDash([])
    ctx.font = `${13 * k}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.globalAlpha = d.alert.active ? 1 : 0.45
    ctx.fillText('🔔', x, y - 10 * k)
    ctx.restore()
  }

  // Плашка с текстом: прямоугольник с цветным фоном и текстом по центру
  label(ctx, text, cx, cy, bg, fg = '#fff') {
    const k = this.k
    ctx.font = `${12 * k}px -apple-system, "Segoe UI", Roboto, sans-serif`
    const w = ctx.measureText(text).width + 12 * k
    const h = 20 * k
    ctx.fillStyle = bg
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 4 * k)
    else ctx.rect(cx - w / 2, cy - h / 2, w, h)
    ctx.fill()
    ctx.fillStyle = fg
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, cx, cy + 0.5)
    ctx.textAlign = 'left'
  }

  // Длинная / короткая позиция: зона прибыли (зелёная), убытка (красная), подписи, ход сделки
  renderPosition(ctx, d, g, details = true) {
    const a = this.a
    const k = this.k
    const { x1, x2, yE, yS, yT } = g
    ctx.setLineDash([])
    ctx.fillStyle = '#26a69a33'
    ctx.fillRect(x1, Math.min(yE, yT), x2 - x1, Math.abs(yT - yE))
    ctx.fillStyle = '#ef535033'
    ctx.fillRect(x1, Math.min(yE, yS), x2 - x1, Math.abs(yS - yE))
    ctx.lineWidth = k
    ctx.strokeStyle = '#787b86'
    ctx.beginPath()
    ctx.moveTo(x1, yE)
    ctx.lineTo(x2, yE)
    ctx.stroke()

    const st = positionStats(d, a)
    const cx = (x1 + x2) / 2
    if (details) this.positionLabels(ctx, d, g, st, cx)
    this.positionOutcome(ctx, d, g, st, details)
  }

  positionLabels(ctx, d, g, st, cx) {
    const a = this.a
    const k = this.k
    const { yE, yS, yT } = g
    const pct = (p) => (((p - d.entry.price) / d.entry.price) * 100).toFixed(2).replace('.', ',') + '%'
    const up = d.type === 'long'
    const off = 13 * k
    this.label(ctx, `Цель ${a.format(d.target)} (${d.target > d.entry.price ? '+' : ''}${pct(d.target)}) · ${st.rr.toFixed(2).replace('.', ',')}R`, cx, yT + (up ? -off : off), '#26a69a')
    this.label(ctx, `Стоп ${a.format(d.stop)} (${d.stop > d.entry.price ? '+' : ''}${pct(d.stop)})`, cx, yS + (up ? off : -off), '#ef5350')
    const qty = st.qty
    const base = (this.getKey().split(':')[1] || '').replace(/USDT$/, '')
    const qtyText = qty >= 100 ? Math.round(qty).toLocaleString('ru-RU') : qty.toLocaleString('ru-RU', { maximumSignificantDigits: 4 })
    this.label(ctx, `${up ? 'Лонг' : 'Шорт'} · риск ${settings.risk} $ · ${qtyText} ${base} (≈${Math.round(qty * d.entry.price).toLocaleString('ru-RU')} $)`, cx, yE + (up ? off : -off), '#2a2e39', '#d1d4dc')
  }

  positionOutcome(ctx, d, g, st, details) {
    const a = this.a
    const k = this.k
    const { x1, x2, yE } = g
    // ход сделки: пунктир от входа до текущей цены или до точки закрытия
    if (st.outcome) {
      const o = st.outcome
      const xo = a.timeToX(o.time)
      const yo = a.priceToY(o.price)
      if (xo != null && yo != null) {
        const color = o.r >= 0 ? '#26a69a' : '#ef5350'
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5 * k
        ctx.setLineDash([4 * k, 3 * k])
        ctx.beginPath()
        ctx.moveTo(x1, yE)
        ctx.lineTo(xo, yo)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.arc(xo, yo, 3.5 * k, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
        if (!details) return // без выделения — только линия и точка, без подписи
        const r = (o.r >= 0 ? '+' : '') + o.r.toFixed(2).replace('.', ',') + 'R'
        const text = o.closed ? (o.byTarget ? `Цель взята ${r}` : `Стоп ${r}`) : `Сейчас ${r}`
        ctx.font = `${12 * k}px -apple-system, "Segoe UI", Roboto, sans-serif`
        const w = ctx.measureText(text).width + 12 * k
        // подпись — со стороны входа, чтобы не налезать на подписи стопа и цели
        const inward = yo < yE ? 14 * k : -14 * k
        this.label(ctx, text, Math.min(xo + w / 2 + 6 * k, x2 - w / 2 - 2 * k), yo + (Math.abs(yo - yE) < 30 * k ? -inward : inward), color)
      }
    }
  }

  renderText(ctx, d, g, selected) {
    const k = this.k
    ctx.font = `${d.size * k}px -apple-system, "Segoe UI", Roboto, sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillStyle = d.color
    ctx.shadowColor = style.bg || '#0e1116'
    ctx.shadowBlur = 3 * k
    g.textLines.forEach((line, i) => ctx.fillText(line, g.x, g.y + i * d.size * 1.25 * k))
    ctx.shadowBlur = 0
    if (selected) {
      const [l, t, r, b] = g.box
      ctx.setLineDash([3, 3])
      ctx.lineWidth = 1
      ctx.strokeStyle = d.color
      ctx.strokeRect(l, t, r - l, b - t)
    }
  }

  // Линейка: прямоугольник от точки до точки и подпись: цена, %, свечи, время
  renderMeasure(ctx) {
    const m = this.getMeasure?.()
    if (!m) return
    const a = this.a
    const x1 = a.timeToX(m.p1.time)
    const x2 = a.timeToX(m.p2.time)
    const y1 = a.priceToY(m.p1.price)
    const y2 = a.priceToY(m.p2.price)
    if ([x1, x2, y1, y2].some((v) => v == null)) return
    const upMove = m.p2.price >= m.p1.price
    const color = upMove ? '#2962ff' : '#ef5350'
    ctx.save()
    ctx.fillStyle = color + '26'
    ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.setLineDash([])
    ctx.beginPath()
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    ctx.moveTo(mx, y1)
    ctx.lineTo(mx, y2) // стрелка по цене
    ctx.moveTo(x1, my)
    ctx.lineTo(x2, my) // стрелка по времени
    ctx.stroke()
    const diff = m.p2.price - m.p1.price
    const pct = (diff / m.p1.price) * 100
    const bars = Math.round(a.logical(m.p2.time) - a.logical(m.p1.time))
    const text1 = `${diff >= 0 ? '+' : ''}${a.format(diff)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2).replace('.', ',')}%)`
    const text2 = `${bars} свеч. · ${duration(Math.abs(m.p2.time - m.p1.time))}`
    const ly = upMove ? Math.min(y1, y2) - 26 : Math.max(y1, y2) + 26
    this.label(ctx, text1, mx, ly - 10, color)
    this.label(ctx, text2, mx, ly + 10, color)
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
    // двойной щелчок по тексту — редактировать
    el.addEventListener('dblclick', (e) => {
      const { x, y } = this.local(e)
      const hit = hitTest(draw.list(this.key), this.a, x, y)
      if (hit?.d.type === 'text') {
        e.stopPropagation()
        this.editText(hit.d)
      }
    }, true)
    this.measure = null // линейка: { p1, p2, live }
    // магнит включили/выключили, сменили инструмент, зажали Ctrl — перекрестие липнет или нет
    this.offDraw = draw.subscribe(() => this.updateMagnet())
    this.snap = null
  }

  destroy() {
    this.offDraw()
  }

  // Магнит работает, когда он включён (или зажата Ctrl) и мы рисуем или тянем точку рисунка
  get magnetActive() {
    return (settings.magnet || draw.ctrl) && (draw.tool !== 'cursor' || this.mode === 'place' || this.mode === 'measure' || this.mode === 'paper' || (this.dragInfo && this.dragInfo.part !== 'body'))
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

  // Пока тянем рисунок, график не получает движений мыши (иначе он бы прокручивался) и сам перекрестие не двигает.
  // Ставим его сами: в точку под мышью, а с магнитом — туда, где точка действительно окажется (на цене свечи).
  showCross(x, y, e) {
    const chart = this.pane.chart
    if (!this.inside(x, y)) return chart.clearCrosshairPosition()
    const bar = this.a.barAtX(x)
    const p = this.magnetActive ? this.point(x, y, e) : null
    const price = p ? p.price : this.a.yToPrice(y)
    if (!bar || price == null) return chart.clearCrosshairPosition()
    chart.setCrosshairPosition(price, bar.time, this.pane.candles)
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
    if (e.button !== 0 || e.target.closest('.text-editor')) return
    const { x, y } = this.local(e)
    if (!this.inside(x, y)) return

    // линейка: вторая точка — закрепить; следующий щелчок — убрать
    if (this.mode === 'measure') {
      this.finishMeasure(x, y, e)
      this.grab(e)
      return
    }
    if (this.measure && !this.measure.live) {
      this.measure = null
      this.pane.drawPrim?.requestUpdate()
    }
    if (draw.tool === 'ruler' || (e.shiftKey && draw.tool === 'cursor')) {
      const p = this.point(x, y, e)
      if (!p) return
      this.measure = { p1: p, p2: { ...p }, live: true }
      this.mode = 'measure'
      this.placeStart = { x, y }
      this.grab(e)
      this.updateMagnet()
      return
    }

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
      const d = tool === 'alert'
        ? makeAlert(p.price, this.pane.bars.at(-1)?.close)
        : { id: uid(), type: tool, color: s.color, width: s.width, dash: s.dash }
      if (tool === 'long' || tool === 'short') Object.assign(d, this.newPosition(tool, p))
      if (tool === 'text') Object.assign(d, { time: p.time, price: p.price, text: '', size: s.textSize, color: s.color === '#2962ff' ? '#d1d4dc' : s.color })
      if (toolInfo(tool).points === 1) {
        if (tool === 'hline') d.price = p.price
        if (tool === 'vline') d.time = p.time
        if (tool === 'hray') Object.assign(d, p)
        draw.add(this.key, d)
        draw.select(this.key, d.id)
        draw.setTool('cursor')
        if (tool === 'text') setTimeout(() => this.editText(d), 0) // сразу поле для ввода
      } else {
        d.p1 = p
        d.p2 = { ...p }
        draw.add(this.key, d)
        draw.select(this.key, d.id)
        this.mode = 'place'
        this.placeId = d.id
        this.placeStart = { x, y }
      }
      if (settings.hidden && tool !== 'alert') draw.setSetting('hidden', false)
      this.grab(e)
      return
    }

    // линия демо-счёта (стоп, тейк, ордер) — тянем её
    const ph = this.pane.paperHit?.(x, y)
    if (ph) {
      this.mode = 'paper'
      this.paperDrag = { item: ph, price: ph.priceLine.options().price }
      this.grab(e)
      return
    }

    // курсор: щёлкнули по рисунку — выделяем и начинаем тянуть
    const list = settings.hidden ? draw.list(this.key).filter((d) => d.type === 'alert') : draw.list(this.key)
    const hit = hitTest(list, this.a, x, y)
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
    if (this.mode === 'measure') {
      const p = this.point(x, y, e)
      if (p) this.measure.p2 = p
      this.pane.drawPrim?.requestUpdate()
      return
    }
    if (this.mode === 'place') {
      const p = this.point(x, y, e)
      if (p) draw.update(this.key, this.placeId, { p2: p }, false)
      return
    }
    if (this.mode === 'drag') {
      this.applyDrag(x, y, e)
      this.showCross(x, y, e)
      return
    }
    if (this.mode === 'paper') {
      const p = this.point(x, y, e)
      if (p) {
        this.paperDrag.price = p.price
        this.paperDrag.item.priceLine.applyOptions({ price: p.price })
      }
      return
    }
    // подсказка курсором: над рисунком — «рука» или «перемещение»
    let cls = ''
    if (draw.tool !== 'cursor') cls = 'cursor-draw'
    else if (this.inside(x, y)) {
      const list = settings.hidden ? draw.list(this.key).filter((d) => d.type === 'alert') : draw.list(this.key)
      const hit = hitTest(list, this.a, x, y)
      if (hit) cls = hit.part === 'body' ? 'cursor-move' : 'cursor-point'
      else if (this.pane.paperHit?.(x, y)) cls = 'cursor-row'
    }
    if (cls !== this.cursorCls) {
      this.el.classList.remove('cursor-draw', 'cursor-move', 'cursor-point', 'cursor-row')
      if (cls) this.el.classList.add(cls)
      this.cursorCls = cls
    }
  }

  up(e) {
    if (this.mode === 'paper') {
      const { item, price } = this.paperDrag
      this.mode = null
      this.paperDrag = null
      item.line.drag(price) // сохранить новую цену стопа / тейка / ордера
    } else if (this.mode === 'measure') {
      const { x, y } = this.local(e)
      if (Math.hypot(x - this.placeStart.x, y - this.placeStart.y) > 6) this.finishMeasure(x, y, e)
    } else if (this.mode === 'place') {
      // нарисовали «протяжкой» (зажали — потянули — отпустили) — тоже готово
      const { x, y } = this.local(e)
      if (Math.hypot(x - this.placeStart.x, y - this.placeStart.y) > 6) this.finishPlace(x, y, e)
    } else if (this.mode === 'drag') {
      const { x, y } = this.local(e)
      if (!this.inside(x, y)) this.pane.chart.clearCrosshairPosition() // отпустили за пределами графика — убираем «застывшее» перекрестие
      const d = draw.find(this.key, this.dragInfo.id)
      // оповещение передвинули — оно снова ждёт; направление — от текущей цены
      if (d?.type === 'alert') {
        const last = this.pane.bars.at(-1)?.close
        draw.update(this.key, d.id, { active: true, color: ALERT_COLOR, dir: last != null && d.price < last ? 'down' : 'up' }, false)
      }
      this.mode = null
      this.dragInfo = null
      draw.save()
      this.updateMagnet()
    }
    this.blocking = this.mode === 'place' || this.mode === 'measure'
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

  finishMeasure(x, y, e) {
    const p = this.point(x, y, e)
    if (p) this.measure.p2 = p
    this.measure.live = false
    this.mode = null
    this.blocking = false
    if (draw.tool === 'ruler') draw.setTool('cursor')
    this.updateMagnet()
    this.pane.drawPrim?.requestUpdate()
  }

  // Новая позиция: стоп на расстоянии ATR(14), цель — 2R, ширина — 20 свечей
  newPosition(type, p) {
    const bars = this.pane.bars
    let atr = 0
    const n = Math.min(14, bars.length - 1)
    for (let i = bars.length - n; i < bars.length; i++) {
      const b = bars[i]
      const prev = bars[i - 1]
      atr += Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close))
    }
    atr = n > 0 ? atr / n : p.price * 0.01
    const dir = type === 'long' ? 1 : -1
    return {
      entry: p,
      stop: p.price - dir * atr,
      target: p.price + dir * atr * 2,
      endTime: p.time + 20 * this.pane.intervalSec,
    }
  }

  // Поле для ввода текста прямо на графике
  editText(d) {
    const g = geometry(d, this.a, this.a.width())
    if (!g) return
    this.closeEditor?.()
    const ta = document.createElement('textarea')
    ta.className = 'text-editor'
    ta.value = d.text
    Object.assign(ta.style, { left: g.x - 4 + 'px', top: g.y - 3 + 'px', fontSize: d.size + 'px', color: d.color })
    ta.placeholder = 'Текст… (Enter — готово)'
    this.el.append(ta)
    ta.focus()
    ta.select()
    let done = false
    const finish = (save) => {
      if (done) return
      done = true
      const text = ta.value.trim()
      ta.remove()
      this.closeEditor = null
      if (!save) {
        if (!d.text) draw.remove(this.key, d.id)
        return
      }
      if (!text) draw.remove(this.key, d.id)
      else draw.update(this.key, d.id, { text })
    }
    this.closeEditor = () => finish(true)
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation() // клавиши (Delete, стрелки) — тексту, а не графику
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') finish(false)
    })
    ta.addEventListener('blur', () => finish(true))
    ta.addEventListener('pointerdown', (e) => e.stopPropagation())
  }

  cancel() {
    if (this.mode === 'measure' || this.measure) {
      this.measure = null
      this.pane.drawPrim?.requestUpdate()
    }
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
    if (orig.entry && part !== 'body') {
      // позиция: тянем вход, стоп, цель или правый край
      if (!pt) return
      if (part === 'entry') patch = { entry: pt, endTime: orig.endTime + (pt.time - orig.entry.time) }
      if (part === 'stop') patch = { stop: pt.price }
      if (part === 'target') patch = { target: pt.price }
      if (part === 'end') patch = { endTime: Math.max(pt.time, orig.entry.time + this.pane.intervalSec) }
    } else if (orig.entry) {
      patch = {
        entry: { time: shiftT(orig.entry.time), price: shiftP(orig.entry.price) },
        stop: shiftP(orig.stop),
        target: shiftP(orig.target),
        endTime: shiftT(orig.endTime),
      }
    } else if (part === 'p1' && orig.p1) patch = pt && { p1: pt }
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
