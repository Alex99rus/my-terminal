// Умные оповещения: по индикаторам, по закрытию свечи, по движению цены,
// а также оповещения на рисунках «по закрытию свечи».
//
// Как работает: раз в 10 секунд для каждой нужной пары «монета + таймфрейм» загружаем
// последние 300 свечей и проверяем условия. Условие — это «да/нет» (например, «RSI выше 70»).
// Оповещение срабатывает в момент, когда «нет» сменилось на «да».
import { loadCandles } from './binance.js'
import { INTERVALS } from './pane.js'
import { ema, sma, INDICATORS } from './indicators.js'
import { draw, drawingLevels, DRAWING_NAMES } from './drawings.js'

const STORAGE = 'my-terminal-smart-alerts'
const POLL_MS = 10_000
const COOLDOWN_MS = 60_000 // «каждый раз» — не чаще раза в минуту

const tfSec = (tf) => INTERVALS.find((i) => i.code === tf)?.sec || 3600
const tfLabel = (tf) => INTERVALS.find((i) => i.code === tf)?.label || tf
function decimalsFor(price) {
  if (price >= 1000) return 2
  if (price >= 1) return 4
  if (price >= 0.01) return 6
  return 8
}
const fmt = (p) => p.toLocaleString('ru-RU', { minimumFractionDigits: decimalsFor(p), maximumFractionDigits: decimalsFor(p) })
const num = (v) => (+v).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const closes = (bars) => bars.map((b) => b.close)

