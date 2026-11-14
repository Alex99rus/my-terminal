// Одно окно графика. Каждое окно — отдельный график со своей монетой, интервалом
// и своим соединением с биржей. Окна ничего не знают друг о друге: о событиях
// (наведение мыши, прокрутка) они сообщают главному файлу, а тот синхронизирует остальные.
import {
  createChart, CandlestickSeries, BarSeries, LineSeries, AreaSeries, HistogramSeries, CrosshairMode,
} from 'lightweight-charts'
import { loadCandles, subscribeLive } from './binance.js'

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
export const CHART_TYPES = [
  {
    code: 'candles', label: 'Свечи', series: CandlestickSeries, point: ohlc,
    options: { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN },
  },
  {
    code: 'bars', label: 'Бары', series: BarSeries, point: ohlc,
    options: { upColor: UP, downColor: DOWN, openVisible: true, thinBars: false },
  },
  {
    code: 'hollow', label: 'Пустые свечи', series: CandlestickSeries, point: ohlc,
    options: {
      upColor: 'rgba(0,0,0,0)', downColor: DOWN, borderVisible: true,
      borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
    },
  },
  {
    code: 'line', label: 'Линия', series: LineSeries, point: closeOnly,
    options: { color: '#2962ff', lineWidth: 2 },
  },
  {
    code: 'area', label: 'Область', series: AreaSeries, point: closeOnly,
    options: { lineColor: '#2962ff', topColor: '#2962ff66', bottomColor: '#2962ff05', lineWidth: 2 },
  },
]
const chartTypeInfo = (code) => CHART_TYPES.find((t) => t.code === code) || CHART_TYPES[0]

const volumeBar = (b) => ({
  time: b.time,
  value: b.volume,
  color: b.close >= b.open ? UP + '80' : DOWN + '80',
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
    this.load()
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
        <span class="pane-ohlc"></span>
      </div>
      <div class="pane-chart"></div>
      <div class="pane-status"></div>`

    this.symbolEl = this.el.querySelector('.pane-symbol')
    this.ohlcEl = this.el.querySelector('.pane-ohlc')
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

    this.el.addEventListener('pointerdown', () => {
      this.hovered = true
      this.hooks.onActivate(this)
    })
  }

  // ---------- График ----------
  buildChart() {
    this.chart = createChart(this.el.querySelector('.pane-chart'), {
      autoSize: true,
      layout: { background: { color: '#0e1116' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1c2030' }, horzLines: { color: '#1c2030' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#262b36' },
      timeScale: { borderColor: '#262b36', timeVisible: true, secondsVisible: false },
      localization: { locale: 'ru-RU' },
    })
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    this.chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
    this.createMainSeries()

    // Движение мыши по графику
    this.chart.subscribeCrosshairMove((param) => {
      // Если видна только горизонтальная линия из другого окна — свеча под ней случайная, её цены не показываем
      const bar = param.time && this.vertLineOn !== false ? this.barAt(param.time) : null
      this.legendLive = !bar
      this.showOhlc(bar || this.bars.at(-1))
      if (!this.hovered) return // это движение вызвала синхронизация, а не пользователь
      const price = param.point ? this.candles.coordinateToPrice(param.point.y) : null
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
      ...type.options,
      priceFormat: { type: 'price', precision: this.decimals, minMove: 10 ** -this.decimals },
    }, 0)
    this.candles.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.25 } })
    if (this.bars.length) this.candles.setData(this.bars.map(this.toPoint))
  }

  setChartType(code) {
    if (code === this.chartType) return
    const range = this.chart.timeScale().getVisibleLogicalRange()
    this.chartType = code
    this.createMainSeries()
    if (range) this.chart.timeScale().setVisibleLogicalRange(range) // участок истории не прыгает
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
    this.symbolEl.textContent = this.symbol
    this.ohlcEl.innerHTML = ''
    this.showStatus('Загрузка…')

    try {
      const history = await loadCandles(this.market, this.symbol, this.interval)
      if (id !== this.loadId) return
      if (!history.length) throw new Error('нет данных')
      this.bars = history
      this.decimals = decimalsFor(history.at(-1).close)
      this.candles.applyOptions({
        priceFormat: { type: 'price', precision: this.decimals, minMove: 10 ** -this.decimals },
      })
      this.candles.setData(this.bars.map(this.toPoint))
      this.volume.setData(this.bars.map(volumeBar))
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
    if (from < this.bars.length - 2) {
      // поменялась старая свеча — проще перерисовать всё
      this.candles.setData(this.bars.map(this.toPoint))
      this.volume.setData(this.bars.map(volumeBar))
    } else {
      for (let i = from; i < this.bars.length; i++) {
        this.candles.update(this.toPoint(this.bars[i]))
        this.volume.update(volumeBar(this.bars[i]))
      }
    }
    const last = this.bars.at(-1)
    if (this.legendLive) this.showOhlc(last)
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
    this.load()
  }
  setInterval(code) {
    if (code === this.interval) return
    this.interval = code
    this.intervalSelect.value = code
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
    const cls = bar.close >= bar.open ? 'up' : 'down'
    const v = (label, n) => `<span>${label} <i class="${cls}">${fmt(n, this.decimals)}</i></span>`
    this.ohlcEl.innerHTML = v('О', bar.open) + v('М', bar.high) + v('Н', bar.low) + v('З', bar.close)
  }
  showStatus(text) {
    this.statusEl.textContent = text
    this.statusEl.classList.toggle('show', !!text)
  }
  setActive(on) {
    this.el.classList.toggle('active', on)
  }

  destroy() {
    this.loadId++
    cancelAnimationFrame(this.frame)
    this.unsubscribe?.()
    this.chart.remove()
    this.el.remove()
  }
}
