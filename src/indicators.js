// Индикаторы: формулы и описание того, как их рисовать.
//
// Каждая формула получает массив свечей и возвращает массив значений той же длины
// (null там, где данных для расчёта пока не хватает — например, первые 19 свечей у SMA 20).

// ---------- Базовые формулы ----------

export function sma(src, n) {
  const out = new Array(src.length).fill(null)
  let sum = 0
  let count = 0
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (v == null) continue
    sum += v
    count++
    if (count > n) sum -= src[i - n]
    if (count >= n) out[i] = sum / n
  }
  return out
}

// Экспоненциальная средняя: первое значение — простая средняя, дальше вес 2/(n+1)
export function ema(src, n) {
  const out = new Array(src.length).fill(null)
  const k = 2 / (n + 1)
  let prev = null
  let sum = 0
  let count = 0
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (v == null) continue
    if (prev == null) {
      sum += v
      count++
      if (count === n) prev = out[i] = sum / n
    } else {
      prev = out[i] = v * k + prev * (1 - k)
    }
  }
  return out
}

// Средняя Уайлдера (используется в RSI и ATR): вес 1/n
export function rma(src, n) {
  const out = new Array(src.length).fill(null)
  let prev = null
  let sum = 0
  let count = 0
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (v == null) continue
    if (prev == null) {
      sum += v
      count++
      if (count === n) prev = out[i] = sum / n
    } else {
      prev = out[i] = (prev * (n - 1) + v) / n
    }
  }
  return out
}

// Взвешенная средняя: у свежих свечей вес больше
export function wma(src, n) {
  const out = new Array(src.length).fill(null)
  const denom = (n * (n + 1)) / 2
  for (let i = n - 1; i < src.length; i++) {
    let s = 0
    for (let j = 0; j < n; j++) s += src[i - j] * (n - j)
    out[i] = s / denom
  }
  return out
}

function stdev(src, n, mean) {
  const out = new Array(src.length).fill(null)
  for (let i = n - 1; i < src.length; i++) {
    if (mean[i] == null) continue
    let s = 0
    for (let j = 0; j < n; j++) s += (src[i - j] - mean[i]) ** 2
    out[i] = Math.sqrt(s / n)
  }
  return out
}

const closes = (bars) => bars.map((b) => b.close)

// ---------- Индикаторы ----------
//
// overlay: true — рисуется поверх свечей, false — в своей панели под графиком
// params — настройки (подпись, значение по умолчанию)
// lines — какие линии получаются; calc — формула, возвращает { имя линии: массив значений }

