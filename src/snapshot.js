// Снимки графиков в высоком разрешении.
//
// Как это сделано: обычный снимок графика получается размером с экран. Чтобы картинка
// была чётче, мы на долю секунды создаём невидимую копию графика в несколько раз больше
// (с крупнее шрифтом и свечами), показываем в ней те же свечи и тот же участок истории
// и фотографируем уже её. Потом копию удаляем.
import { createChart, HistogramSeries } from 'lightweight-charts'
import { fmt } from './pane.js'
import { makeAdapter, DrawingsPrimitive } from './drawings.js'
import { marketLabel } from './markets.js'
import { DayLinesPrimitive } from './dayLines.js'

const BG = '#0e1116'
const BORDER = '#262b36'
const UP = '#26a69a'
const DOWN = '#ef5350'
const MUTED = '#787b86'
const TEXT = '#d1d4dc'

// Подождать, пока браузер нарисует кадр
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

/** Снимок одного окна. scale — во сколько раз больше экранного размера. Возвращает canvas. */
export async function renderPane(pane, scale) {
  const rect = pane.el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const k = scale / dpr // во сколько раз увеличить копию (браузер сам умножит ещё на dpr)
  const width = Math.round(rect.width * k)
  const height = Math.round(rect.height * k)

  // Невидимый контейнер за краем экрана
  const box = document.createElement('div')
  Object.assign(box.style, { position: 'fixed', left: '-100000px', top: '0', width: width + 'px', height: height + 'px' })
  document.body.append(box)

  const opts = pane.chart.options()
  const hidden = { visible: false, labelVisible: false }
  const copy = createChart(box, {
    ...opts,
    autoSize: false,
    width,
    height,
    layout: { ...opts.layout, fontSize: opts.layout.fontSize * k },
    crosshair: { ...opts.crosshair, vertLine: { ...opts.crosshair.vertLine, ...hidden }, horzLine: { ...opts.crosshair.horzLine, ...hidden } },
  })

  try {
    const candles = copy.addSeries(pane.seriesCtor, pane.candles.options())
    const volume = copy.addSeries(HistogramSeries, pane.volume.options())
    copy.priceScale('volume').applyOptions(pane.chart.priceScale('volume').options())
    candles.priceScale().applyOptions(pane.candles.priceScale().options())
    candles.setData(pane.candles.data())
    // рисунки тоже попадают на снимок (без точек выделения)
    const adapter = makeAdapter(copy, () => candles, () => pane.bars, () => pane.intervalSec)
    candles.attachPrimitive(new DrawingsPrimitive(adapter, () => pane.key, false, k))
    candles.attachPrimitive(new DayLinesPrimitive(copy, () => pane.bars, () => pane.intervalSec, k))
    volume.setData(pane.volume.data())

    // индикаторы: те же линии в тех же панелях, той же высоты
    for (const e of pane.indSeries) {
      for (const l of e.lines) {
        const s2 = copy.addSeries(l.ctor, l.series.options(), e.paneIndex)
        s2.setData(l.series.data())
        for (const level of e.def.levels || []) {
          if (l === e.lines[0]) s2.createPriceLine({ price: level, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false })
        }
      }
    }
    const origPanes = pane.chart.panes()
    copy.panes().forEach((p, i) => origPanes[i] && p.setStretchFactor(origPanes[i].getHeight()))

    // Тот же участок истории…
    const range = pane.chart.timeScale().getVisibleLogicalRange()
    if (range) copy.timeScale().setVisibleLogicalRange(range)
    // …и тот же диапазон цен, если его меняли руками
    const priceRange = pane.candles.priceScale().getVisibleRange()
    if (priceRange && !pane.candles.priceScale().options().autoScale) {
      candles.priceScale().setVisibleRange(priceRange)
    }

    await nextFrame()
    const canvas = copy.takeScreenshot(true, false)
    drawLegend(canvas, pane, scale)
    drawIndicatorLegend(canvas, pane, scale, copy)
    drawTATable(canvas, pane, scale, copy)
    return canvas
  } finally {
    copy.remove()
    box.remove()
  }
}

// Надпись в левом верхнем углу: монета, интервал, рынок, цены последней свечи
function drawLegend(canvas, pane, scale) {
  const ctx = canvas.getContext('2d')
  const bar = pane.bars.at(-1)
  const size = 13 * scale
  let x = 10 * scale
  const y = 10 * scale + size
  ctx.textBaseline = 'alphabetic'
  const font = (bold) => `${bold ? '600 ' : ''}${size}px -apple-system, "Segoe UI", Roboto, sans-serif`
  const put = (text, color, bold = false, gapAfter = 8) => {
    ctx.font = font(bold)
    ctx.fillStyle = color
    ctx.fillText(text, x, y)
    x += ctx.measureText(text).width + gapAfter * scale
  }

  put(pane.symbol, TEXT, true)
  put(pane.intervalLabel, '#2962ff', true)
  put(marketLabel(pane.market), MUTED, false, 14)
  if (bar) {
    const c = bar.close >= bar.open ? UP : DOWN
    for (const [label, value] of [['О', bar.open], ['М', bar.high], ['Н', bar.low], ['З', bar.close]]) {
      put(label, MUTED, false, 4)
      put(fmt(value, pane.decimals), c, false, 10)
    }
  }
}

