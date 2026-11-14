// Одно окно графика. Каждое окно — отдельный график со своей монетой, интервалом
// и своим соединением с биржей. Окна ничего не знают друг о друге: о событиях
// (наведение мыши, прокрутка) они сообщают главному файлу, а тот синхронизирует остальные.
import {
  createChart, CandlestickSeries, BarSeries, LineSeries, AreaSeries, HistogramSeries, CrosshairMode,
} from 'lightweight-charts'
export { LineSeries, HistogramSeries }
import { loadCandles, subscribeLive } from './binance.js'
import { isDelayed } from './markets.js'
import { draw, makeAdapter, DrawingsPrimitive, DrawingController } from './drawings.js'
import { INDICATORS, indicatorLabel } from './indicators.js'
import { TATable } from './traderAssistant.js'
import { DayLinesPrimitive } from './dayLines.js'
import { CountdownPrimitive } from './countdown.js'
import { tickMarkFormatter, crosshairTime } from './localTime.js'
import { style, withAlpha, LINE_STYLE } from './chartSettings.js'
import { paper } from './paper.js'

// Интервалы: подпись → код у Binance → длина в секундах
export const INTERVALS = [
  { label: '1м', code: '1m', sec: 60 },
  { label: '5м', code: '5m', sec: 300 },
  { label: '15м', code: '15m', sec: 900 },
  { label: '30м', code: '30m', sec: 1800 },
  { label: '1ч', code: '1h', sec: 3600 },
  { label: '4ч', code: '4h', sec: 14400 },
  { label: '1Д', code: '1d', sec: 86400 },
  { label: '1Н', code: '1w', sec: 604800 },
]
const intervalInfo = (code) => INTERVALS.find((i) => i.code === code) || INTERVALS[4]

const UP = '#26a69a'
const DOWN = '#ef5350'

function dataDecimals(bars) {
  let d = 0
  for (const b of bars.slice(-200))
    for (const v of [b.open, b.high, b.low, b.close]) {
      const s = String(+v.toFixed(6))
      const i = s.indexOf('.')
      if (i >= 0) d = Math.max(d, s.length - i - 1)
    }
  return d
}
function decimalsFor(price) {
  if (price >= 1000) return 2
  if (price >= 1) return 4
  if (price >= 0.01) return 6
  return 8
}
export const fmt = (n, d) =>
  n.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d })

// Типы графика. series — какой «вид серии» библиотеки использовать, options — его настройки,
// point — как превратить нашу свечу в точку этого графика
const ohlc = (b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })
const closeOnly = (b) => ({ time: b.time, value: b.close })
// options(st) — настройки серии с учётом цветов из «Настроек графика»
const candleOptions = (st, hollow) => ({
  upColor: hollow ? 'rgba(0,0,0,0)' : st.bodyUp,
  downColor: st.bodyDown,
  borderVisible: hollow || st.border,
  borderUpColor: hollow && !st.border ? st.bodyUp : st.borderUp,
  borderDownColor: hollow && !st.border ? st.bodyDown : st.borderDown,
  wickVisible: st.wick,
  wickUpColor: st.wickUp,
  wickDownColor: st.wickDown,
})
export const CHART_TYPES = [
  { code: 'candles', label: 'Свечи', series: CandlestickSeries, point: ohlc, options: (st) => candleOptions(st, false) },
  {
    code: 'bars', label: 'Бары', series: BarSeries, point: ohlc,
    options: (st) => ({ upColor: st.bodyUp, downColor: st.bodyDown, openVisible: true, thinBars: false }),
  },
  { code: 'hollow', label: 'Пустые свечи', series: CandlestickSeries, point: ohlc, options: (st) => candleOptions(st, true) },
  { code: 'line', label: 'Линия', series: LineSeries, point: closeOnly, options: (st) => ({ color: st.lineColor, lineWidth: 2 }) },
  {
    code: 'area', label: 'Область', series: AreaSeries, point: closeOnly,
    options: (st) => ({ lineColor: st.lineColor, topColor: withAlpha(st.lineColor, 40), bottomColor: withAlpha(st.lineColor, 2), lineWidth: 2 }),
  },
]
const chartTypeInfo = (code) => CHART_TYPES.find((t) => t.code === code) || CHART_TYPES[0]

