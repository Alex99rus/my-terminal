// Биржа Bybit: свечи, цены, живые данные. Ключи API не нужны — рыночные данные открыты всем.
// Функции отдают данные в том же виде, что и binance.js, поэтому остальной терминал
// не замечает разницы между биржами.

const REST = ['https://api.bybit.com', 'https://api.bytick.com'] // второй адрес — запасной
const CATEGORY = { spot: 'spot', futures: 'linear' } // linear — бессрочные фьючерсы в USDT
const WS = {
  spot: 'wss://stream.bybit.com/v5/public/spot',
  futures: 'wss://stream.bybit.com/v5/public/linear',
}
// Интервалы у Bybit называются по-своему
const INTERVAL = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' }

async function api(path) {
  let lastErr
  for (const base of REST) {
    try {
      const res = await fetch(base + path)
      if (!res.ok) throw new Error(`Bybit ответил ошибкой ${res.status}`)
      const json = await res.json()
      if (json.retCode !== 0) throw new Error(json.retMsg || 'Ошибка Bybit')
      return json.result
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

/** История свечей. Bybit отдаёт от новых к старым — разворачиваем */
export async function loadCandles(market, symbol, interval, endTime, limit = 1000) {
  let path = `/v5/market/kline?category=${CATEGORY[market]}&symbol=${symbol}&interval=${INTERVAL[interval]}&limit=${Math.min(limit, 1000)}`
  if (endTime) path += `&end=${endTime * 1000 - 1}`
  const rows = (await api(path)).list || []
  return rows.reverse().map((r) => ({ time: +r[0] / 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }))
}

// Цены за сутки — в том же виде, что у Binance (lastPrice, openPrice, quoteVolume, priceChangePercent)
const toTicker = (r) => ({
  symbol: r.symbol,
  lastPrice: r.lastPrice,
  openPrice: r.prevPrice24h,
  quoteVolume: r.turnover24h,
  priceChangePercent: String((+r.price24hPcnt || 0) * 100),
  highPrice: r.highPrice24h,
  lowPrice: r.lowPrice24h,
})

export async function loadTickers(market) {
  const rows = (await api(`/v5/market/tickers?category=${CATEGORY[market]}`)).list || []
  return rows
    .filter((r) => r.symbol.endsWith('USDT') && +r.turnover24h > 0)
    .map(toTicker)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
}

export async function loadTicker(market, symbol) {
  const r = (await api(`/v5/market/tickers?category=${CATEGORY[market]}&symbol=${symbol}`)).list?.[0]
  if (!r) throw new Error('нет данных')
  return toTicker(r)
}

/** Живая свеча и каждая сделка — как subscribeLive у Binance */
export function subscribeLive(market, symbol, interval, { onKline, onTrade, onStatus }) {
  return subscribe(market, [`kline.${INTERVAL[interval]}.${symbol}`, `publicTrade.${symbol}`], (msg) => {
    if (msg.topic.startsWith('kline.')) {
      for (const k of msg.data) {
        onKline({ time: k.start / 1000, open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: +k.volume }, msg.ts / 1000)
      }
    } else {
      for (const t of msg.data) onTrade(+t.p, +t.v, t.T / 1000)
    }
  }, onStatus)
}

/** Цены нескольких монет (для списка и оповещений) */
export function subscribeTickers(market, symbols, onTicker, onStatus) {
  // на фьючерсах после первого «снимка» приходят только изменившиеся поля — копим
  const state = {}
  return subscribe(market, symbols.map((s) => `tickers.${s}`), (msg) => {
    const d = msg.data
    if (!d?.symbol) return
    const s = (state[d.symbol] ||= {})
    Object.assign(s, d)
    if (s.lastPrice === undefined) return
    onTicker({ symbol: d.symbol, last: +s.lastPrice, open: +s.prevPrice24h, quoteVolume: +s.turnover24h })
  }, onStatus)
}

// Общая часть: подключиться, подписаться (не больше 10 тем за раз — лимит спота),
// раз в 20 секунд «пинговать» (иначе Bybit закрывает соединение), переподключаться при обрыве
function subscribe(market, topics, onData, onStatus) {
  let ws
  let stopped = false
  let retryTimer
  let pingTimer

  function connect() {
    ws = new WebSocket(WS[market])
    ws.onopen = () => {
      onStatus?.('')
      for (let i = 0; i < topics.length; i += 10) ws.send(JSON.stringify({ op: 'subscribe', args: topics.slice(i, i + 10) }))
      pingTimer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ op: 'ping' })), 20_000)
    }
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.topic && msg.data) onData(msg)
    }
    ws.onclose = () => {
      clearInterval(pingTimer)
      if (stopped) return
      onStatus?.('Связь с Bybit потеряна, переподключаюсь…')
      retryTimer = setTimeout(connect, 1500)
    }
  }

  connect()
  return () => {
    stopped = true
    clearTimeout(retryTimer)
    clearInterval(pingTimer)
    ws?.close()
  }
}