export const INDICATORS = {
  ta: {
    name: 'Trader Assistant', title: 'Таблица по дневному ATR: стоп, тейк, люфт, границы дня, исчерпание ATR, объём', overlay: true,
    table: true, // не линии, а таблица в углу графика (см. traderAssistant.js)
    params: {
      atrLength: ['Баров для ATR (дней)', 5],
      stop: ['Стоп-лосс, % от ATR', 10],
      take: ['Тейк-профит, × к стопу', 4],
      slip: ['Люфт, % от стопа', 10],
      longThr: ['Лонг при ATR < %', 30],
      shortThr: ['Шорт при ATR > %', 70],
      minVol: ['Объём для торговли > млн $', 30],
      where: ['Где показывать', 'в активном окне', ['в активном окне', 'на таймфреймах до 15м', 'во всех окнах']],
      showVolume: ['Показать объём', 'да', ['да', 'нет']],
      font: ['Увеличение шрифта', '0', ['0', '1', '2', '3']],
    },
    color: '#5b8def',
    lines: [],
  },
  sma: {
    name: 'SMA', title: 'Простая скользящая средняя', overlay: true,
    params: { length: ['Период', 20] }, color: '#ff9800',
    lines: [{ key: 'v' }],
    calc: (bars, p) => ({ v: sma(closes(bars), p.length) }),
  },
  ema: {
    name: 'EMA', title: 'Экспоненциальная скользящая средняя', overlay: true,
    params: { length: ['Период', 20] }, color: '#2962ff',
    lines: [{ key: 'v' }],
    calc: (bars, p) => ({ v: ema(closes(bars), p.length) }),
  },
  wma: {
    name: 'WMA', title: 'Взвешенная скользящая средняя', overlay: true,
    params: { length: ['Период', 20] }, color: '#e040fb',
    lines: [{ key: 'v' }],
    calc: (bars, p) => ({ v: wma(closes(bars), p.length) }),
  },
  bb: {
    name: 'BB', title: 'Полосы Боллинджера', overlay: true,
    params: { length: ['Период', 20], mult: ['Отклонений', 2] }, color: '#2196f3',
    lines: [{ key: 'basis', color: '#ff9800' }, { key: 'upper' }, { key: 'lower' }],
    calc: (bars, p) => {
      const c = closes(bars)
      const basis = sma(c, p.length)
      const dev = stdev(c, p.length, basis)
      return {
        basis,
        upper: basis.map((b, i) => (b == null ? null : b + p.mult * dev[i])),
        lower: basis.map((b, i) => (b == null ? null : b - p.mult * dev[i])),
      }
    },
  },
  vwap: {
    name: 'VWAP', title: 'Средняя цена, взвешенная по объёму (с начала дня)', overlay: true,
    params: {}, color: '#00bcd4',
    lines: [{ key: 'v' }],
    calc: (bars) => {
      const v = new Array(bars.length).fill(null)
      let day = null
      let pv = 0
      let vol = 0
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i]
        const d = Math.floor(b.time / 86400) // новый день (по UTC, как у Binance) — считаем заново
        if (d !== day) {
          day = d
          pv = 0
          vol = 0
        }
        pv += ((b.high + b.low + b.close) / 3) * b.volume
        vol += b.volume
        v[i] = vol ? pv / vol : b.close
      }
      return { v }
    },
  },
  rsi: {
    name: 'RSI', title: 'Индекс относительной силы', overlay: false,
    params: { length: ['Период', 14] }, color: '#7e57c2',
    lines: [{ key: 'v' }], levels: [70, 30], precision: 2,
    calc: (bars, p) => {
      const c = closes(bars)
      const up = c.map((v, i) => (i ? Math.max(v - c[i - 1], 0) : null))
      const down = c.map((v, i) => (i ? Math.max(c[i - 1] - v, 0) : null))
      const au = rma(up, p.length)
      const ad = rma(down, p.length)
      return { v: au.map((u, i) => (u == null ? null : ad[i] === 0 ? 100 : 100 - 100 / (1 + u / ad[i]))) }
    },
  },
  macd: {
    name: 'MACD', title: 'Схождение-расхождение скользящих средних', overlay: false,
    params: { fast: ['Быстрая', 12], slow: ['Медленная', 26], signal: ['Сигнальная', 9] }, color: '#2962ff',
    lines: [{ key: 'hist', type: 'histogram' }, { key: 'macd' }, { key: 'signal', color: '#ff9800' }],
    calc: (bars, p) => {
      const c = closes(bars)
      const f = ema(c, p.fast)
      const s = ema(c, p.slow)
      const macd = f.map((v, i) => (v == null || s[i] == null ? null : v - s[i]))
      const signal = ema(macd, p.signal)
      return { macd, signal, hist: macd.map((m, i) => (m == null || signal[i] == null ? null : m - signal[i])) }
    },
  },
  stoch: {
    name: 'Stoch', title: 'Стохастик', overlay: false,
    params: { k: ['%K', 14], d: ['%D', 3], smooth: ['Сглаживание', 3] }, color: '#2962ff',
    lines: [{ key: 'k' }, { key: 'd', color: '#ff9800' }], levels: [80, 20], precision: 2,
    calc: (bars, p) => {
      const raw = bars.map((b, i) => {
        if (i < p.k - 1) return null
        let hh = -Infinity
        let ll = Infinity
        for (let j = i - p.k + 1; j <= i; j++) {
          hh = Math.max(hh, bars[j].high)
          ll = Math.min(ll, bars[j].low)
        }
        return hh === ll ? 50 : ((b.close - ll) / (hh - ll)) * 100
      })
      const k = sma(raw, p.smooth)
      return { k, d: sma(k, p.d) }
    },
  },
  atr: {
    name: 'ATR', title: 'Средний истинный диапазон', overlay: false,
    params: { length: ['Период', 14] }, color: '#ef5350',
    lines: [{ key: 'v' }],
    calc: (bars, p) => {
      const tr = bars.map((b, i) =>
        i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low,
      )
      return { v: rma(tr, p.length) }
    },
  },
}

export const INDICATOR_ORDER = ['ta', 'ema', 'sma', 'wma', 'bb', 'vwap', 'rsi', 'macd', 'stoch', 'atr']

/** Новый индикатор с настройками по умолчанию */
export function newIndicator(type) {
  const def = INDICATORS[type]
  const params = {}
  for (const [k, [, v]] of Object.entries(def.params)) params[k] = v
  return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type, params, color: def.color }
}

/** Подпись индикатора: «EMA 20», «MACD 12 26 9» */
export function indicatorLabel(ind) {
  const def = INDICATORS[ind.type]
  if (def.table) return def.name
  const values = Object.values(ind.params)
  return values.length ? `${def.name} ${values.join(' ')}` : def.name
}
