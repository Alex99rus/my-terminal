// Московская биржа (ИСС — информационно-статистический сервер биржи, iss.moex.com).
// Бесплатно и без регистрации, но данные приходят С ЗАДЕРЖКОЙ 15 МИНУТ: без задержки биржа
// отдаёт их только по платной подписке. Поэтому в окнах графиков показывается пометка о задержке.
//
// Функции отдают данные в том же виде, что и binance.js, — остальной терминал разницы не замечает.
// Отличия от криптобирж:
//  • нет живого потока сделок — новые свечи спрашиваем раз в 10 секунд;
//  • биржа даёт свечи 1 мин, 10 мин, 1 час, день, неделя. Остальные (5м, 15м, 30м, 4ч) собираем сами;
//  • время у биржи московское — переводим во всемирное (UTC), как у всех данных терминала.

const ISS = 'https://iss.moex.com/iss'
export const MOEX_DELAY_NOTE =
  'Данные Московской биржи — с задержкой 15 минут: без задержки биржа отдаёт их только по платной подписке'

// Рынки терминала → разделы биржи
const SECTIONS = {
  shares: { engine: 'stock', market: 'shares', board: 'TQBR', prev: 'PREVPRICE' }, // акции, основной режим торгов
  futures: { engine: 'futures', market: 'forts', board: 'RFUD', prev: 'PREVSETTLEPRICE' }, // срочный рынок
}

// Интервал терминала → { интервал биржи, его длина в секундах }
const BASE = {
  '1m': { code: 1, sec: 60 },
  '5m': { code: 1, sec: 60 },
  '15m': { code: 1, sec: 60 },
  '30m': { code: 10, sec: 600 },
  '1h': { code: 60, sec: 3600 },
  '4h': { code: 60, sec: 3600 },
  '1d': { code: 24, sec: 86400 },
  '1w': { code: 7, sec: 604800 },
}
const SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 }
const PAGE = 500 // столько свечей биржа отдаёт за один запрос
const MAX_ROWS = 4000 // больше за раз не просим, чтобы не ждать долго

async function get(path) {
  const res = await fetch(ISS + path + (path.includes('?') ? '&' : '?') + 'iss.meta=off')
  if (!res.ok) throw new Error(`Мосбиржа ответила ошибкой ${res.status}`)
  return res.json()
}
// Таблица ИСС ({ columns, data }) → массив объектов
const rowsOf = (table) => (table?.data || []).map((r) => Object.fromEntries(table.columns.map((c, i) => [c, r[i]])))

// '2026-11-14 10:00:00' (Москва, UTC+3) → секунды UTC
const mskToUtc = (s) => {
  const [d, t = '00:00:00'] = s.split(' ')
  const [Y, M, D] = d.split('-').map(Number)
  const [h, m, sec] = t.split(':').map(Number)
  return Date.UTC(Y, M - 1, D, h, m, sec) / 1000 - 3 * 3600
}
// дата для параметра till: день по Москве
const mskDate = (utcSec) => new Date((utcSec + 3 * 3600) * 1000).toISOString().slice(0, 10)

// ---------- Список бумаг и цены ----------
const listCache = new Map() // рынок → { at, promise }

async function fetchList(market) {
  const s = SECTIONS[market]
  const json = await get(`/engines/${s.engine}/markets/${s.market}/boards/${s.board}/securities.json?iss.only=securities,marketdata`)
  const md = new Map(rowsOf(json.marketdata).map((r) => [r.SECID, r]))
  return rowsOf(json.securities)
    .map((sec) => {
      const m = md.get(sec.SECID) || {}
      const prev = +sec[s.prev] || +sec.PREVPRICE || +sec.PREVLEGALCLOSEPRICE || 0
      const last = +m.LAST || +m.LCURRENTPRICE || +m.MARKETPRICE || +m.SETTLEPRICE || prev
      if (!last) return null
      return {
        symbol: sec.SECID,
        name: sec.SHORTNAME || sec.SECNAME || sec.SECID,
        lastPrice: String(last),
        openPrice: String(prev || last), // «изменение за сутки» у Мосбиржи — к закрытию прошлого дня
        priceChangePercent: String(prev ? ((last - prev) / prev) * 100 : 0),
        highPrice: String(+m.HIGH || last),
        lowPrice: String(+m.LOW || last),
        quoteVolume: String(+m.VALTODAY || 0), // оборот за день, ₽
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
}

export function loadTickers(market, maxAge = 5000) {
  const c = listCache.get(market)
  if (c && Date.now() - c.at < maxAge) return c.promise
  const promise = fetchList(market)
  promise.catch(() => listCache.delete(market))
  listCache.set(market, { at: Date.now(), promise })
  return promise
}

export async function loadTicker(market, symbol) {
  const list = await loadTickers(market)
  const t = list.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase())
  if (!t) throw new Error('нет данных')
  return t
}

// У фьючерсов в названии есть строчные буквы (SiZ6), а в поле ввода пишут как угодно — находим настоящее
async function realId(market, symbol) {
  try {
    const list = await loadTickers(market, 600_000)
    return list.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase())?.symbol || symbol
  } catch {
    return symbol
  }
}

// ---------- Свечи ----------
async function fetchPage(market, symbol, code, till, start) {
  const s = SECTIONS[market]
  let path = `/engines/${s.engine}/markets/${s.market}/boards/${s.board}/securities/${symbol}/candles.json?interval=${code}&iss.reverse=true&start=${start}`
  if (till) path += `&till=${till}`
  const json = await get(path)
  return rowsOf(json.candles)
}

const toBar = (r, daily) => {
  // дневные и недельные свечи ставим на полночь UTC нужной даты — как у криптобирж
  const time = daily ? Date.UTC(...r.begin.slice(0, 10).split('-').map((v, i) => (i === 1 ? v - 1 : +v))) / 1000 : mskToUtc(r.begin)
  return { time, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume || 0 }
}

// Склеить мелкие свечи в крупные (например, 1-минутные в 15-минутные)
function aggregate(bars, sec) {
  const out = []
  for (const b of bars) {
    const t = Math.floor(b.time / sec) * sec
    const last = out.at(-1)
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high)
      last.low = Math.min(last.low, b.low)
      last.close = b.close
      last.volume += b.volume
    } else out.push({ ...b, time: t })
  }
  return out
}

