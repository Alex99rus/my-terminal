// Свои индикаторы из TradingView: код Pine Script выполняется прямо в браузере (библиотека PineTS)
// на тех же свечах, что видны в окне. Результат рисуем средствами графика:
//  • plot (линии, гистограммы, столбики, кружки, ступеньки, области), plotcandle, hline;
//  • plotshape / plotchar / plotarrow, bgcolor, fill — своим слоем;
//  • label / line / box / linefill / polyline — своим слоем, table — HTML-таблицей поверх графика;
//  • request.security — данные других монет и таймфреймов подгружаем с той же биржи.
// Библиотека большая (~800 КБ), поэтому загружается только когда нужна.
import { LineSeries, HistogramSeries, AreaSeries, CandlestickSeries } from 'lightweight-charts'

let modPromise = null
export const loadPine = () => (modPromise ||= import('pinets'))

// Таймфреймы терминала → Pine
const TO_PINE = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' }

// Название индикатора из кода: indicator("Название", …)
export function pineTitle(code) {
  return code.match(/(?:indicator|study|strategy)\s*\(\s*(?:title\s*=\s*)?["']([^"']+)["']/)?.[1] || 'Мой индикатор'
}
export async function pineInputs(code) {
  const { Indicator } = await loadPine()
  return new Indicator(code).getInputsMeta()
}

// ---------- Цвета и размеры Pine ----------
const PINE_BLUE = '#2962ff'
const col = (c, fallback = PINE_BLUE) => (c == null || c === '' ? fallback : c)
const SIZE = { tiny: 8, small: 11, normal: 14, auto: 12, large: 20, huge: 28 }
const TEXT = { tiny: 9, small: 10, normal: 12, auto: 11, large: 15, huge: 20 }

function dash(ctx, style) {
  if (/dash/.test(style || '')) ctx.setLineDash([6, 4])
  else if (/dot/.test(style || '')) ctx.setLineDash([2, 3])
  else ctx.setLineDash([])
}

// ---------- Слой рисования (фигуры, фон, заливки, рисунки) ----------
class PineLayer {
  constructor(run, overlay) {
    this.run = run
    this.overlay = overlay // true — главная панель (свечи)
    this.views = [
      { zOrder: () => 'bottom', renderer: () => ({ draw: (t) => t.useMediaCoordinateSpace(({ context, mediaSize }) => this.drawBack(context, mediaSize)) }) },
      { renderer: () => ({ draw: (t) => t.useMediaCoordinateSpace(({ context, mediaSize }) => this.drawFront(context, mediaSize)) }) },
    ]
  }
  attached({ series, requestUpdate }) {
    this.series = series
    this.req = requestUpdate
  }
  detached() {
    this.req = null
  }
  paneViews() {
    return this.views
  }
  // время → x (с продолжением вправо за последнюю свечу)
  x(t) {
    return this.run.pane.adapter.timeToX(t)
  }
  y(p) {
    return this.series?.priceToCoordinate(p) ?? null
  }
  barX(i) {
    const bars = this.run.pane.bars
    const n = bars.length
    if (!n) return null
    const t = i <= n - 1 ? bars[Math.max(0, Math.round(i))]?.time : bars[n - 1].time + (i - (n - 1)) * this.run.pane.intervalSec
    return this.x(t)
  }
  px(xv, xloc) {
    return xloc === 'bt' ? this.x(xv / 1000) : this.barX(xv)
  }
  spacing() {
    return this.run.pane.chart.timeScale().options().barSpacing || 6
  }

  drawBack(ctx, size) {
    const r = this.run.result
    if (!r) return
    const w = this.spacing()
    // фон (bgcolor)
    for (const p of r.backgrounds.filter((b) => b.overlay === this.overlay)) {
      for (const d of p.data) {
        const c = d.options?.color
        if (!c || d.value === false) continue
        const x = this.x(d.time / 1000)
        if (x == null || x < -w || x > size.width + w) continue
        ctx.fillStyle = c
        ctx.fillRect(x - w / 2, 0, w + 0.5, size.height)
      }
    }
    // заливки между линиями (fill)
    for (const f of r.fills.filter((b) => b.overlay === this.overlay)) {
      const a = r.byTitle.get(f.options.plot1)
      const b = r.byTitle.get(f.options.plot2)
      if (!a || !b) continue
      const av = new Map(a.data.map((d) => [d.time, d.value]))
      const bv = new Map(b.data.map((d) => [d.time, d.value]))
      let prev = null
      for (const d of f.data) {
        const c = d.options?.color ?? f.options.color
        const v1 = av.get(d.time)
        const v2 = bv.get(d.time)
        const x = this.x(d.time / 1000)
        const cur = Number.isFinite(v1) && Number.isFinite(v2) && x != null ? { x, y1: this.y(v1), y2: this.y(v2), c } : null
        if (prev && cur && cur.c && prev.y1 != null && cur.y1 != null) {
          ctx.fillStyle = cur.c
          ctx.beginPath()
          ctx.moveTo(prev.x, prev.y1)
          ctx.lineTo(cur.x, cur.y1)
          ctx.lineTo(cur.x, cur.y2)
          ctx.lineTo(prev.x, prev.y2)
          ctx.closePath()
          ctx.fill()
        }
        prev = cur
      }
    }
    // заливки между нарисованными линиями (linefill) и прямоугольники (box)
    for (const lf of r.linefills.filter(() => this.overlay === r.overlay)) {
      const p = (l) => [this.px(l.x1, l.xloc), this.y(l.y1), this.px(l.x2, l.xloc), this.y(l.y2)]
      const [a1, b1, a2, b2] = p(lf.line1)
      const [c1, d1, c2, d2] = p(lf.line2)
      if ([a1, b1, a2, b2, c1, d1, c2, d2].some((v) => v == null)) continue
      ctx.fillStyle = col(lf.color)
      ctx.beginPath()
      ctx.moveTo(a1, b1)
      ctx.lineTo(a2, b2)
      ctx.lineTo(c2, d2)
      ctx.lineTo(c1, d1)
      ctx.closePath()
      ctx.fill()
    }
    for (const bx of r.boxes.filter(() => this.overlay === r.overlay)) {
      let x1 = this.px(bx.left, bx.xloc)
      let x2 = this.px(bx.right, bx.xloc)
      const y1 = this.y(bx.top)
      const y2 = this.y(bx.bottom)
      if ([x1, x2, y1, y2].some((v) => v == null)) continue
      if (/r|both/.test(bx.extend || '') && bx.extend !== 'none') x2 = size.width
      if (/^l|both/.test(bx.extend || '')) x1 = 0
      ctx.fillStyle = col(bx.bgcolor, 'rgba(41,98,255,.2)')
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
      if (bx.border_width !== 0) {
        ctx.strokeStyle = col(bx.border_color)
        ctx.lineWidth = bx.border_width || 1
        dash(ctx, bx.border_style)
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
        ctx.setLineDash([])
      }
      if (bx.text) {
        ctx.fillStyle = col(bx.text_color, '#000')
        ctx.font = `${TEXT[bx.text_size] || 11}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(bx.text, (x1 + x2) / 2, (y1 + y2) / 2)
      }
    }
  }

  drawFront(ctx, size) {
    const r = this.run.result
    if (!r) return
    const bars = this.run.pane.bars
    const idx = this.run.timeIndex
    // значки plotshape / plotchar / plotarrow
    for (const p of r.shapes.filter((s) => s.overlay === this.overlay)) {
      for (const d of p.data) {
        const v = d.value
        if (v === false || v == null || (typeof v === 'number' && (!Number.isFinite(v) || (p.isArrow && v === 0)))) continue
        const x = this.x(d.time / 1000)
        if (x == null || x < -20 || x > size.width + 20) continue
        const o = { ...p.options, ...d.options }
        const i = idx.get(d.time / 1000)
        const bar = i != null ? bars[i] : null
        const s = SIZE[o.size] || (p.isArrow ? 10 : 9)
        let loc = o.location || (p.isChar ? 'AboveBar' : 'AboveBar')
        if (p.isArrow) loc = v > 0 ? 'BelowBar' : 'AboveBar'
        let y
        if (/Absolute/i.test(loc)) y = this.y(typeof v === 'number' ? v : bar?.close)
        else if (/Top/i.test(loc)) y = 10
        else if (/Bottom/i.test(loc)) y = size.height - 10
        else if (/Below/i.test(loc)) y = bar && this.overlay ? this.y(bar.low) + s : size.height - 10
        else y = bar && this.overlay ? this.y(bar.high) - s : 10
        if (y == null) continue
        const color = col(o.color, p.isArrow ? (v > 0 ? '#089981' : '#f23645') : PINE_BLUE)
        ctx.fillStyle = color
        ctx.strokeStyle = color
        let shape = o.shape || ''
        if (p.isArrow) shape = v > 0 ? 'shape_arrow_up' : 'shape_arrow_down'
        if (p.isChar) {
          ctx.font = `${s + 4}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(o.char || '★', x, y)
        } else drawShape(ctx, shape, x, y, s / 2)
        if (o.text) {
          ctx.fillStyle = col(o.textcolor, color)
          ctx.font = '10px system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = /Below/i.test(loc) ? 'top' : 'bottom'
          ctx.fillText(o.text, x, /Below/i.test(loc) ? y + s : y - s)
        }
      }
    }
    if (this.overlay !== r.overlay) return
    // линии (line.new)
    for (const l of r.lines) {
      let x1 = this.px(l.x1, l.xloc)
      let y1 = this.y(l.y1)
      let x2 = this.px(l.x2, l.xloc)
      let y2 = this.y(l.y2)
      if ([x1, y1, x2, y2].some((v) => v == null)) continue
      const ext = l.extend || 'none'
      const k = x2 !== x1 ? (y2 - y1) / (x2 - x1) : 0
      if (ext === 'r' || ext === 'right' || ext === 'b' || ext === 'both') {
        if (x2 !== x1) {
          y2 = y2 + k * (size.width * 2 - x2)
          x2 = size.width * 2
        }
      }
      if (ext === 'l' || ext === 'left' || ext === 'b' || ext === 'both') {
        if (x2 !== x1) {
          y1 = y1 - k * (x1 + size.width)
          x1 = -size.width
        }
      }
      ctx.strokeStyle = col(l.color)
      ctx.lineWidth = l.width || 1
      dash(ctx, l.style)
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      ctx.setLineDash([])
    }
    // ломаные (polyline)
    for (const pl of r.polylines) {
      const pts = (pl.points || []).map((pt) => [pt.xloc === 'bt' || pl.xloc === 'bt' ? this.x((pt.time ?? pt.x) / 1000) : this.barX(pt.index ?? pt.x), this.y(pt.price ?? pt.y)])
      if (pts.length < 2 || pts.some(([a, b]) => a == null || b == null)) continue
      ctx.beginPath()
      pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b)))
      if (pl.closed) ctx.closePath()
      if (pl.fill_color) {
        ctx.fillStyle = pl.fill_color
        ctx.fill()
      }
      ctx.strokeStyle = col(pl.line_color)
      ctx.lineWidth = pl.line_width || 1
      dash(ctx, pl.line_style)
      ctx.stroke()
      ctx.setLineDash([])
    }
    // метки (label.new)
    for (const lb of r.labels) {
      const x = this.px(lb.x, lb.xloc)
      let y
      const bar = lb.xloc === 'bt' ? bars[idx.get(lb.x / 1000)] : bars[Math.round(lb.x)]
      if (lb.yloc === 'ab' || lb.yloc === 'abovebar') y = bar ? this.y(bar.high) : null
      else if (lb.yloc === 'bl' || lb.yloc === 'belowbar') y = bar ? this.y(bar.low) : null
      else y = this.y(lb.y)
      if (x == null || y == null) continue
      drawLabel(ctx, lb, x, y)
    }
  }
}