// ---------- Виды условий ----------
// params: имя → [подпись, значение по умолчанию, варианты (для выпадающего списка)]
// tf: false — таймфрейм не выбирается; closeOnly — проверяется только по закрытой свече
// state(bars, i, p) — выполнено ли условие на свече i; text(p) — описание для списка и сообщения
export const KINDS = {
  rsi_above: {
    group: 'Индикаторы', label: 'RSI поднялся выше уровня',
    params: { length: ['Период RSI', 14], level: ['Уровень', 70] },
    state: (bars, i, p) => {
      const v = INDICATORS.rsi.calc(bars, p).v[i]
      return v == null ? null : v > p.level
    },
    text: (p) => `RSI ${p.length} выше ${num(p.level)}`,
  },
  rsi_below: {
    group: 'Индикаторы', label: 'RSI опустился ниже уровня',
    params: { length: ['Период RSI', 14], level: ['Уровень', 30] },
    state: (bars, i, p) => {
      const v = INDICATORS.rsi.calc(bars, p).v[i]
      return v == null ? null : v < p.level
    },
    text: (p) => `RSI ${p.length} ниже ${num(p.level)}`,
  },
  ema_cross_up: {
    group: 'Индикаторы', label: 'EMA быстрая пересекла медленную вверх',
    params: { fast: ['Быстрая EMA', 20], slow: ['Медленная EMA', 50] },
    state: (bars, i, p) => {
      const c = closes(bars)
      const f = ema(c, p.fast)[i]
      const s = ema(c, p.slow)[i]
      return f == null || s == null ? null : f > s
    },
    text: (p) => `EMA ${p.fast} пересекла EMA ${p.slow} вверх`,
  },
  ema_cross_down: {
    group: 'Индикаторы', label: 'EMA быстрая пересекла медленную вниз',
    params: { fast: ['Быстрая EMA', 20], slow: ['Медленная EMA', 50] },
    state: (bars, i, p) => {
      const c = closes(bars)
      const f = ema(c, p.fast)[i]
      const s = ema(c, p.slow)[i]
      return f == null || s == null ? null : f < s
    },
    text: (p) => `EMA ${p.fast} пересекла EMA ${p.slow} вниз`,
  },
  price_above_ma: {
    group: 'Индикаторы', label: 'Цена пересекла среднюю вверх',
    params: { ma: ['Средняя', 'EMA', ['EMA', 'SMA']], length: ['Период', 200] },
    state: (bars, i, p) => {
      const m = (p.ma === 'SMA' ? sma : ema)(closes(bars), p.length)[i]
      return m == null ? null : bars[i].close > m
    },
    text: (p) => `Цена выше ${p.ma} ${p.length}`,
  },
  price_below_ma: {
    group: 'Индикаторы', label: 'Цена пересекла среднюю вниз',
    params: { ma: ['Средняя', 'EMA', ['EMA', 'SMA']], length: ['Период', 200] },
    state: (bars, i, p) => {
      const m = (p.ma === 'SMA' ? sma : ema)(closes(bars), p.length)[i]
      return m == null ? null : bars[i].close < m
    },
    text: (p) => `Цена ниже ${p.ma} ${p.length}`,
  },
  macd_cross_up: {
    group: 'Индикаторы', label: 'MACD пересёк сигнальную вверх',
    params: { fast: ['Быстрая', 12], slow: ['Медленная', 26], signal: ['Сигнальная', 9] },
    state: (bars, i, p) => {
      const r = INDICATORS.macd.calc(bars, p)
      return r.macd[i] == null || r.signal[i] == null ? null : r.macd[i] > r.signal[i]
    },
    text: (p) => `MACD ${p.fast} ${p.slow} ${p.signal} пересёк сигнальную вверх`,
  },
  macd_cross_down: {
    group: 'Индикаторы', label: 'MACD пересёк сигнальную вниз',
    params: { fast: ['Быстрая', 12], slow: ['Медленная', 26], signal: ['Сигнальная', 9] },
    state: (bars, i, p) => {
      const r = INDICATORS.macd.calc(bars, p)
      return r.macd[i] == null || r.signal[i] == null ? null : r.macd[i] < r.signal[i]
    },
    text: (p) => `MACD ${p.fast} ${p.slow} ${p.signal} пересёк сигнальную вниз`,
  },
  stoch_above: {
    group: 'Индикаторы', label: 'Стохастик поднялся выше уровня',
    params: { k: ['%K', 14], d: ['%D', 3], smooth: ['Сглаживание', 3], level: ['Уровень', 80] },
    state: (bars, i, p) => {
      const v = INDICATORS.stoch.calc(bars, p).k[i]
      return v == null ? null : v > p.level
    },
    text: (p) => `Стохастик выше ${num(p.level)}`,
  },
  stoch_below: {
    group: 'Индикаторы', label: 'Стохастик опустился ниже уровня',
    params: { k: ['%K', 14], d: ['%D', 3], smooth: ['Сглаживание', 3], level: ['Уровень', 20] },
    state: (bars, i, p) => {
      const v = INDICATORS.stoch.calc(bars, p).k[i]
      return v == null ? null : v < p.level
    },
    text: (p) => `Стохастик ниже ${num(p.level)}`,
  },
  close_above: {
    group: 'Закрытие свечи', label: 'Свеча закрылась выше цены', closeOnly: true,
    params: { level: ['Цена', 0] },
    state: (bars, i, p) => bars[i].close > p.level,
    text: (p) => `закрытие выше ${fmt(+p.level)}`,
  },
  close_below: {
    group: 'Закрытие свечи', label: 'Свеча закрылась ниже цены', closeOnly: true,
    params: { level: ['Цена', 0] },
    state: (bars, i, p) => bars[i].close < p.level,
    text: (p) => `закрытие ниже ${fmt(+p.level)}`,
  },
  pct_move: {
    group: 'Движение цены', label: 'Цена изменилась на X% за N минут', tf: false, fixedTf: '1m',
    params: { pct: ['Процент', 2], minutes: ['За минут', 15], dir: ['Направление', 'любое', ['любое', 'рост', 'падение']] },
    state: (bars, i, p) => {
      const back = bars[i - Math.round(p.minutes)]
      if (!back) return null
      const chg = ((bars[i].close - back.close) / back.close) * 100
      if (p.dir === 'рост') return chg >= p.pct
      if (p.dir === 'падение') return chg <= -p.pct
      return Math.abs(chg) >= p.pct
    },
    text: (p) => `${p.dir === 'рост' ? 'рост' : p.dir === 'падение' ? 'падение' : 'изменение'} на ${num(p.pct)}% за ${p.minutes} мин`,
  },
  volume_spike: {
    group: 'Движение цены', label: 'Всплеск объёма',
    params: { mult: ['Во сколько раз больше среднего', 3], avg: ['Среднее за свечей', 20] },
    state: (bars, i, p) => {
      if (i < p.avg) return null
      let s = 0
      for (let j = i - p.avg; j < i; j++) s += bars[j].volume
      return bars[i].volume > (s / p.avg) * p.mult
    },
    text: (p) => `объём ×${num(p.mult)} к среднему за ${p.avg} свечей`,
  },
  day_high: {
    group: 'Движение цены', label: 'Новый максимум дня', tf: false, fixedTf: '1d', params: {},
    text: () => 'новый максимум дня',
  },
  day_low: {
    group: 'Движение цены', label: 'Новый минимум дня', tf: false, fixedTf: '1d', params: {},
    text: () => 'новый минимум дня',
  },
}

