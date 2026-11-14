// Демо-счёт: виртуальная торговля на настоящих живых ценах.
//
// Всё хранится в браузере. Правила как у фьючерсов в одностороннем режиме:
// по каждой монете одна позиция (лонг или шорт); сделка в обратную сторону её уменьшает,
// закрывает или переворачивает. Комиссия берётся с каждой сделки от её объёма в $.
// Ордера: рыночный (сразу по текущей цене), лимитный (когда цена дойдёт до указанной или лучше),
// стоп (когда цена пробьёт указанную). У позиции могут быть стоп-лосс и тейк-профит —
// они закрывают её целиком по своей цене.
import { subscribeTickers } from './binance.js'

const STORAGE = 'my-terminal-paper'
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

const DEFAULT = {
  start: 10000, // стартовый баланс, $
  balance: 10000, // деньги без учёта открытых позиций (с учётом закрытых сделок и комиссий)
  fee: 0.05, // комиссия, % от объёма сделки
  leverage: 10,
  positions: [], // { key, side: 'long' | 'short', qty, entry, sl, tp, opened }
  orders: [], // { id, key, side: 'buy' | 'sell', type: 'limit' | 'stop', price, qty, sl, tp, created }
  history: [], // { key, side, qty, entry, exit, pnl, fee, opened, closed, reason }
}

let acc
try {
  acc = { ...DEFAULT, ...JSON.parse(localStorage.getItem(STORAGE)) }
} catch {
  acc = { ...DEFAULT }
}

const prices = new Map() // 'futures:BTCUSDT' → последняя цена
const liveAt = new Map() // когда цена пришла из открытого окна (она свежее секундной)
const listeners = new Set()
let notify = () => {} // сообщения пользователю (сработал стоп и т. п.)

function save() {
  localStorage.setItem(STORAGE, JSON.stringify(acc))
}
function emit(kind = 'change') {
  for (const fn of listeners) fn(kind)
}
const changed = () => {
  save()
  emit('change')
  resubscribe()
}

const splitKey = (key) => {
  const [market, symbol] = key.split(':')
  return { market, symbol }
}
const pnlOf = (p, price) => (p.side === 'long' ? price - p.entry : p.entry - price) * p.qty

// ---------- Сделка (исполнение) ----------

// Исполнить сделку: side 'buy' / 'sell', qty монет по цене price. Возвращает текст или null.
function fill(key, side, qty, price, reason, extra = {}) {
  const fee = (qty * price * acc.fee) / 100
  acc.balance -= fee
  const dir = side === 'buy' ? 'long' : 'short'
  const pos = acc.positions.find((p) => p.key === key)

  if (!pos) {
    acc.positions.push({ key, side: dir, qty, entry: price, sl: extra.sl ?? null, tp: extra.tp ?? null, opened: Date.now(), fees: fee })
    return
  }
  if (pos.side === dir) {
    // добавили к позиции — средняя цена входа
    pos.entry = (pos.entry * pos.qty + price * qty) / (pos.qty + qty)
    pos.qty += qty
    pos.fees = (pos.fees || 0) + fee
    if (extra.sl != null) pos.sl = extra.sl
    if (extra.tp != null) pos.tp = extra.tp
    return
  }
  // в обратную сторону: уменьшаем, закрываем или переворачиваем
  const closeQty = Math.min(qty, pos.qty)
  const part = closeQty / pos.qty
  const pnl = pnlOf({ ...pos, qty: closeQty }, price)
  const posFees = (pos.fees || 0) * part
  acc.balance += pnl
  acc.history.unshift({
    key, side: pos.side, qty: closeQty, entry: pos.entry, exit: price,
    pnl, fee: posFees + fee * (closeQty / qty), opened: pos.opened, closed: Date.now(), reason,
  })
  if (acc.history.length > 500) acc.history.length = 500
  pos.qty -= closeQty
  pos.fees = (pos.fees || 0) - posFees
  if (pos.qty <= 1e-12) acc.positions = acc.positions.filter((p) => p !== pos)
  const rest = qty - closeQty
  if (rest > 1e-12) {
    acc.positions.push({ key, side: dir, qty: rest, entry: price, sl: extra.sl ?? null, tp: extra.tp ?? null, opened: Date.now(), fees: fee * (rest / qty) })
  }
}

// ---------- Проверка по новой цене ----------