function drawShape(ctx, shape, x, y, r) {
  ctx.beginPath()
  switch (shape) {
    case 'shape_triangle_up':
    case 'shape_arrow_up':
      ctx.moveTo(x, y - r)
      ctx.lineTo(x + r, y + r)
      ctx.lineTo(x - r, y + r)
      ctx.closePath()
      ctx.fill()
      if (shape === 'shape_arrow_up') ctx.fillRect(x - r / 3, y + r, (r * 2) / 3, r)
      return
    case 'shape_triangle_down':
    case 'shape_arrow_down':
      ctx.moveTo(x, y + r)
      ctx.lineTo(x + r, y - r)
      ctx.lineTo(x - r, y - r)
      ctx.closePath()
      ctx.fill()
      if (shape === 'shape_arrow_down') ctx.fillRect(x - r / 3, y - 2 * r, (r * 2) / 3, r)
      return
    case 'shape_square':
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r)
      return
    case 'shape_diamond':
      ctx.moveTo(x, y - r)
      ctx.lineTo(x + r, y)
      ctx.lineTo(x, y + r)
      ctx.lineTo(x - r, y)
      ctx.closePath()
      ctx.fill()
      return
    case 'shape_cross':
    case 'shape_xcross': {
      ctx.lineWidth = 2
      const d = shape === 'shape_cross' ? [[x - r, y, x + r, y], [x, y - r, x, y + r]] : [[x - r, y - r, x + r, y + r], [x - r, y + r, x + r, y - r]]
      for (const [a, b, c, e] of d) {
        ctx.moveTo(a, b)
        ctx.lineTo(c, e)
      }
      ctx.stroke()
      return
    }
    case 'shape_flag':
      ctx.fillRect(x - r, y - r, 1.5, 2 * r)
      ctx.fillRect(x - r, y - r, 2 * r, r)
      return
    case 'shape_label_up':
    case 'shape_label_down':
      ctx.fillRect(x - r * 1.4, y - r, r * 2.8, r * 2)
      return
    default: // круг
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
  }
}