const volumeBar = (b) => ({
  time: b.time,
  value: b.volume,
  color: withAlpha(b.close >= b.open ? style.bodyUp : style.bodyDown, style.volumeOpacity),
})

export class Pane {
  /**
   * settings — { market, symbol, interval }
   * hooks — функции, которые окно вызывает, когда что-то происходит:
   *   onActivate(pane)            — по окну щёлкнули
   *   onCrosshair(pane, time, price) — мышь двигается по графику (time = null — мышь ушла)
   *   onScroll(pane)              — пользователь прокрутил или масштабировал график
   *   onPrice(pane, price)        — пришла новая цена
   *   onIntervalChange(pane)      — в окне выбрали другой интервал
   */
  constructor(settings, hooks) {
    this.market = settings.market
    this.symbol = settings.symbol
    this.interval = settings.interval
    this.chartType = chartTypeInfo(settings.chartType).code
    this.indicators = settings.indicators || [] // список индикаторов (общий для всех окон)
    this.showVolume = settings.volume !== false // столбики объёма внизу графика
    this.taTables = [] // таблицы Trader Assistant
    this.indSeries = [] // нарисованные индикаторы: { ind, def, paneIndex, lines: [{ key, series, ctor, values }] }
    this.hooks = hooks
    this.bars = []
    this.decimals = 2
    this.hovered = false // мышь сейчас над этим окном
    this.loadId = 0
    this.loadingMore = false
    this.noMoreHistory = false
    this.unsubscribe = null
    this.lastTradeTime = 0 // время последней сделки, которую мы показали
    this.dirtyFrom = -1 // с какой свечи есть непоказанные изменения (-1 — нет)
    this.frame = 0
    this.legendLive = true // легенда показывает последнюю свечу (мышь не над графиком)

    this.buildDom()
    this.buildChart()
    this.drawCtl = new DrawingController(this) // мышь для рисования
    // окно поменяло размер (или панели индикаторов) — подписи индикаторов на новые места
    this.resizeObs = new ResizeObserver(() => this.refreshLegend())
    this.resizeObs.observe(this.chartEl)
    this.offDraw = draw.subscribe(() => this.drawPrim?.requestUpdate()) // рисунки изменились — перерисовать
    // демо-счёт: позиции и ордера — линиями на графике
    this.paperLines = new Map() // id → { line, priceLine }
    this.offPaper = paper.subscribe((kind) => (kind === 'change' ? this.syncPaperLines() : this.schedulePaperTitles()))
    this.syncPaperLines()
    this.load()
  }

  // Ключ монеты: по нему хранятся рисунки (одни и те же во всех окнах с этой монетой)
  get key() {
    return `${this.market}:${this.symbol}`
  }