function onPrice(key, price, source = 'live') {
  if (source === 'live') liveAt.set(key, Date.now())
  else if (Date.now() - (liveAt.get(key) || 0) < 5000) return
  prices.set(key, price)
  let touched = false

  // ордера
  for (const o of [...acc.orders]) {
    if (o.key !== key) continue
    const hit = o.type === 'limit'
      ? (o.side === 'buy' ? price <= o.price : price >= o.price)
      : (o.side === 'buy' ? price >= o.price : price <= o.price)
    if (!hit) continue
    acc.orders = acc.orders.filter((x) => x !== o)
    // лимитный исполняется по своей цене, стоп — по рынку (текущей цене)
    const at = o.type === 'limit' ? o.price : price
    fill(key, o.side, o.qty, at, 'Ордер', { sl: o.sl, tp: o.tp })
    notify(`💼 Исполнен ${o.type === 'limit' ? 'лимитный' : 'стоп'} ордер: ${o.side === 'buy' ? 'покупка' : 'продажа'} ${fmtQty(o.qty)} ${splitKey(key).symbol} по ${fmtPrice(at)}`)
    touched = true
  }

  // стоп-лосс и тейк-профит позиции
  const pos = acc.positions.find((p) => p.key === key)
  if (pos) {
    const long = pos.side === 'long'
    const slHit = pos.sl != null && (long ? price <= pos.sl : price >= pos.sl)
    const tpHit = pos.tp != null && (long ? price >= pos.tp : price <= pos.tp)
    if (slHit || tpHit) {
      const at = slHit ? pos.sl : pos.tp
      const qty = pos.qty
      const pnl = pnlOf(pos, at)
      fill(key, long ? 'sell' : 'buy', qty, at, slHit ? 'Стоп-лосс' : 'Тейк-профит')
      notify(`💼 ${slHit ? 'Стоп-лосс' : 'Тейк-профит'} ${splitKey(key).symbol}: ${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}`)
      touched = true
    }
  }

  if (touched) changed()
  else emit('price')
}

// Цены монет с позициями и ордерами — раз в секунду, даже если монета не открыта в окне
let subs = []
let subsSig = ''
function resubscribe() {
  const byMarket = {}
  for (const k of [...acc.positions.map((p) => p.key), ...acc.orders.map((o) => o.key)]) {
    const { market, symbol } = splitKey(k)
    ;(byMarket[market] ||= new Set()).add(symbol)
  }
  const sig = JSON.stringify(Object.entries(byMarket).map(([m, s]) => [m, [...s].sort()]).sort())
  if (sig === subsSig) return
  subsSig = sig
  for (const off of subs) off()
  subs = Object.entries(byMarket).map(([market, set]) =>
    subscribeTickers(market, [...set], (t) => onPrice(`${market}:${t.symbol}`, t.last, 'ticker')),
  )
}

// ---------- Форматы ----------
function decimalsFor(price) {
  if (price >= 1000) return 2
  if (price >= 1) return 4
  if (price >= 0.01) return 6
  return 8
}
export const fmtPrice = (p) => p.toLocaleString('ru-RU', { minimumFractionDigits: decimalsFor(p), maximumFractionDigits: decimalsFor(p) })
export const fmtUsd = (v) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $'
export const fmtQty = (q) => (q >= 100 ? Math.round(q).toLocaleString('ru-RU') : q.toLocaleString('ru-RU', { maximumSignificantDigits: 5 }))

// ---------- Что видно снаружи ----------