function drawLabel(ctx, lb, x, y) {
  const fs = TEXT[lb.size] || 12
  ctx.font = `${fs}px system-ui, sans-serif`
  const lines = String(lb.text ?? '').split('\n')
  const tw = Math.max(0, ...lines.map((s) => ctx.measureText(s).width))
  const w = tw + 12
  const h = lines.length * (fs + 3) + 6
  const style = lb.style || 'style_label_down'
  const bg = col(lb.color)
  const tc = col(lb.textcolor, '#fff')
  const none = /none|text_outline/.test(style) || lb.color === 'transparent'
  let bx = x - w / 2
  let by = y - h - 6
  if (/label_up/.test(style)) by = y + 6
  else if (/label_left/.test(style)) {
    bx = x + 6
    by = y - h / 2
  } else if (/label_right/.test(style)) {
    bx = x - w - 6
    by = y - h / 2
  } else if (/label_center|none/.test(style)) by = y - h / 2
  if (/circle|square|diamond|triangle|cross|arrow|flag/.test(style) && !/label_/.test(style)) {
    ctx.fillStyle = bg
    drawShape(ctx, 'shape_' + style.replace('style_', ''), x, y, 6)
    if (lb.text) {
      ctx.fillStyle = tc === '#fff' ? bg : tc
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText(lb.text, x, y - 8)
    }
    return
  }
  if (!none) {
    ctx.fillStyle = bg
    ctx.beginPath()
    ctx.roundRect ? ctx.roundRect(bx, by, w, h, 3) : ctx.rect(bx, by, w, h)
    ctx.fill()
    // носик
    ctx.beginPath()
    if (/label_down/.test(style)) {
      ctx.moveTo(x - 5, by + h)
      ctx.lineTo(x, y)
      ctx.lineTo(x + 5, by + h)
    } else if (/label_up/.test(style)) {
      ctx.moveTo(x - 5, by)
      ctx.lineTo(x, y)
      ctx.lineTo(x + 5, by)
    } else if (/label_left/.test(style)) {
      ctx.moveTo(bx, y - 5)
      ctx.lineTo(x, y)
      ctx.lineTo(bx, y + 5)
    } else if (/label_right/.test(style)) {
      ctx.moveTo(bx + w, y - 5)
      ctx.lineTo(x, y)
      ctx.lineTo(bx + w, y + 5)
    }
    ctx.fill()
  }
  ctx.fillStyle = none ? col(lb.textcolor, bg) : tc
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  lines.forEach((s, i) => ctx.fillText(s, bx + w / 2, by + 4 + i * (fs + 3)))
}