  // ---------- Разметка окна ----------
  buildDom() {
    this.el = document.createElement('div')
    this.el.className = 'pane'
    this.el.innerHTML = `
      <div class="pane-head">
        <span class="pane-drag" draggable="true" title="Перетащите на другое окно, чтобы поменять их местами">⠿</span>
        <b class="pane-symbol"></b>
        <select class="pane-interval">
          ${INTERVALS.map((i) => `<option value="${i.code}">${i.label}</option>`).join('')}
        </select>
        <span class="pane-delay" title="Московская биржа бесплатно даёт данные с задержкой 15 минут. Без задержки — только по платной подписке биржи.">⏱ задержка 15 мин</span>
        <span class="pane-ohlc"></span>
      </div>
      <div class="pane-chart"></div>
      <div class="pane-legends"></div>
      <div class="pane-status"></div>`

    this.symbolEl = this.el.querySelector('.pane-symbol')
    this.ohlcEl = this.el.querySelector('.pane-ohlc')
    this.legendsEl = this.el.querySelector('.pane-legends')
    this.statusEl = this.el.querySelector('.pane-status')
    this.intervalSelect = this.el.querySelector('.pane-interval')
    this.intervalSelect.value = this.interval
    this.intervalSelect.onchange = () => {
      this.setInterval(this.intervalSelect.value)
      this.hooks.onIntervalChange(this)
    }

    // Запоминаем, над каким окном мышь: синхронизацию запускает только оно,
    // иначе окна начали бы бесконечно двигать друг друга
    this.el.addEventListener('pointerenter', () => {
      this.hovered = true
      this.setVertLine(true) // в своём окне перекрестие всегда полное
    })
    this.el.addEventListener('pointerleave', () => (this.hovered = false))
    // Перетаскивание окна за значок ⠿
    const handle = this.el.querySelector('.pane-drag')
    handle.addEventListener('dragstart', (e) => {
      Pane.dragged = this
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', '')
      e.dataTransfer.setDragImage(this.el, 20, 20)
      this.el.classList.add('dragging')
    })
    handle.addEventListener('dragend', () => {
      Pane.dragged = null
      this.el.classList.remove('dragging')
      for (const el of document.querySelectorAll('.drop-target')) el.classList.remove('drop-target')
    })
    this.el.addEventListener('dragover', (e) => {
      if (!Pane.dragged || Pane.dragged === this) return
      e.preventDefault() // разрешаем «бросить» сюда
      this.el.classList.add('drop-target')
    })
    this.el.addEventListener('dragleave', (e) => {
      if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('drop-target')
    })
    this.el.addEventListener('drop', (e) => {
      e.preventDefault()
      this.el.classList.remove('drop-target')
      if (Pane.dragged && Pane.dragged !== this) this.hooks.onSwap(Pane.dragged, this)
    })

    this.el.addEventListener(
      'pointerdown',
      () => {
        this.hovered = true
        this.hooks.onActivate(this)
      },
      true, // «на входе»: срабатывает раньше, чем рисование успеет перехватить щелчок
    )
  }

