// Индикатор «Trader Assistant» (перенос с TradingView / Pine Script).
//
// Формулы как в оригинале:
//  • ATR — среднее (максимум − минимум) N предыдущих завершённых дневных свечей (текущий день не входит)
//  • стоп = ATR × % стопа, тейк = стоп × множитель, люфт = стоп × % люфта
//  • по пятиминуткам: стоп = 2 × ATR(30) пятиминутного графика (ATR Уайлдера), тейк и люфт так же
//  • максимум/минимум на сегодня: открытие ± ATR («от Open»), минимум + ATR и максимум − ATR («от High/Low»)
//  • объём за день — оборот за последние 24 часовые свечи (объём × цена закрытия)
//  • ATR исчерпан: |цена − открытие дня| / ATR и (максимум − минимум дня) / ATR, в процентах
// Параметры фильтра «не более 150% / не менее 50%» в оригинале объявлены, но в расчёте не используются —
// здесь их тоже нет.
import { loadCandles } from './binance.js'

const CACHE_MS = 15_000
const cache = new Map() // 'futures:BTCUSDT' → { at, promise }

/** Свечи для расчёта: дневные, часовые и пятиминутные. Кэш на 15 секунд — окна с одной монетой не грузят повторно */
export function loadTAData(market, symbol) {
  const key = `${market}:${symbol}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise
  const promise = Promise.all([
    loadCandles(market, symbol, '1d', null, 15),
    loadCandles(market, symbol, '1h', null, 24),
    loadCandles(market, symbol, '5m', null, 300),
  ]).then(([daily, hourly, m5]) => ({ daily, hourly, m5 }))
  cache.set(key, { at: Date.now(), promise })
  promise.catch(() => cache.delete(key))
  return promise
}

// ATR Уайлдера (как ta.atr в TradingView)
function wilderAtr(bars, len) {
  if (bars.length < 2) return 0
  const tr = bars.map((b, i) => {
    const prev = i ? bars[i - 1].close : b.close
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev))
  })
  const n = Math.min(len, tr.length)
  let rma = tr.slice(0, n).reduce((s, v) => s + v, 0) / n
  for (let i = n; i < tr.length; i++) rma = (rma * (len - 1) + tr[i]) / len
  return rma
}

/** Все значения таблицы. last — самая свежая цена (из окна графика) */
export function computeTA(data, last, p) {
  const { daily, hourly, m5 } = data
  if (daily.length < 2) return null
  const today = daily.at(-1)
  const prevDays = daily.slice(0, -1).slice(-p.atrLength)
  const atr = prevDays.reduce((s, b) => s + (b.high - b.low), 0) / prevDays.length
  if (!(atr > 0)) return null
  const price = last ?? today.close
  const high = Math.max(today.high, price)
  const low = Math.min(today.low, price)

  const stop = atr * (p.stop / 100)
  const atr5 = wilderAtr(m5, 30)
  const stop5 = atr5 * 2
  const dayVolume = hourly.reduce((s, b) => s + b.volume * b.close, 0)

  return {
    atr,
    stop, take: stop * p.take, slip: stop * (p.slip / 100),
    stop5, take5: stop5 * p.take, slip5: stop5 * (p.slip / 100),
    maxFromOpen: today.open + atr, minFromOpen: today.open - atr,
    maxFromLow: low + atr, minFromHigh: high - atr,
    spentOpen: (Math.abs(price - today.open) / atr) * 100,
    spentRange: ((high - low) / atr) * 100,
    dayVolume,
  }
}

// «1.2 B», «345 M», «12 K» — как форматирует оригинал
export function fmtVolume(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + ' B'
  if (v >= 1e6) return Math.round(v / 1e6) + ' M'
  if (v >= 1e3) return Math.round(v / 1e3) + ' K'
  return String(Math.round(v))
}

const BLUE = '#5b8def'
const TEXT = '#d1d4dc'
const MUTED = '#9598a1'
const GREEN = '#26a69a'
const RED = '#ef5350'

/**
 * Строки таблицы: [подпись, «от Open», «от High/Low», цвета…]. Одна и та же модель
 * рисуется и на экране (HTML), и на снимке (canvas).
 */
export function taRows(v, p, fmt) {
  const tone = (pct) => (pct < p.longThr ? GREEN : pct > p.shortThr ? RED : TEXT)
  const sign = (pct) => (pct < p.longThr ? '💪 ' : pct > p.shortThr ? '✋ ' : '')
  const pct = (x) => x.toFixed(2).replace('.', ',') + '%'
  const rows = [
    { cells: ['', 'От Open', 'От High/Low'], colors: [MUTED, MUTED, MUTED], head: true },
    { cells: ['Максимум на сегодня с учётом ATR:', fmt(v.maxFromOpen), fmt(v.maxFromLow)], colors: [BLUE, BLUE, BLUE] },
    { cells: ['Стоп-лосс:', fmt(v.stop), fmt(v.stop5)], colors: [TEXT, TEXT, TEXT] },
    { cells: ['Тейк-профит:', fmt(v.take), fmt(v.take5)], colors: [TEXT, TEXT, TEXT] },
    { cells: ['Люфт:', fmt(v.slip), fmt(v.slip5)], colors: [TEXT, TEXT, TEXT] },
    { cells: ['Минимум на сегодня с учётом ATR:', fmt(v.minFromOpen), fmt(v.minFromHigh)], colors: [BLUE, BLUE, BLUE] },
  ]
  if (p.showVolume === 'да') {
    const c = v.dayVolume >= p.minVol * 1e6 ? TEXT : RED
    rows.push({ cells: ['Объём за день:', fmtVolume(v.dayVolume), ''], colors: [c, c, c], big: true })
  }
  rows.push({ cells: ['ATR:', fmt(v.atr), ''], colors: [MUTED, MUTED, MUTED], big: true })
  rows.push({
    cells: ['ATR исчерпан на:', sign(v.spentOpen) + pct(v.spentOpen), sign(v.spentRange) + pct(v.spentRange)],
    colors: [tone(v.spentOpen), tone(v.spentOpen), tone(v.spentRange)],
    big: true,
  })
  return rows
}

/** Таблица в левом нижнем углу окна графика */
export class TATable {
  constructor(pane, ind) {
    this.pane = pane
    this.ind = ind
    this.data = null
    this.el = document.createElement('div')
    this.el.className = 'ta-table'
    pane.el.append(this.el)
    this.refresh()
    this.timer = setInterval(() => this.refresh(), CACHE_MS)
  }

  async refresh() {
    const { market, symbol } = this.pane
    const key = `${market}:${symbol}`
    try {
      const data = await loadTAData(market, symbol)
      if (key !== `${this.pane.market}:${this.pane.symbol}`) return // пока грузили, монету сменили
      this.data = data
      this.render()
    } catch {
      this.el.innerHTML = '<div class="ta-wait">Trader Assistant: нет данных</div>'
    }
  }

  rows() {
    if (!this.data) return null
    const v = computeTA(this.data, this.pane.bars.at(-1)?.close, this.ind.params)
    if (!v) return null
    const d = this.pane.decimals
    const fmt = (x) => x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d })
    return taRows(v, this.ind.params, fmt)
  }

  // новая цена — перерисовать, но не чаще 4 раз в секунду
  onPrice() {
    if (this.pending) return
    this.pending = setTimeout(() => {
      this.pending = 0
      this.render()
    }, 250)
  }

  render() {
    const rows = this.rows()
    if (!rows) return
    const size = 12 + 2 * (+this.ind.params.font || 0)
    this.el.style.fontSize = size + 'px'
    this.el.innerHTML =
      '<table>' +
      rows
        .map((r) => `<tr class="${r.head ? 'head' : ''} ${r.big ? 'big' : ''}">${r.cells.map((c, i) => `<td style="color:${r.colors[i]}">${c}</td>`).join('')}</tr>`)
        .join('') +
      '</table>'
    this.place()
  }

  // над шкалой времени и панелями индикаторов — в самом низу панели со свечами
  place() {
    const mainHeight = this.pane.chart.panes()[0]?.getHeight() || 0
    this.el.style.top = Math.max(0, mainHeight - this.el.offsetHeight - 8) + 'px'
  }

  destroy() {
    clearInterval(this.timer)
    clearTimeout(this.pending)
    this.el.remove()
  }
}
