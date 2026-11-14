// Поток расчёта Pine Script: здесь работает PineTS, чтобы тяжёлые скрипты не тормозили графики.
// Получает свечи окна, сам подгружает данные других монет/таймфреймов (request.security)
// и возвращает результат (plots) обратно.
import { PineTS, Indicator } from 'pinets'
import { loadCandles } from './binance.js'

const OUR = [
  ['1m', 60], ['5m', 300], ['15m', 900], ['30m', 1800], ['1h', 3600], ['4h', 14400], ['1d', 86400], ['1w', 604800],
]
function pineTfSec(tf) {
  const s = String(tf || '').toUpperCase()
  const m = s.match(/^(\d*)([SDWM]?)$/)
  if (!m) return null
  const n = +(m[1] || 1)
  return { '': 60, S: 1, D: 86400, W: 604800, M: 2592000 }[m[2]] * n
}
// ---------- Данные для PineTS ----------
const data_interval = (pane) => ({ '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' })[pane.interval]
const toKline = (b, sec) => ({
  openTime: b.time * 1000,
  closeTime: (b.time + sec) * 1000,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  volume: b.volume || 0,
  quoteAssetVolume: 0,
  numberOfTrades: 0,
  takerBuyBaseAssetVolume: 0,
  takerBuyQuoteAssetVolume: 0,
  ignore: 0,
})
const cleanTicker = (t) => String(t || '').split(':').pop().replace(/\.P$/i, '').toUpperCase()

function aggregate(bars, sec) {
  const out = []
  for (const b of bars) {
    const t = sec >= 2592000 ? Date.UTC(new Date(b.time * 1000).getUTCFullYear(), new Date(b.time * 1000).getUTCMonth(), 1) / 1000 : Math.floor(b.time / sec) * sec
    const last = out.at(-1)
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high)
      last.low = Math.min(last.low, b.low)
      last.close = b.close
      last.volume += b.volume || 0
    } else out.push({ ...b, time: t })
  }
  return out
}

function makeProvider(pane) {
  const mainTicker = pane.symbol.toUpperCase()
  const mainTf = data_interval(pane)
  return {
    configure() {},
    async getSymbolInfo(t) {
      const ticker = cleanTicker(t)
      const mintick = 10 ** -(pane.decimals ?? 2)
      return {
        ticker, tickerid: ticker, main_tickerid: ticker, root: ticker, prefix: '', description: ticker, type: 'crypto',
        currency: 'USDT', basecurrency: ticker.replace(/USDT$/, ''), timezone: 'Etc/UTC', session: '24x7',
        mintick, minmove: 1, pricescale: Math.round(1 / mintick), pointvalue: 1,
      }
    },
    async getMarketData(t, tf, limit, sDate, eDate) {
      const ticker = cleanTicker(t)
      const sec = pineTfSec(tf)
      // свечи самого окна — уже загружены
      if (ticker === mainTicker && String(tf) === mainTf && !sDate) return pane.bars.map((b) => toKline(b, pane.intervalSec))
      if (!sec) return []
      // ближайший таймфрейм биржи, из которого можно собрать нужный
      const base = [...OUR].reverse().find(([, s]) => s <= sec && (sec >= 2592000 ? s === 86400 : sec % s === 0))
      if (!base) return []
      const [code, bsec] = base
      const end = eDate ? Math.floor(eDate / 1000) + sec : undefined
      const want = sDate && eDate ? Math.ceil((eDate - sDate) / 1000 / bsec) + 5 : (limit || 500) * (sec / bsec)
      let bars = await cachedCandles(pane.market, ticker, code, end, Math.min(1000, Math.max(50, Math.ceil(want))))
      if (bsec !== sec) bars = aggregate(bars, sec)
      return bars.map((b) => toKline(b, sec))
    },
  }
}


// данные request.security держим минуту, чтобы не скачивать их на каждом пересчёте
const cache = new Map()
async function cachedCandles(market, ticker, code, end, limit) {
  const key = `${market}|${ticker}|${code}|${limit}`
  const c = cache.get(key)
  const now = Date.now()
  if (c && now - c.at < 60_000 && (!end || end <= c.end)) return c.bars
  const bars = await loadCandles(market, ticker, code, undefined, limit)
  cache.set(key, { at: now, bars, end: Date.now() / 1000 + 60 })
  return bars
}

self.onmessage = async ({ data }) => {
  try {
    const pane = { ...data, intervalSec: data.sec, interval: Object.entries({ '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' }).find(([, v]) => v === data.interval)?.[0] }
    const pt = new PineTS(makeProvider(pane), data.symbol, data.interval, data.bars.length)
    pt.setMaxLoops?.(200000)
    const ctx = await pt.run(new Indicator(data.code, data.inputs))
    self.postMessage(JSON.parse(JSON.stringify({ plots: ctx.plots, indicator: ctx.indicator })))
  } catch (e) {
    self.postMessage({ error: String(e?.message || e) })
  }
}