// Подписи индикаторов: те, что на свечах, — строками под заголовком, остальные — в своих панелях
function drawIndicatorLegend(canvas, pane, scale, copy) {
  const items = pane.legendItems()
  if (!items.length) return
  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const k = scale / dpr
  const heights = copy.panes().map((p) => p.getHeight() * dpr) // высоты в пикселях картинки
  const size = 12 * scale
  ctx.font = `${size}px -apple-system, "Segoe UI", Roboto, sans-serif`
  ctx.textBaseline = 'top'
  let row = 0
  for (const item of items) {
    let y
    if (item.paneIndex === 0) y = (34 + row++ * 17) * scale
    else y = heights.slice(0, item.paneIndex).reduce((a, b) => a + b, 0) + (item.paneIndex + 4) * k * dpr
    let x = 10 * scale
    for (const part of item.parts) {
      ctx.fillStyle = part.color
      ctx.fillText(part.text, x, y)
      x += ctx.measureText(part.text).width + 6 * scale
    }
  }
}

// Таблица Trader Assistant — в левом нижнем углу панели со свечами, как на экране
function drawTATable(canvas, pane, scale, copy) {
  const table = pane.taTables?.find((t) => t.visible)
  const rows = table?.rows()
  if (!rows) return
  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const base = (12 + 2 * (+table.ind.params.font || 0)) * scale
  const font = (r) => `${r.big ? '600 ' : ''}${r.big ? base * 1.08 : base}px -apple-system, "Segoe UI", Roboto, sans-serif`
  const pad = 6 * scale
  const rowH = base * 1.55
  // ширина столбцов — по самому длинному тексту
  const widths = [0, 0, 0]
  for (const r of rows) {
    ctx.font = font(r)
    r.cells.forEach((c, i) => (widths[i] = Math.max(widths[i], ctx.measureText(c).width)))
  }
  const w = widths.reduce((a, b) => a + b, 0) + pad * 6
  const h = rows.length * rowH + pad
  const mainH = copy.panes()[0].getHeight() * dpr
  const x0 = 0
  const y0 = mainH - h - 8 * scale
  ctx.fillStyle = 'rgba(22, 26, 34, 0.88)'
  ctx.fillRect(x0, y0, w, h)
  ctx.strokeStyle = '#262b36'
  ctx.lineWidth = scale
  ctx.strokeRect(x0, y0, w, h)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'right'
  rows.forEach((r, n) => {
    ctx.font = font(r)
    let x = x0 + pad
    const y = y0 + pad / 2 + rowH * (n + 0.5)
    r.cells.forEach((c, i) => {
      x += widths[i] + pad * 2
      ctx.fillStyle = r.colors[i]
      ctx.fillText(c, x - pad, y)
    })
  })
  ctx.textAlign = 'left'
}

/** Снимок всех окон одной картинкой — окна стоят так же, как на экране */
export async function renderAll(panes, grid, scale) {
  const g = grid.getBoundingClientRect()
  const out = document.createElement('canvas')
  out.width = Math.round(g.width * scale)
  out.height = Math.round(g.height * scale)
  const ctx = out.getContext('2d')
  ctx.fillStyle = BORDER // цвет щелей между окнами
  ctx.fillRect(0, 0, out.width, out.height)

  for (const pane of panes) {
    const r = pane.el.getBoundingClientRect()
    const img = await renderPane(pane, scale)
    ctx.fillStyle = BG
    const x = Math.round((r.left - g.left) * scale)
    const y = Math.round((r.top - g.top) * scale)
    const w = Math.round(r.width * scale)
    const h = Math.round(r.height * scale)
    ctx.fillRect(x, y, w, h)
    ctx.drawImage(img, x, y, w, h)
  }
  return out
}

// ---------- Сохранить / скопировать ----------

const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))

/** Скачать картинку PNG-файлом */
export async function download(canvas, name) {
  const blob = await toBlob(canvas)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name + '.png'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** Скопировать картинку в буфер обмена (потом Ctrl+V в Telegram, Paint и т.д.) */
export async function copyToClipboard(canvas) {
  if (!navigator.clipboard || !window.ClipboardItem) throw new Error('браузер не умеет копировать картинки')
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob(canvas) })])
}

/** Имя файла: BTCUSDT_1ч_2026-11-14_12-45 */
export function fileName(prefix) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${prefix}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`
}
