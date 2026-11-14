// Всё общение с биржей Binance — в этом файле.
// Ключи API не нужны: рыночные данные биржа отдаёт бесплатно всем.

// Адреса биржи. Для спота — официальный адрес «только рыночные данные».
const REST = {
  spot: 'https://data-api.binance.vision/api/v3',
  futures: 'https://fapi.binance.com/fapi/v1',
}
// Адреса потоков. В одном соединении можно слушать несколько потоков сразу.
// Фьючерсы: рыночные данные Binance теперь отдаёт по адресу /market, старый адрес оставлен запасным.
const WS_URLS = {
  spot: ['wss://data-stream.binance.vision/stream', 'wss://stream.binance.com:443/stream'],
  futures: ['wss://fstream.binance.com/market/stream', 'wss://fstream.binance.com/stream'],
}

// Превращает строку свечи из ответа биржи в объект, понятный графику.
// Биржа присылает время в миллисекундах, а график хочет секунды.
function toBar(row) {
  return {
    time: row[0] / 1000,
    open: +row[1],
    high: +row[2],
    low: +row[3],
    close: +row[4],
    volume: +row[5],
  }
}

/**
 * Загружает историю свечей (REST-запрос).
 * endTime — если указать, придут свечи ДО этого момента (для подгрузки истории влево).
 */
export async function loadCandles(market, symbol, interval, endTime, limit = 1000) {
  let url = `${REST[market]}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  if (endTime) url += `&endTime=${endTime * 1000 - 1}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Биржа ответила ошибкой ${res.status}`)
  const rows = await res.json()
  return rows.map(toBar)
}

/** Список всех монет к USDT с ценой и изменением за сутки — для подсказок в поиске */
export async function loadTickers(market) {
  const res = await fetch(`${REST[market]}/ticker/24hr`)
  if (!res.ok) throw new Error(`Биржа ответила ошибкой ${res.status}`)
  const list = await res.json()
  return list
    .filter((t) => t.symbol.endsWith('USDT') && +t.quoteVolume > 0)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
}

/** Данные за сутки по одной монете: изменение цены в % */
export async function loadTicker(market, symbol) {
  const res = await fetch(`${REST[market]}/ticker/24hr?symbol=${symbol}`)
  if (!res.ok) throw new Error(`Биржа ответила ошибкой ${res.status}`)
  return res.json()
}

/**
 * Живые данные по WebSocket (постоянное соединение, по которому биржа сама присылает новости).
 * В одном соединении два потока:
 *   kline    — готовая свеча от биржи (раз в 0,25–2 секунды): точный объём, начало новой свечи
 *   aggTrade — каждая сделка (спот — сразу, фьючерсы — пачками раз в 0,1 секунды): самая свежая цена
 *
 * У биржи несколько адресов. Если подключились, но за 8 секунд по адресу не пришло ни одного
 * сообщения (так бывает, когда биржа переносит потоки на новый адрес), пробуем следующий адрес.
 * Возвращает функцию «отписаться».
 */
export function subscribeLive(market, symbol, interval, { onKline, onTrade, onStatus }) {
  const s = symbol.toLowerCase()
  return subscribeStreams(market, [`${s}@kline_${interval}`, `${s}@aggTrade`], (msg) => {
    if (msg.e === 'aggTrade') {
      onTrade(+msg.p, +msg.q, msg.T / 1000)
    } else if (msg.e === 'kline') {
      const k = msg.k
      onKline(
        { time: k.t / 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v },
        msg.E / 1000, // когда биржа отправила эту свечу
      )
    }
  }, onStatus)
}

/**
 * Цены нескольких монет раз в секунду — для списка монет.
 * onTicker получает { symbol, last, open, quoteVolume } (изменение за 24 часа = last к open).
 */
export function subscribeTickers(market, symbols, onTicker, onStatus) {
  const streams = symbols.map((s) => `${s.toLowerCase()}@miniTicker`)
  return subscribeStreams(market, streams, (t) => {
    if (t.e !== '24hrMiniTicker') return
    onTicker({ symbol: t.s, last: +t.c, open: +t.o, quoteVolume: +t.q })
  }, onStatus)
}

/**
 * Общая часть: подключиться, подписаться на потоки streams, отдавать сообщения в onData.
 * Если связь оборвалась — переподключаемся; если по адресу 8 секунд тишина — пробуем другой адрес.
 */
function subscribeStreams(market, streams, onData, onStatus) {
  const urls = WS_URLS[market]
  let urlIndex = 0
  let ws
  let stopped = false
  let retryTimer
  let silenceTimer

  // Если по адресу так ничего и не пришло — это «мёртвый» адрес, переключаемся
  function watchSilence() {
    silenceTimer = setTimeout(() => {
      onStatus?.('Нет живых цен, пробую другой адрес биржи…')
      urlIndex++
      ws?.close()
    }, 8000)
  }

  function connect() {
    const url = urls[urlIndex % urls.length]
    ws = new WebSocket(url)
    ws.onopen = () => {
      ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: streams, id: 1 }))
      watchSilence()
    }
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data).data
      if (!msg) return // ответ на SUBSCRIBE и прочие служебные сообщения
      if (silenceTimer) {
        clearTimeout(silenceTimer) // данные пошли — адрес рабочий
        silenceTimer = 0
        onStatus?.('')
      }
      onData(msg)
    }
    ws.onclose = () => {
      clearTimeout(silenceTimer)
      silenceTimer = 0
      if (stopped) return
      onStatus?.('Связь с биржей потеряна, переподключаюсь…')
      retryTimer = setTimeout(connect, 1500)
    }
    ws.onerror = () => urlIndex++ // не получилось подключиться — в следующий раз другой адрес
  }

  connect()

  return () => {
    stopped = true
    clearTimeout(retryTimer)
    clearTimeout(silenceTimer)
    ws?.close()
  }
}