// ---------- Таблицы (table.new) — HTML поверх графика ----------
const POS = {
  top_left: 'top:4px;left:8px', top_center: 'top:4px;left:50%;transform:translateX(-50%)', top_right: 'top:4px;right:74px',
  middle_left: 'top:50%;left:8px;transform:translateY(-50%)', middle_center: 'top:50%;left:50%;transform:translate(-50%,-50%)', middle_right: 'top:50%;right:74px;transform:translateY(-50%)',
  bottom_left: 'bottom:6px;left:8px', bottom_center: 'bottom:6px;left:50%;transform:translateX(-50%)', bottom_right: 'bottom:6px;right:74px',
}
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
function tableHtml(t) {
  const rows = []
  for (let r = 0; r < (t.rows || 0); r++) {
    const cells = []
    for (let c = 0; c < (t.columns || 0); c++) {
      const cell = t.cells?.[r]?.[c] ?? t.cells?.[c]?.[r]
      if (!cell) {
        cells.push('<td></td>')
        continue
      }
      const st = [
        cell.bgcolor ? `background:${cell.bgcolor}` : '',
        `color:${col(cell.text_color, '#000')}`,
        `font-size:${TEXT[cell.text_size] || 11}px`,
        `text-align:${cell.text_halign === 'left' ? 'left' : cell.text_halign === 'right' ? 'right' : 'center'}`,
        t.border_width ? `border:${t.border_width}px solid ${col(t.border_color, '#555')}` : '',
      ].join(';')
      cells.push(`<td style="${st}" title="${esc(cell.tooltip)}">${esc(cell.text).replace(/\n/g, '<br>')}</td>`)
    }
    rows.push(`<tr>${cells.join('')}</tr>`)
  }
  const frame = t.frame_width ? `border:${t.frame_width}px solid ${col(t.frame_color, '#555')};` : ''
  return `<div class="pine-table" style="${POS[t.position] || POS.top_right};${t.bgcolor ? `background:${t.bgcolor};` : ''}${frame}"><table>${rows.join('')}</table></div>`
}