  // ---------- График ----------
  buildChart() {
    this.chartEl = this.el.querySelector('.pane-chart')
    this.el.style.background = style.bg
    this.chart = createChart(this.chartEl, {
      autoSize: true,
      // значок TradingView с графика убран — ссылка на TradingView есть внизу панели инструментов слева
      ...this.styleOptions(), // цвета, сетка, перекрестие — из «Настроек графика»
      crosshair: { mode: CrosshairMode.Normal, ...this.styleOptions().crosshair },
      rightPriceScale: { borderColor: '#262b36' },
      // время — по часам пользователя (у библиотеки по умолчанию UTC)
      timeScale: { borderColor: '#262b36', timeVisible: true, secondsVisible: false, tickMarkFormatter },
      localization: { locale: 'ru-RU', timeFormatter: (t) => crosshairTime(t, this.intervalSec < 86400) },
    })
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    this.chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
    // перевод «время/цена» ⇄ пиксели для рисунков
    this.adapter = makeAdapter(this.chart, () => this.candles, () => this.bars, () => this.intervalSec)
    this.createMainSeries()
    this.setVolumeVisible(this.showVolume)
    this.buildIndicators()

    // Движение мыши по графику
    this.chart.subscribeCrosshairMove((param) => {
      // Если видна только горизонтальная линия из другого окна — свеча под ней случайная, её цены не показываем
      const bar = param.time && this.vertLineOn !== false ? this.barAt(param.time) : null
      this.legendLive = !bar
      this.showOhlc(bar || this.bars.at(-1))
      if (!this.hovered) return // это движение вызвала синхронизация, а не пользователь
      // цену передаём, только если мышь над свечами (а не над панелью индикатора внизу)
      const price = param.point && !param.paneIndex ? this.candles.coordinateToPrice(param.point.y) : null
      this.crosshairPrice = price // для Alt+A — оповещение на цене под курсором
      this.hooks.onCrosshair(this, param.time ?? null, price)
    })

    // Прокрутка и масштаб
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return
      if (range.from < 30) this.loadMore()
      if (this.hovered) this.hooks.onScroll(this)
    })
  }

  // Главная серия (свечи, бары, линия…). При смене типа старую убираем и создаём новую.
  createMainSeries() {
    if (this.candles) this.chart.removeSeries(this.candles)
    const type = chartTypeInfo(this.chartType)
    this.seriesCtor = type.series
    this.toPoint = type.point
    this.candles = this.chart.addSeries(type.series, {
      ...type.options(style),
      priceLineVisible: style.lastPriceLine,
      lastValueVisible: style.priceLabel,
      priceFormat: { type: 'price', precision: this.decimals, minMove: 10 ** -this.decimals },
    }, 0)
    this.candles.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: this.showVolume === false ? 0.06 : 0.25 } })
    // слой с рисунками живёт на главной серии
    this.drawPrim = new DrawingsPrimitive(this.adapter, () => this.key, true, 1, () => this.drawCtl?.snap, () => this.drawCtl?.measure)
    this.candles.attachPrimitive(this.drawPrim)
    // границы дня на таймфреймах до 1ч
    this.candles.attachPrimitive(new DayLinesPrimitive(this.chart, () => this.bars, () => this.intervalSec))
    // таймер до закрытия свечи под меткой цены
    this.candles.attachPrimitive(
      new CountdownPrimitive(() => this.bars, () => this.intervalSec, () => this.candles, () => !['candles', 'bars', 'hollow', 'heikin'].includes(this.chartType)),
    )
    if (this.bars.length) this.candles.setData(this.bars.map(this.toPoint))
    this.paperLines?.clear() // старые линии были на старой серии
    this.syncPaperLines?.()
  }

  // ---------- Демо-счёт на графике ----------

  // Линии позиции (вход, стоп, тейк) и ордеров этой монеты — создать заново
  syncPaperLines() {
    if (!this.candles || !this.paperLines) return
    for (const { priceLine } of this.paperLines.values()) {
      try {
        this.candles.removePriceLine(priceLine)
      } catch {}
    }
    this.paperLines.clear()
    for (const line of paper.lines(this.key)) {
      const priceLine = this.candles.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: line.id === 'entry' ? 2 : 1,
        lineStyle: line.id === 'entry' ? 0 : 2,
        axisLabelVisible: true,
        title: line.title,
      })
      this.paperLines.set(line.id, { line, priceLine })
    }
  }

  // Прибыль на линии входа меняется с ценой — обновляем подпись (не чаще 4 раз в секунду)
  schedulePaperTitles() {
    if (this.paperTimer) return
    this.paperTimer = setTimeout(() => {
      this.paperTimer = 0
      const entry = this.paperLines.get('entry')
      if (!entry) return
      const fresh = paper.lines(this.key).find((l) => l.id === 'entry')
      if (fresh) entry.priceLine.applyOptions({ title: fresh.title, color: fresh.color })
    }, 250)
  }

  // Линия демо-счёта под мышью (стоп, тейк или ордер — их можно тянуть)
  paperHit(x, y) {
    if (x > this.chart.timeScale().width()) return null
    for (const item of this.paperLines.values()) {
      if (!item.line.drag) continue
      const ly = this.candles.priceToCoordinate(item.priceLine.options().price)
      if (ly != null && Math.abs(ly - y) <= 5) return item
    }
    return null
  }

  // Часть настроек графика, которая зависит от «Настроек графика»
  styleOptions() {
    const cross = { color: style.crosshairColor, style: LINE_STYLE[style.crosshairStyle] ?? 2 }
    return {
      layout: { background: { color: style.bg }, textColor: style.text, fontSize: style.fontSize, attributionLogo: false },
      grid: { vertLines: { visible: style.grid, color: style.gridColor }, horzLines: { visible: style.grid, color: style.gridColor } },
      crosshair: { vertLine: cross, horzLine: cross },
    }
  }

  // Поменяли настройки графика — применить без перезагрузки данных
  applyStyle() {
    this.chart.applyOptions(this.styleOptions())
    this.candles.applyOptions({
      ...chartTypeInfo(this.chartType).options(style),
      priceLineVisible: style.lastPriceLine,
      lastValueVisible: style.priceLabel,
    })
    if (this.bars.length) this.volume.setData(this.bars.map(volumeBar))
    this.el.style.background = style.bg
  }

  setChartType(code) {
    if (code === this.chartType) return
    const range = this.chart.timeScale().getVisibleLogicalRange()
    this.chartType = code
    this.createMainSeries()
    if (range) this.chart.timeScale().setVisibleLogicalRange(range) // участок истории не прыгает
  }

  // ---------- Индикаторы ----------

  // Показать / спрятать объём. Без объёма свечи занимают и нижнюю часть графика
  setVolumeVisible(on) {
    this.showVolume = on
    this.volume.applyOptions({ visible: on })
    this.candles.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: on ? 0.25 : 0.06 } })
  }

  setIndicators(list) {
    this.indicators = list
    this.buildIndicators()
  }

  // Убираем старые линии индикаторов и создаём заново по списку
  buildIndicators() {
    for (const e of this.indSeries) for (const l of e.lines) this.chart.removeSeries(l.series)
    for (const t of this.taTables) t.destroy()
    this.indSeries = []
    this.taTables = []
    let nextPane = 1 // индикаторы «в своей панели» идут под графиком по очереди
    for (const ind of this.indicators) {
      const def = INDICATORS[ind.type]
      if (!def) continue
      if (def.table) {
        this.taTables.push(new TATable(this, ind)) // таблица в углу, а не линии
        continue
      }
      const paneIndex = def.overlay ? 0 : nextPane++
      const precision = def.precision ?? this.decimals
      const lines = def.lines.map((line, n) => {
        const ctor = line.type === 'histogram' ? HistogramSeries : LineSeries
        const series = this.chart.addSeries(ctor, {
          color: line.color || ind.color,
          lineWidth: def.type === 'bb' && n > 0 ? 1 : 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
          priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
        }, paneIndex)
        return { key: line.key, series, ctor, values: [] }
      })
      // уровни (70/30 у RSI, 80/20 у стохастика) — пунктиром
      for (const level of def.levels || []) {
        lines[0].series.createPriceLine({ price: level, color: '#787b86', lineStyle: 2, lineWidth: 1, axisLabelVisible: false })
      }
      this.indSeries.push({ ind, def, paneIndex, lines, precision })
    }
    // главная панель выше панелей индикаторов
    const panes = this.chart.panes()
    panes.forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1))
    this.updateIndicators(0)
    this.refreshLegend()
  }

  // Перерисовать подписи, когда панели индикаторов уже получили свою высоту
  refreshLegend() {
    cancelAnimationFrame(this.legendFrame)
    this.legendFrame = requestAnimationFrame(() => {
      this.showOhlc(this.lastShownBar || this.bars.at(-1))
      for (const t of this.taTables) t.place()
    })
  }

  // Пересчитать индикаторы. from — с какой свечи изменились данные (0 — всё заново)
  updateIndicators(from) {
    const bars = this.bars
    const partial = from > 0 && from >= bars.length - 1
    for (const e of this.indSeries) {
      const res = e.def.calc(bars, e.ind.params)
      for (const l of e.lines) {
        l.values = res[l.key]
        const point = (i) => {
          const v = l.values[i]
          if (v == null) return { time: bars[i].time } // данных ещё не хватает — пустая точка
          if (l.ctor === HistogramSeries) return { time: bars[i].time, value: v, color: v >= 0 ? UP + 'aa' : DOWN + 'aa' }
          return { time: bars[i].time, value: v }
        }
        if (partial) for (let i = from; i < bars.length; i++) l.series.update(point(i))
        else l.series.setData(bars.map((_, i) => point(i)))
      }
    }
  }

  // Подписи индикаторов со значениями для свечи номер i
  showIndicatorLegend(i) {
    if (!this.indSeries.length) {
      this.legendsEl.innerHTML = ''
      return
    }
    const heights = this.chart.panes().map((p) => p.getHeight())
    const head = this.el.querySelector('.pane-head').offsetHeight
    let overlayRow = 0
    let html = ''
    for (const e of this.indSeries) {
      const values = e.lines
        .map((l) => {
          const v = l.values[i]
          const color = e.def.lines.find((x) => x.key === l.key).color || e.ind.color
          return v == null ? '' : `<i style="color:${color}">${fmt(v, e.precision)}</i>`
        })
        .join(' ')
      let top
      if (e.paneIndex === 0) top = 6 + head + overlayRow++ * 17
      else top = heights.slice(0, e.paneIndex).reduce((a, b) => a + b, 0) + e.paneIndex + 4 // +1 px на каждую границу
      html += `<div class="ind-legend" style="top:${top}px"><span style="color:${e.ind.color}">${indicatorLabel(e.ind)}</span> ${values}</div>`
    }
    this.legendsEl.innerHTML = html
  }

  // Для снимков: что нарисовать в легенде и где
  legendItems() {
    const i = this.bars.length - 1
    return this.indSeries.map((e) => ({
      paneIndex: e.paneIndex,
      parts: [
        { text: indicatorLabel(e.ind), color: e.ind.color },
        ...e.lines
          .filter((l) => l.values[i] != null)
          .map((l) => ({ text: fmt(l.values[i], e.precision), color: e.def.lines.find((x) => x.key === l.key).color || e.ind.color })),
      ],
    }))
  }

  // ---------- Данные ----------
  async load() {
    const id = ++this.loadId
    this.unsubscribe?.()
    this.unsubscribe = null
    this.bars = []
    this.noMoreHistory = false
    this.candles.setData([])
    this.volume.setData([])
    for (const e of this.indSeries) for (const l of e.lines) l.series.setData([])
    this.symbolEl.textContent = this.symbol
    this.el.classList.toggle('delayed', isDelayed(this.market)) // пометка «данные с задержкой»
    this.ohlcEl.innerHTML = ''
    this.showStatus('Загрузка…')

    try {
      const history = await loadCandles(this.market, this.symbol, this.interval)
      if (id !== this.loadId) return
      if (!history.length) throw new Error('нет данных')
      this.bars = history
      // у бумаг Мосбиржи свой шаг цены (Сбер — 0,01, ВТБ — 0,000005): смотрим, сколько знаков в самих ценах
      this.decimals = isDelayed(this.market) ? dataDecimals(history) : decimalsFor(history.at(-1).close)
      this.candles.applyOptions({
        priceFormat: { type: 'price', precision: this.decimals, minMove: 10 ** -this.decimals },
      })
      this.candles.setData(this.bars.map(this.toPoint))
      this.volume.setData(this.bars.map(volumeBar))
      for (const e of this.indSeries) e.precision = e.def.precision ?? this.decimals
      this.updateIndicators(0)
      for (const t of this.taTables) t.refresh()
      this.chart.timeScale().scrollToRealTime()
      this.showStatus('')
      this.showOhlc(this.bars.at(-1))
      this.hooks.onPrice(this, this.bars.at(-1).close)
      this.lastTradeTime = 0
      this.unsubscribe = subscribeLive(this.market, this.symbol, this.interval, {
        onKline: (bar, sentAt) => this.onKline(bar, sentAt),
        onTrade: (price, qty, time) => this.onTrade(price, qty, time),
        onStatus: (text) => this.showStatus(text),
      })
    } catch (err) {
      if (id !== this.loadId) return
      this.showStatus(`Не удалось загрузить ${this.symbol}: ${err.message}`)
    }
  }

  // ---------- Живые обновления ----------

  // Пришла сделка: двигаем цену последней свечи (или начинаем новую свечу)
  onTrade(price, qty, time) {
    const last = this.bars.at(-1)
    if (!last || time < last.time) return
    const sec = this.intervalSec
    if (time >= last.time + sec) {
      // время новой свечи: считаем от предыдущей, чтобы недельные свечи начинались с понедельника
      const start = last.time + Math.floor((time - last.time) / sec) * sec
      this.bars.push({ time: start, open: price, high: price, low: price, close: price, volume: qty })
      this.markDirty(this.bars.length - 1)
    } else {
      last.close = price
      if (price > last.high) last.high = price
      if (price < last.low) last.low = price
      last.volume += qty
      this.markDirty(this.bars.length - 1)
    }
    if (time > this.lastTradeTime) this.lastTradeTime = time
  }

  // Пришла свеча от биржи: берём из неё точные данные
  onKline(bar, sentAt) {
    const last = this.bars.at(-1)
    if (!last) return
    const i = bar.time === last.time ? this.bars.length - 1 : this.indexAtOrBefore(bar.time)
    if (bar.time > last.time) {
      this.bars.push(bar)
      this.markDirty(this.bars.length - 1)
      return
    }
    if (i < 0 || this.bars[i].time !== bar.time) return
    const cur = this.bars[i]
    // если после отправки этой свечи уже были сделки — их цена свежее, её не трогаем
    const tradesNewer = i === this.bars.length - 1 && this.lastTradeTime > sentAt
    cur.open = bar.open
    cur.high = Math.max(bar.high, tradesNewer ? cur.high : -Infinity)
    cur.low = Math.min(bar.low, tradesNewer ? cur.low : Infinity)
    if (!tradesNewer) cur.close = bar.close
    cur.volume = tradesNewer ? Math.max(bar.volume, cur.volume) : bar.volume
    this.markDirty(i)
  }

  // Изменения копим и рисуем один раз за кадр экрана (до 60 раз в секунду) —
  // чаще монитор всё равно не покажет, а компьютер не будет нагружаться зря
  markDirty(i) {
    if (this.dirtyFrom < 0 || i < this.dirtyFrom) this.dirtyFrom = i
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush())
  }

  flush() {
    this.frame = 0
    const from = this.dirtyFrom
    this.dirtyFrom = -1
    if (from < 0 || !this.bars.length) return
    if (from < this.bars.length - 1) {
      // поменялась не последняя свеча (например, биржа прислала итог уже закрытой) —
      // библиотека умеет обновлять только последнюю, поэтому перерисовываем всё
      this.candles.setData(this.bars.map(this.toPoint))
      this.volume.setData(this.bars.map(volumeBar))
      this.updateIndicators(0)
    } else {
      for (let i = from; i < this.bars.length; i++) {
        this.candles.update(this.toPoint(this.bars[i]))
        this.volume.update(volumeBar(this.bars[i]))
      }
      this.updateIndicators(Math.max(1, from))
    }
    const last = this.bars.at(-1)
    if (this.legendLive) this.showOhlc(last)
    for (const t of this.taTables) t.onPrice()
    this.hooks.onPrice(this, last.close)
  }

  // Подгрузка старой истории при прокрутке влево
  async loadMore() {
    if (this.loadingMore || this.noMoreHistory || !this.bars.length) return
    this.loadingMore = true
    const id = this.loadId
    try {
      const older = await loadCandles(this.market, this.symbol, this.interval, this.bars[0].time)
      if (id !== this.loadId) return
      if (!older.length) this.noMoreHistory = true
      else {
        this.bars = [...older, ...this.bars]
        this.candles.setData(this.bars.map(this.toPoint))
        this.volume.setData(this.bars.map(volumeBar))
        this.updateIndicators(0)
      }
    } catch {
      // попробуем при следующей прокрутке
    } finally {
      this.loadingMore = false
    }
  }

  // ---------- Смена монеты / интервала / рынка ----------
  setSymbol(symbol, market = this.market) {
    if (symbol === this.symbol && market === this.market) return
    this.symbol = symbol
    this.market = market
    this.syncPaperLines()
    this.load()
  }
  setInterval(code) {
    if (code === this.interval) return
    this.interval = code
    this.intervalSelect.value = code
    for (const t of this.taTables) t.updateVisibility()
    this.load()
  }
  get intervalLabel() {
    return intervalInfo(this.interval).label
  }
  get intervalSec() {
    return intervalInfo(this.interval).sec
  }

  // ---------- Поиск свечи по времени ----------

  // Номер последней свечи, которая началась не позже time (двоичный поиск). -1 — если раньше всех.
  indexAtOrBefore(time) {
    let lo = 0
    let hi = this.bars.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.bars[mid].time <= time) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return found
  }
  barAt(time) {
    const i = this.indexAtOrBefore(time)
    return i >= 0 ? this.bars[i] : null
  }

  // Время в центре экрана и видна ли последняя свеча — нужно для синхронизации времени
  viewInfo() {
    const range = this.chart.timeScale().getVisibleLogicalRange()
    if (!range || !this.bars.length) return null
    const last = this.bars.length - 1
    const center = (range.from + range.to) / 2
    const i = Math.max(0, Math.min(last, Math.floor(center)))
    const time = this.bars[i].time + (center - i) * this.intervalSec
    return { time, atRealtime: range.to >= last }
  }

  // Сдвинуть график так, чтобы time оказался в центре (масштаб окна не меняется)
  centerOn(time) {
    const range = this.chart.timeScale().getVisibleLogicalRange()
    if (!range || !this.bars.length) return
    const width = range.to - range.from
    let i = this.indexAtOrBefore(time)
    if (i < 0) i = 0
    const pos = i + (time - this.bars[i].time) / this.intervalSec
    this.chart.timeScale().setVisibleLogicalRange({ from: pos - width / 2, to: pos + width / 2 })
  }
  scrollToRealtime() {
    this.chart.timeScale().scrollToRealTime()
  }

  // Показать перекрестие, пришедшее из другого окна
  showCrosshair(time, price) {
    const range = this.chart.timeScale().getVisibleLogicalRange()
    if (price == null || time == null || !range || !this.bars.length) {
      this.setVertLine(true)
      this.chart.clearCrosshairPosition()
      this.showOhlc(this.bars.at(-1))
      return
    }
    const last = this.bars.length - 1
    const first = Math.max(0, Math.ceil(range.from))
    const end = Math.min(last, Math.floor(range.to))
    const i = this.indexAtOrBefore(time)

    if (i >= first && i <= end) {
      // Дата видна на экране — показываем обе линии
      this.setVertLine(true)
      this.chart.setCrosshairPosition(price, this.bars[i].time, this.candles)
    } else {
      // Дата за краем экрана — только горизонтальная линия с ценой.
      // Графику всё равно нужно какое-то время, берём видимую свечу, а вертикальную линию прячем.
      this.setVertLine(false)
      this.chart.setCrosshairPosition(price, this.bars[Math.max(first, Math.min(end, i))].time, this.candles)
    }
  }

  // Показать или спрятать вертикальную линию перекрестия (вместе с подписью даты внизу)
  setVertLine(on) {
    if (this.vertLineOn === on) return
    this.vertLineOn = on
    this.chart.applyOptions({ crosshair: { vertLine: { visible: on, labelVisible: on } } })
  }

  // ---------- Надписи ----------
  showOhlc(bar) {
    if (!bar) return
    this.lastShownBar = bar
    const cls = bar.close >= bar.open ? 'up' : 'down'
    const v = (label, n) => `<span>${label} <i class="${cls}">${fmt(n, this.decimals)}</i></span>`
    this.ohlcEl.innerHTML = v('О', bar.open) + v('М', bar.high) + v('Н', bar.low) + v('З', bar.close)
    this.showIndicatorLegend(this.indexAtOrBefore(bar.time))
  }
  showStatus(text) {
    this.statusEl.textContent = text
    this.statusEl.classList.toggle('show', !!text)
  }
  setActive(on) {
    this.isActive = on
    this.el.classList.toggle('active', on)
    for (const t of this.taTables) t.updateVisibility()
  }

  destroy() {
    this.loadId++
    cancelAnimationFrame(this.frame)
    cancelAnimationFrame(this.legendFrame)
    this.resizeObs.disconnect()
    for (const t of this.taTables) t.destroy()
    this.offDraw()
    this.offPaper()
    clearTimeout(this.paperTimer)
    this.drawCtl.destroy()
    this.unsubscribe?.()
    this.chart.remove()
    this.el.remove()
  }
}