async function loadForward(market, symbol, base, need, endTime) {
  const s = SECTIONS[market]
  const end = endTime || Date.now() / 1000
  // торги идут примерно 15 часов в сутки — берём окно с запасом
  const days = base.sec >= 86400 ? Math.ceil((need * base.sec) / 86400) + 7 : Math.ceil((need * base.sec) / (12 * 3600)) + 4
  const from = mskDate(end - days * 86400)
  const out = []
  for (let start = 0; start < 40 * PAGE; start += PAGE) {
    const json = await get(`/engines/${s.engine}/markets/${s.market}/boards/${s.board}/securities/${symbol}/candles.json?interval=${base.code}&from=${from}&till=${mskDate(end)}&start=${start}`)
    const rows = rowsOf(json.candles)
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

/** История свечей до endTime (не включая), от старых к новым */
export async function loadCandles(market, symbol, interval, endTime, limit = 1000) {
  symbol = await realId(market, symbol)
  const base = BASE[interval]
  const sec = SEC[interval]
  const factor = sec / base.sec
  const daily = base.sec >= 86400
  const need = Math.min(MAX_ROWS, Math.ceil(limit * factor) + factor)
  const pages = Math.ceil(need / PAGE)
  const till = endTime ? mskDate(endTime) : ''
  // страницы просим одновременно: биржа отдаёт от новых свечей к старым
  let results = await Promise.all(Array.from({ length: pages }, (_, i) => fetchPage(market, symbol, base.code, till, i * PAGE)))
  // на случай, если биржа перестанет понимать «от новых к старым»: тогда берём окно дат и листаем вперёд
  const first = results[0]
  if (first.length > 1 && first[0].begin < first.at(-1).begin) results = [await loadForward(market, symbol, base, need, endTime)]
  let bars = results
    .flat()
    .map((r) => toBar(r, daily))
    .filter((b) => !endTime || b.time < endTime)
    .sort((a, b) => a.time - b.time)
  bars = bars.filter((b, i) => i === 0 || b.time !== bars[i - 1].time)
  if (factor > 1) {
    const full = results.at(-1).length === PAGE // история ещё есть — самая старая свеча может быть неполной
    bars = aggregate(bars, sec)
    if (full && bars.length > 1) bars.shift()
  }
  return bars.slice(-limit)
}

// ---------- «Живые» данные: раз в 10 секунд спрашиваем свежие свечи ----------
export function subscribeLive(market, symbol, interval, { onKline, onStatus }) {
  let stopped = false
  let timer = 0
  const sec = SEC[interval]
  const base = BASE[interval]
  const daily = base.sec >= 86400
  async function poll() {
    try {
      const id = await realId(market, symbol)
      const rows = await fetchPage(market, id, base.code, '', 0)
      if (stopped) return
      let bars = rows.map((r) => toBar(r, daily)).sort((a, b) => a.time - b.time)
      if (sec !== base.sec) {
        const from = Math.floor(bars.at(-1)?.time / sec) * sec - sec // две последние крупные свечи целиком
        bars = aggregate(bars.filter((b) => b.time >= from), sec)
      }
      const now = Date.now() / 1000
      for (const b of bars.slice(-2)) onKline(b, now)
      onStatus?.('')
    } catch {
      if (!stopped) onStatus?.('Нет связи с Мосбиржей, пробую ещё раз…')
    }
    if (!stopped) timer = setTimeout(poll, 10_000)
  }
  timer = setTimeout(poll, 3000)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/** Цены нескольких бумаг (для списка и оповещений) — раз в 15 секунд */
export function subscribeTickers(market, symbols, onTicker, onStatus) {
  let stopped = false
  let timer = 0
  const want = new Map(symbols.map((s) => [s.toUpperCase(), s])) // отвечаем тем же написанием, что спросили
  async function poll() {
    try {
      const list = await loadTickers(market)
      if (stopped) return
      for (const t of list)
        if (want.has(t.symbol.toUpperCase()))
          onTicker({ symbol: want.get(t.symbol.toUpperCase()), last: +t.lastPrice, open: +t.openPrice, quoteVolume: +t.quoteVolume })
      onStatus?.('')
    } catch {
      onStatus?.('Нет связи с Мосбиржей')
    }
    if (!stopped) timer = setTimeout(poll, 15_000)
  }
  poll()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