/** Описание оповещения: «RSI 14 выше 70 (1ч, на закрытии)» */
export function describe(a) {
  const k = KINDS[a.kind]
  const tf = k.fixedTf ? '' : tfLabel(a.tf)
  const when = k.fixedTf ? '' : k.closeOnly || a.onClose ? ', на закрытии' : ''
  return `${k.text(a.params)}${tf ? ` (${tf}${when})` : ''}`
}

// ---------- Хранилище ----------
let items = []
try {
  items = JSON.parse(localStorage.getItem(STORAGE)) || []
} catch {}
const memory = new Map() // id → { prev, lastBar, dayHigh, dayLow, day } — в память браузера не пишем
const listeners = new Set()
const save = () => localStorage.setItem(STORAGE, JSON.stringify(items))
const emit = () => listeners.forEach((fn) => fn())

export const smart = {
  list: () => items,
  add(a) {
    items.push(a)
    save()
    emit()
    poll()
  },
  remove(id) {
    items = items.filter((a) => a.id !== id)
    memory.delete(id)
    save()
    emit()
  },
  restart(id) {
    const a = items.find((x) => x.id === id)
    if (!a) return
    a.active = true
    a.triggeredAt = null
    memory.delete(id)
    save()
    emit()
    poll()
  },
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

// ---------- Проверка ----------
let notify = () => {}

export function initSmartAlerts({ onNotify }) {
  notify = onNotify
  setInterval(poll, POLL_MS)
  poll()
  draw.subscribe(() => schedulePoll()) // поставили оповещение на линию «по закрытию» — проверить скорее
}

let pollTimer = 0
function schedulePoll() {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(poll, 500)
}

let polling = false
async function poll() {
  if (polling) return
  polling = true
  try {
    // что нужно проверить: группы «рынок + монета + таймфрейм»
    const groups = new Map()
    const need = (market, symbol, tf) => {
      const key = `${market}|${symbol}|${tf}`
      if (!groups.has(key)) groups.set(key, { market, symbol, tf, smart: [], drawings: [] })
      return groups.get(key)
    }
    for (const a of items) if (a.active) need(a.market, a.symbol, KINDS[a.kind].fixedTf || a.tf).smart.push(a)
    for (const key of draw.keys()) {
      const [market, symbol] = key.split(':')
      for (const d of draw.list(key)) {
        if (d.alert?.active && d.alert.mode === 'close') need(market, symbol, d.alert.tf).drawings.push({ key, d })
      }
    }
    for (const g of groups.values()) {
      let bars
      try {
        bars = await loadCandles(g.market, g.symbol, g.tf, null, 300)
      } catch {
        continue // нет связи — попробуем в следующий раз
      }
      if (bars.length < 3) continue
      for (const a of g.smart) checkSmart(a, bars)
      for (const { key, d } of g.drawings) checkDrawingClose(key, d, bars, g.tf)
    }
  } finally {
    polling = false
  }
}

function fire(a, message) {
  const now = Date.now()
  if (a.lastFired && now - a.lastFired < COOLDOWN_MS) return
  a.lastFired = now
  a.triggeredAt = now
  if (a.repeat !== 'every') a.active = false
  save()
  emit()
  notify(`${a.symbol}: ${message}`, a.symbol, a.market)
}

function checkSmart(a, bars) {
  const k = KINDS[a.kind]
  const m = memory.get(a.id) || {}
  memory.set(a.id, m)
  const last = bars.at(-1)

  // Новый максимум / минимум дня: сравниваем с тем, что было при прошлой проверке
  if (a.kind === 'day_high' || a.kind === 'day_low') {
    if (m.day !== last.time) {
      m.day = last.time // новый день — запоминаем текущие максимум и минимум
      m.dayHigh = last.high
      m.dayLow = last.low
      return
    }
    if (a.kind === 'day_high' && last.high > m.dayHigh) fire(a, `новый максимум дня ${fmt(last.high)}`)
    if (a.kind === 'day_low' && last.low < m.dayLow) fire(a, `новый минимум дня ${fmt(last.low)}`)
    m.dayHigh = Math.max(m.dayHigh, last.high)
    m.dayLow = Math.min(m.dayLow, last.low)
    return
  }

  // «на закрытии» — смотрим последнюю закрытую свечу, и только когда закрылась новая
  const onClose = k.closeOnly || a.onClose
  const i = onClose ? bars.length - 2 : bars.length - 1
  if (onClose) {
    if (m.lastBar === bars[i].time) return
    m.lastBar = bars[i].time
  }
  const on = k.state(bars, i, a.params)
  if (on == null) return
  if (m.prev === undefined) {
    // первая проверка: только запоминаем. Если условие уже выполнено — ждём, пока оно
    // перестанет и снова выполнится (иначе оповещение срабатывало бы сразу при создании)
    m.prev = on
    return
  }
  if (!m.prev && on) fire(a, describe(a) + ` · цена ${fmt(bars[i].close)}`)
  m.prev = on
}

// Рисунок «по закрытию свечи»: закрылась ли последняя свеча по другую сторону линии,
// чем предыдущая
function checkDrawingClose(key, d, bars, tf) {
  const sec = tfSec(tf)
  const m = memory.get(d.id) || {}
  memory.set(d.id, m)
  const i = bars.length - 2
  const cur = bars[i]
  const prev = bars[i - 1]
  if (m.lastBar === cur.time) return
  m.lastBar = cur.time
  // свеча должна закрыться после того, как поставили оповещение
  if ((cur.time + sec) * 1000 < (d.alert.created || 0)) return
  const levelsNow = drawingLevels(d, cur.time + sec - 1)
  const levelsPrev = drawingLevels(d, prev.time + sec - 1)
  for (let n = 0; n < levelsNow.length; n++) {
    if (levelsPrev[n] == null) continue
    const wasAbove = prev.close > levelsPrev[n]
    const isAbove = cur.close > levelsNow[n]
    if (wasAbove !== isAbove) {
      const [market, symbol] = key.split(':')
      draw.update(key, d.id, { alert: { ...d.alert, active: false, triggeredAt: Date.now() } })
      notify(
        `${symbol}: свеча ${tfLabel(tf)} закрылась ${isAbove ? 'выше' : 'ниже'} — ${DRAWING_NAMES[d.type]} (${fmt(levelsNow[n])})`,
        symbol,
        market,
      )
      return
    }
  }
}

// ---------- Окно «Умное оповещение» ----------
export function openSmartDialog({ symbol, market, price }) {
  document.querySelector('.smart-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay smart-overlay open'
  const groups = {}
  for (const [code, k] of Object.entries(KINDS)) (groups[k.group] ||= []).push([code, k])
  overlay.innerHTML = `
    <div class="modal smart-modal">
      <div class="modal-head"><b>Умное оповещение</b><button class="modal-close" title="Закрыть (Esc)">✕</button></div>
      <div class="sm-grid">
        <label>Монета <input class="sm-symbol" value="${symbol}"></label>
        <label>Рынок <select class="sm-market"><option value="futures">Фьючерсы</option><option value="spot">Спот</option></select></label>
        <label class="sm-wide">Условие <select class="sm-kind">
          ${Object.entries(groups).map(([g, list]) => `<optgroup label="${g}">${list.map(([c, k]) => `<option value="${c}">${k.label}</option>`).join('')}</optgroup>`).join('')}
        </select></label>
        <label class="sm-tf-wrap">Таймфрейм <select class="sm-tf">${INTERVALS.map((i) => `<option value="${i.code}">${i.label}</option>`).join('')}</select></label>
        <div class="sm-params sm-wide"></div>
        <label class="sm-when-wrap sm-wide">Проверять
          <select class="sm-when"><option value="live">сразу, как только условие выполнится</option><option value="close">только на закрытии свечи</option></select></label>
        <label class="sm-wide">Повтор
          <select class="sm-repeat"><option value="once">один раз</option><option value="every">каждый раз (не чаще раза в минуту)</option></select></label>
      </div>
      <div class="sm-preview"></div>
      <button class="sm-create">Создать оповещение</button>
    </div>`
  document.body.append(overlay)
  const $ = (sel) => overlay.querySelector(sel)
  $('.sm-market').value = market
  $('.sm-tf').value = '1h'
  const close = () => overlay.remove()
  $('.modal-close').onclick = close
  overlay.addEventListener('pointerdown', (e) => e.target === overlay && close())
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') close()
  })

  let params = {}
  function renderParams() {
    const k = KINDS[$('.sm-kind').value]
    params = {}
    $('.sm-params').innerHTML = Object.entries(k.params)
      .map(([name, [label, def, options]]) => {
        let v = def
        if (name === 'level' && (a_kind() === 'close_above' || a_kind() === 'close_below')) v = +price.toPrecision(6)
        params[name] = v
        return options
          ? `<label>${label} <select data-p="${name}">${options.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`
          : `<label>${label} <input type="number" step="any" data-p="${name}" value="${v}"></label>`
      })
      .join('')
    $('.sm-tf-wrap').style.display = k.fixedTf ? 'none' : ''
    $('.sm-when-wrap').style.display = k.fixedTf || k.closeOnly ? 'none' : ''
    for (const el of overlay.querySelectorAll('[data-p]')) {
      el.oninput = () => {
        params[el.dataset.p] = el.tagName === 'SELECT' ? el.value : parseFloat(String(el.value).replace(',', '.'))
        preview()
      }
    }
    preview()
  }
  const a_kind = () => $('.sm-kind').value
  function current() {
    const kind = a_kind()
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind,
      symbol: $('.sm-symbol').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''),
      market: $('.sm-market').value,
      tf: $('.sm-tf').value,
      params: { ...params },
      onClose: $('.sm-when').value === 'close',
      repeat: $('.sm-repeat').value,
      active: true,
      created: Date.now(),
    }
  }
  function preview() {
    const a = current()
    $('.sm-preview').textContent = `${a.symbol}: ${describe(a)}`
  }
  for (const sel of ['.sm-kind']) $(sel).onchange = renderParams
  for (const sel of ['.sm-symbol', '.sm-tf', '.sm-when', '.sm-market']) $(sel).oninput = preview
  $('.sm-create').onclick = () => {
    const a = current()
    const bad = Object.values(a.params).some((v) => typeof v === 'number' && !(v > 0))
    if (!a.symbol || bad) return alert('Проверьте монету и числа в условии')
    if (window.Notification?.permission === 'default') Notification.requestPermission()
    smart.add(a)
    close()
  }
  renderParams()
  $('.sm-kind').focus()
}