// ---------- Один индикатор в одном окне ----------
export class PineRun {
  constructor(pane, ind, paneIndex, overlay) {
    this.pane = pane
    this.ind = ind
    this.paneIndex = paneIndex // 0 — на графике, иначе своя панель под ним
    this.overlayGuess = overlay
    this.series = new Map() // ключ plot → { series, kind, values: Map(time → value) }
    this.hosts = {} // невидимые серии, на которых живёт слой рисования
    this.layers = []
    this.result = null
    this.error = ''
    this.timeIndex = new Map()
    this.tablesEl = document.createElement('div')
    this.tablesEl.className = 'pine-tables'
    pane.el.append(this.tablesEl)
    this.dead = false
    if (!overlay) this.host(false) // сразу занимаем свою панель, чтобы панели шли по порядку
    this.schedule(0)
  }

  // пересчёт не чаще раза в 1,5 секунды (на каждой сделке — слишком часто)
  schedule(delay = 1500) {
    if (this.dead) return
    if (this.timer) return
    if (delay) delay = Math.max(delay, this.minGap || 0)
    this.timer = setTimeout(() => {
      this.timer = 0
      this.compute()
    }, delay)
  }

  // Расчёт идёт в отдельном потоке (Web Worker): тяжёлый скрипт не подвешивает графики
  compute() {
    if (this.dead || !this.pane.bars.length) return
    if (this.busy) return this.schedule()
    this.busy = true
    this.started = performance.now()
    if (!this.worker) {
      this.worker = new Worker(new URL('./pineWorker.js', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e) => this.onResult(e.data)
      this.worker.onerror = (e) => this.onResult({ error: e.message || 'ошибка в потоке расчёта' })
    }
    const p = this.pane
    this.sentBars = p.bars
    this.worker.postMessage({
      code: this.ind.code,
      inputs: this.ind.inputs || {},
      bars: p.bars,
      symbol: p.symbol,
      market: p.market,
      interval: TO_PINE[p.interval],
      sec: p.intervalSec,
      decimals: p.decimals,
    })
  }

  onResult(msg) {
    this.busy = false
    if (this.dead) return
    // следующий пересчёт — не раньше, чем через 3 длительности расчёта (минимум 1,5 с)
    this.minGap = Math.max(1500, 3 * (performance.now() - this.started))
    if (msg.error) {
      this.error = String(msg.error).split('\n')[0].slice(0, 200)
      this.pane.showIndicatorLegend?.(this.pane.bars.length - 1)
      return
    }
    this.error = ''
    if (this.sentBars !== this.pane.bars) return this.schedule(0) // пока считали, сменилась монета или ТФ
    this.apply(msg)
  }

  apply(ctx) {
    const overlay = ctx.indicator?.overlay !== false
    this.overlay = overlay
    this.title = ctx.indicator?.shorttitle || ctx.indicator?.title || this.ind.name
    const r = { overlay, plots: [], shapes: [], backgrounds: [], fills: [], hlines: [], candles: [], byTitle: new Map(), labels: [], lines: [], boxes: [], linefills: [], polylines: [], tables: [] }
    const live = (k) => (ctx.plots[k]?.data?.at(-1)?.value || []).filter((o) => !o._deleted)
    r.labels = live('__labels__')
    r.lines = live('__lines__')
    r.boxes = live('__boxes__')
    r.linefills = live('__linefills__')
    r.polylines = live('__polylines__')
    r.tables = live('__tables__')
    for (const [key, p] of Object.entries(ctx.plots)) {
      if (key.startsWith('__')) continue
      const o = p.options || {}
      const pOverlay = o.force_overlay ? true : o.overlay ?? overlay
      const item = { key, title: p.title || key, options: o, data: p.data || [], overlay: pOverlay }
      r.byTitle.set(item.title, item)
      r.byTitle.set(key, item)
      if (o.display === 'none' || o.display === 'display.none') continue
      const st = String(o.style || 'line')
      if (st === 'shape' || st === 'char' || st === 'arrow' || key.startsWith('plotarrow')) r.shapes.push({ ...item, isChar: st === 'char', isArrow: key.startsWith('plotarrow') })
      else if (st === 'background') r.backgrounds.push(item)
      else if (st === 'fill') r.fills.push(item)
      else if (st === 'hline') r.hlines.push(item)
      else if (st === 'candle' || st === 'bar') r.candles.push(item)
      else if (st === 'barcolor') continue // перекраска свечей пока не поддерживается
      else r.plots.push(item)
    }
    this.result = r
    this.timeIndex = new Map(this.pane.bars.map((b, i) => [b.time, i]))
    this.render()
  }

  // ---------- Серии на графике ----------
  host(onOverlay) {
    const key = onOverlay ? 'main' : 'sub'
    if (this.hosts[key]) return this.hosts[key]
    const s = this.pane.chart.addSeries(LineSeries, {
      color: 'rgba(0,0,0,0)', lineVisible: false, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      pointMarkersVisible: false,
    }, onOverlay ? 0 : this.paneIndex)
    const layer = new PineLayer(this, onOverlay)
    s.attachPrimitive(layer)
    this.layers.push(layer)
    this.hosts[key] = s
    return s
  }

  render() {
    const r = this.result
    const chart = this.pane.chart
    const precision = this.pane.decimals
    const fmtOpts = { priceFormat: { type: 'price', precision, minMove: 10 ** -precision } }
    const used = new Set()
    const toTime = (d) => d.time / 1000
    const good = (v) => typeof v === 'number' && Number.isFinite(v)
    for (const p of r.plots) {
      const st = String(p.options.style || 'line')
      const kind = /histogram|columns/.test(st) ? 'hist' : /area/.test(st) ? 'area' : /circles|cross/.test(st) ? 'dots' : /step/.test(st) ? 'step' : 'line'
      let e = this.series.get(p.key)
      if (e && e.kind !== kind) {
        chart.removeSeries(e.series)
        e = null
      }
      const color = col(p.options.color)
      if (!e) {
        const pi = p.overlay ? 0 : this.paneIndex
        const base = { priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, title: '', ...fmtOpts }
        let s
        if (kind === 'hist') s = chart.addSeries(HistogramSeries, { ...base, color, base: p.options.histbase ?? 0 }, pi)
        else if (kind === 'area') s = chart.addSeries(AreaSeries, { ...base, lineColor: color, topColor: color + '55', bottomColor: color + '08', lineWidth: p.options.linewidth || 1 }, pi)
        else s = chart.addSeries(LineSeries, {
          ...base, color, lineWidth: Math.min(4, p.options.linewidth || 1),
          lineType: kind === 'step' ? 1 : 0, lineVisible: kind !== 'dots', pointMarkersVisible: kind === 'dots', pointMarkersRadius: 2,
        }, pi)
        e = { series: s, kind }
        this.series.set(p.key, e)
      }
      used.add(p.key)
      e.values = new Map()
      const data = p.data.map((d) => {
        const v = d.value
        if (!good(v)) return { time: toTime(d) }
        e.values.set(toTime(d), v)
        const c = d.options?.color
        if (c === null) return { time: toTime(d) } // цвет na — точку не рисуем
        return c ? (kind === 'area' ? { time: toTime(d), value: v } : { time: toTime(d), value: v, color: c }) : { time: toTime(d), value: v }
      })
      e.series.setData(dedupe(data))
      e.color = color
      e.title = p.title
      e.overlay = p.overlay
    }
    // свечи из plotcandle
    for (const p of r.candles) {
      let e = this.series.get(p.key)
      if (!e) {
        e = { series: chart.addSeries(CandlestickSeries, { ...fmtOpts, priceLineVisible: false, lastValueVisible: false }, p.overlay ? 0 : this.paneIndex), kind: 'candle' }
        this.series.set(p.key, e)
      }
      used.add(p.key)
      e.values = new Map()
      e.series.setData(dedupe(p.data.map((d) => (Array.isArray(d.value) && d.value.every(good) ? { time: toTime(d), open: d.value[0], high: d.value[1], low: d.value[2], close: d.value[3] } : { time: toTime(d) }))))
    }
    for (const [k, e] of this.series) {
      if (!used.has(k)) {
        chart.removeSeries(e.series)
        this.series.delete(k)
      }
    }
    // невидимые «носители» слоя рисования: на главной панели — по ценам свечей, внизу — по первой линии
    const needMain = r.overlay || r.shapes.some((s) => s.overlay) || r.backgrounds.some((s) => s.overlay) || r.fills.some((s) => s.overlay) || r.hlines.some((s) => s.overlay)
    const needSub = !r.overlay
    const bars = this.pane.bars
    if (needMain) this.host(true).setData(bars.map((b) => ({ time: b.time, value: b.close })))
    if (needSub) {
      const first = [...this.series.values()].find((e) => !e.overlay && e.values?.size)
      const hlv = r.hlines.filter((h) => !h.overlay).map((h) => h.data.at(-1)?.value).filter(good)
      this.host(false).setData(bars.map((b) => ({ time: b.time, value: first?.values.get(b.time) ?? hlv[0] ?? 0 })))
    }
    // горизонтальные уровни (hline)
    for (const [k, h] of Object.entries(this.hosts)) for (const pl of h._pinePriceLines || []) h.removePriceLine(pl)
    for (const h of r.hlines) {
      const host = this.host(h.overlay)
      const v = h.data.at(-1)?.value
      if (!good(v)) continue
      const ls = h.options.linestyle || 'dashed'
      host._pinePriceLines = host._pinePriceLines || []
      host._pinePriceLines.push(host.createPriceLine({ price: v, color: col(h.options.color, '#787b86'), lineWidth: h.options.linewidth || 1, lineStyle: ls === 'solid' ? 0 : ls === 'dotted' ? 1 : 2, axisLabelVisible: false, title: '' }))
    }
    // таблицы — поверх главной панели (если индикатор «на графике») или своей панели
    const heights = chart.panes().map((p) => p.getHeight())
    const pi = r.overlay ? 0 : this.paneIndex
    const head = this.pane.el.querySelector('.pane-head')?.offsetHeight || 0
    this.tablesEl.style.top = head + heights.slice(0, pi).reduce((a, b) => a + b + 1, 0) + 'px'
    this.tablesEl.style.height = (heights[pi] || 0) + 'px'
    this.tablesEl.innerHTML = r.tables.map(tableHtml).join('')
    for (const l of this.layers) l.req?.()
    this.pane.fixPaneHeights?.()
    this.pane.showIndicatorLegend?.(this.pane.bars.length - 1)
  }

  // Подпись в легенде: название и значения линий на свече i
  legend(i) {
    const t = this.pane.bars[i]?.time
    const vals = this.error
      ? `<i style="color:#f23645">ошибка: ${esc(this.error)}</i>`
      : [...this.series.values()]
          .filter((e) => e.values && e.title !== undefined)
          .slice(0, 6)
          .map((e) => {
            const v = e.values.get(t)
            return v == null ? '' : `<i style="color:${e.color}">${formatNum(v, this.pane.decimals)}</i>`
          })
          .join(' ')
    return `<span style="color:#e0a800">${esc(this.title || this.ind.name)}</span> ${vals}`
  }

  destroy() {
    this.dead = true
    clearTimeout(this.timer)
    this.worker?.terminate()
    for (const e of this.series.values()) {
      try {
        this.pane.chart.removeSeries(e.series)
      } catch {}
    }
    for (const h of Object.values(this.hosts)) {
      try {
        this.pane.chart.removeSeries(h)
      } catch {}
    }
    this.series.clear()
    this.tablesEl.remove()
  }
}

function dedupe(data) {
  const out = []
  for (const d of data) {
    if (out.length && out.at(-1).time === d.time) out[out.length - 1] = d
    else if (!out.length || d.time > out.at(-1).time) out.push(d)
  }
  return out
}
function formatNum(v, d) {
  const a = Math.abs(v)
  const digits = a >= 1000 ? 2 : a >= 1 ? Math.min(4, Math.max(2, d)) : Math.max(4, d)
  return v.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}