export const paper = {
  get account() {
    return acc
  },
  price: (key) => prices.get(key),
  onPrice,
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  init({ onNotify }) {
    notify = onNotify
    resubscribe()
  },

  // сводка: баланс, нереализованная прибыль, капитал, занятая маржа
  summary() {
    let upnl = 0
    let margin = 0
    for (const p of acc.positions) {
      const px = prices.get(p.key) ?? p.entry
      upnl += pnlOf(p, px)
      margin += (p.qty * p.entry) / acc.leverage
    }
    const equity = acc.balance + upnl
    return { balance: acc.balance, upnl, equity, margin, free: equity - margin, total: equity - acc.start }
  },
  pnl(p) {
    return pnlOf(p, prices.get(p.key) ?? p.entry)
  },

  /**
   * Новый ордер. type: 'market' | 'limit' | 'stop'. Возвращает текст ошибки или ''.
   */
  placeOrder({ key, side, type, qty, price, sl, tp }) {
    const last = prices.get(key)
    if (!(qty > 0)) return 'Укажите количество'
    if (type !== 'market' && !(price > 0)) return 'Укажите цену ордера'
    if (type === 'market' && !last) return 'Нет текущей цены — подождите секунду'
    const px = type === 'market' ? last : price
    // хватает ли денег (маржи) — только на увеличение позиции
    const pos = acc.positions.find((p) => p.key === key)
    const adds = !pos || (pos.side === 'long') === (side === 'buy') ? qty : Math.max(0, qty - pos.qty)
    const need = (adds * px) / acc.leverage
    if (need > this.summary().free + 1e-9) return `Не хватает средств: нужно ${fmtUsd(need)} маржи, свободно ${fmtUsd(this.summary().free)}`
    // стоп и тейк должны стоять с правильной стороны
    const long = side === 'buy'
    if (sl != null && (long ? sl >= px : sl <= px)) return `Стоп-лосс для ${long ? 'покупки' : 'продажи'} должен быть ${long ? 'ниже' : 'выше'} цены входа`
    if (tp != null && (long ? tp <= px : tp >= px)) return `Тейк-профит для ${long ? 'покупки' : 'продажи'} должен быть ${long ? 'выше' : 'ниже'} цены входа`

    if (type === 'market') {
      fill(key, side, qty, last, 'Рынок', { sl, tp })
    } else {
      // лимитный ордер «не по ту сторону» цены исполнился бы сразу — подскажем
      if (last && type === 'limit' && (long ? price > last : price < last)) {
        return `Лимитная ${long ? 'покупка' : 'продажа'} должна быть ${long ? 'ниже' : 'выше'} текущей цены (${fmtPrice(last)}). Для входа на пробое выберите «Стоп»`
      }
      if (last && type === 'stop' && (long ? price < last : price > last)) {
        return `Стоп-${long ? 'покупка' : 'продажа'} должна быть ${long ? 'выше' : 'ниже'} текущей цены (${fmtPrice(last)}). Для входа на откате выберите «Лимит»`
      }
      acc.orders.push({ id: uid(), key, side, type, price, qty, sl, tp, created: Date.now() })
    }
    changed()
    return ''
  },

  cancelOrder(id) {
    acc.orders = acc.orders.filter((o) => o.id !== id)
    changed()
  },
  moveOrder(id, price) {
    const o = acc.orders.find((x) => x.id === id)
    if (o) o.price = price
    changed()
  },

  // закрыть позицию по рынку целиком (part = 1) или частью
  close(key, part = 1) {
    const pos = acc.positions.find((p) => p.key === key)
    const last = prices.get(key)
    if (!pos || !last) return
    fill(key, pos.side === 'long' ? 'sell' : 'buy', pos.qty * part, last, 'Вручную')
    changed()
  },
  setStops(key, { sl, tp }) {
    const pos = acc.positions.find((p) => p.key === key)
    if (!pos) return
    if (sl !== undefined) pos.sl = sl
    if (tp !== undefined) pos.tp = tp
    changed()
  },

  setSettings({ start, fee, leverage }) {
    if (fee != null) acc.fee = fee
    if (leverage != null) acc.leverage = leverage
    if (start != null) {
      acc.balance += start - acc.start
      acc.start = start
    }
    changed()
  },
  reset(start = acc.start) {
    acc = { ...DEFAULT, start, balance: start, fee: acc.fee, leverage: acc.leverage, positions: [], orders: [], history: [] }
    changed()
  },

  // Линии для графика монеты key: вход позиции, стоп, тейк, ордера
  lines(key) {
    const out = []
    const pos = acc.positions.find((p) => p.key === key)
    if (pos) {
      const pnl = this.pnl(pos)
      out.push({ id: 'entry', price: pos.entry, color: pnl >= 0 ? '#26a69a' : '#ef5350', title: `${pos.side === 'long' ? 'Лонг' : 'Шорт'} ${fmtQty(pos.qty)} · ${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}` })
      if (pos.sl != null) out.push({ id: 'sl', price: pos.sl, color: '#ef5350', title: `Стоп ${fmtUsd(pnlOf(pos, pos.sl))}`, drag: (p) => this.setStops(key, { sl: p }) })
      if (pos.tp != null) out.push({ id: 'tp', price: pos.tp, color: '#26a69a', title: `Тейк +${fmtUsd(pnlOf(pos, pos.tp))}`, drag: (p) => this.setStops(key, { tp: p }) })
    }
    for (const o of acc.orders) {
      if (o.key !== key) continue
      out.push({
        id: 'o' + o.id, price: o.price, color: '#2962ff',
        title: `${o.type === 'limit' ? 'Лимит' : 'Стоп'} ${o.side === 'buy' ? 'покупка' : 'продажа'} ${fmtQty(o.qty)}`,
        drag: (p) => this.moveOrder(o.id, p),
      })
    }
    return out
  },
}
