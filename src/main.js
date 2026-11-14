// Главный файл: раскладка окон, верхняя панель и синхронизация окон между собой.
import { Pane, fmt, CHART_TYPES } from './pane.js'
import { loadTickers, loadTicker } from './binance.js'
import { LAYOUTS, LAYOUT_ORDER, LETTERS, paneCount, applyGridTemplate, createSplitters } from './layout.js'
import { renderPane, renderAll, download, copyToClipboard, fileName } from './snapshot.js'
import { initToolbar } from './toolbar.js'
import { initIndicatorsDialog } from './indicatorsDialog.js'
import { initWatchlist } from './watchlist.js'
import { initAlerts } from './alerts.js'
import { MARKETS, marketOptions } from './markets.js'
import { openChartSettings, onStyleChange } from './chartSettings.js'
import './style.css'

// ---------- Раскладки ----------
// Сами раскладки и границы между окнами описаны в layout.js
// Интервалы для новых окон по порядку
const DEFAULT_INTERVALS = ['1d', '4h', '1h', '15m', '5m', '1m']

// ---------- Сохранённые настройки ----------
const saved = JSON.parse(localStorage.getItem('my-terminal-v2') || '{}')
const state = {
  market: MARKETS.some((m) => m.code === saved.market) ? saved.market : 'futures',
  chartType: saved.chartType || saved.panes?.[0]?.chartType || 'candles', // один тип для всех окон
  layout: LAYOUTS[saved.layout] ? saved.layout : '4',
  sync: { symbol: true, crosshair: true, time: false, ...saved.sync },
  panes: saved.panes || [], // [{ symbol, interval }]
  active: saved.active || 0,
  indicators: saved.indicators || [], // индикаторы — одни и те же во всех окнах
  volume: saved.volume !== false, // объём внизу графика
  snap: { what: 'active', scale: '3', to: 'file', ...saved.snap }, // настройки снимка
  sizes: saved.sizes || {}, // размеры окон для каждой раскладки: { '4': { cols: [..], rows: [..] } }
}

let panes = [] // объекты Pane, которые сейчас на экране

function save() {
  state.panes = panes.map((p) => ({ symbol: p.symbol, interval: p.interval }))
  state.active = Math.max(0, panes.indexOf(activePane))
  localStorage.setItem('my-terminal-v2', JSON.stringify(state))
}

// ---------- Элементы страницы ----------
const $ = (id) => document.getElementById(id)
const grid = $('grid')
const symbolInput = $('symbol')
const marketSelect = $('market')
const lastEl = $('last')
const changeEl = $('change')

// ---------- Синхронизация ----------
// Эти функции окна вызывают сами, когда пользователь что-то делает в них.
const hooks = {
  onActivate(pane) {
    setActive(pane)
  },

  // Мышь двигается по одному окну → показываем перекрестие в остальных
  onCrosshair(source, time, price) {
    if (!state.sync.crosshair) return
    for (const p of panes) if (p !== source) p.showCrosshair(time, price)
  },

  // Окно прокрутили → сдвигаем остальные к тому же времени
  onScroll(source) {
    if (!state.sync.time) return
    const view = source.viewInfo()
    if (!view) return
    for (const p of panes) {
      if (p === source) continue
      if (view.atRealtime) p.scrollToRealtime()
      else p.centerOn(view.time)
    }
  },

  // Новая цена → обновляем цифру вверху, если это активное окно
  onPrice(pane, price) {
    if (pane === activePane) showLastPrice(price, pane.decimals)
    alerts?.check(pane.key, price) // самая свежая цена — сразу проверяем оповещения
  },

  onIntervalChange() {
    save()
  },

  // Окно перетащили на место другого → меняем их местами
  onSwap(fromPane, toPane) {
    const a = panes.indexOf(fromPane)
    const b = panes.indexOf(toPane)
    if (a < 0 || b < 0 || a === b) return
    ;[panes[a], panes[b]] = [panes[b], panes[a]]
    placePanes() // каждое окно — на своё новое место
    save()
  },
}

// ---------- Активное окно (подсвечено рамкой) ----------
let activePane = null

function setActive(pane) {
  if (pane === activePane) return
  activePane = pane
  for (const p of panes) p.setActive(p === pane)
  symbolInput.value = pane.symbol
  document.title = `${pane.symbol} — Мой терминал`
  if (pane.bars.length) showLastPrice(pane.bars.at(-1).close, pane.decimals)
  updateChange()
  save()
  afterSymbolChange()
}

// ---------- Раскладка ----------
function applyLayout(key) {
  state.layout = key
  const need = paneCount(key)

  // Лишние окна убираем
  while (panes.length > need) panes.pop().destroy()

  // Недостающие добавляем
  while (panes.length < need) {
    const i = panes.length
    const savedPane = state.panes[i]
    const symbol =
      state.sync.symbol || !savedPane ? activePane?.symbol || savedPane?.symbol || 'BTCUSDT' : savedPane.symbol
    const pane = new Pane(
      {
        market: state.market,
        symbol,
        interval: savedPane?.interval || DEFAULT_INTERVALS[i] || '1h',
        chartType: state.chartType,
        indicators: state.indicators,
        volume: state.volume,
      },
      hooks,
    )
    panes.push(pane)
    grid.append(pane.el)
  }

  grid.dataset.layout = key
  applyGridTemplate(grid, key, state.sizes[key])
  placePanes()
  splitters.render()
  for (const btn of $('layouts').children) btn.classList.toggle('active', btn.dataset.layout === key)
  $('layoutCurrent').replaceChildren(miniIcon(key)) // на кнопке — значок выбранной раскладки
  $('layoutBtn').title = 'Раскладка окон: ' + LAYOUTS[key].title
  if (!panes.includes(activePane)) {
    activePane = null
    setActive(panes[Math.min(state.active, panes.length - 1)] || panes[0])
  }
  save()
}

// Окно номер i ставим в клетку с буквой i (a, b, c…)
function placePanes() {
  panes.forEach((p, i) => (p.el.style.gridArea = LETTERS[i]))
}

// Границы между окнами, которые можно тянуть мышью
const splitters = createSplitters(grid, {
  getKey: () => state.layout,
  getSizes: () => state.sizes[state.layout],
  setSizes: (sizes, persist) => {
    state.sizes[state.layout] = sizes
    if (persist) save()
  },
})

// Значок раскладки — маленькая копия её сетки
function miniIcon(key) {
  const mini = document.createElement('span')
  mini.className = 'mini'
  for (let i = 0; i < paneCount(key); i++) {
    const cell = document.createElement('i')
    cell.style.gridArea = LETTERS[i]
    mini.append(cell)
  }
  applyGridTemplate(mini, key)
  return mini
}

// Меню раскладок: значок + подпись
const layoutMenu = $('layouts')
for (const key of LAYOUT_ORDER) {
  const btn = document.createElement('button')
  btn.dataset.layout = key
  btn.append(miniIcon(key))
  const label = document.createElement('span')
  label.textContent = LAYOUTS[key].title
  btn.append(label)
  btn.onclick = () => {
    applyLayout(key)
    layoutMenu.classList.remove('open')
  }
  layoutMenu.append(btn)
}
// Кнопка открывает и закрывает меню
$('layoutBtn').onclick = () => layoutMenu.classList.toggle('open')
// Щелчок мимо меню — закрыть
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.layout-pick')) layoutMenu.classList.remove('open')
})

// ---------- Кнопки синхронизации ----------
for (const btn of document.querySelectorAll('[data-sync]')) {
  const key = btn.dataset.sync
  btn.classList.toggle('active', state.sync[key])
  btn.onclick = () => {
    state.sync[key] = !state.sync[key]
    btn.classList.toggle('active', state.sync[key])
    // включили «Монету» — ставим монету активного окна во все окна
    if (key === 'symbol' && state.sync.symbol && activePane) {
      for (const p of panes) p.setSymbol(activePane.symbol)
    }
    // выключили «Перекрестие» — убираем чужие перекрестия
    if (key === 'crosshair' && !state.sync.crosshair) {
      for (const p of panes) p.showCrosshair(null, null)
    }
    save()
  }
}

// ---------- Поле «монета» ----------
function applySymbol() {
  const s = symbolInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!s || !activePane) return
  symbolInput.blur()
  openSymbol(s, state.market)
}

// Открыть монету: в активном окне или во всех (если включена синхронизация монеты)
function openSymbol(symbol, market) {
  if (!activePane) return
  if (market !== state.market) {
    state.market = market
    marketSelect.value = market
    fillSymbols()
  }
  const targets = state.sync.symbol ? panes : [activePane]
  for (const p of panes) p.setSymbol(targets.includes(p) ? symbol : p.symbol, state.market)
  symbolInput.value = symbol
  document.title = `${symbol} — Мой терминал`
  updateChange()
  save()
  afterSymbolChange()
}

// Подсветить монету в списке и обновить звёздочку
function afterSymbolChange() {
  watchlist?.markCurrent()
  const inList = activePane && watchlist?.has(activePane.symbol, activePane.market)
  $('starBtn').textContent = inList ? '★' : '☆'
  $('starBtn').classList.toggle('active', !!inList)
  $('starBtn').title = inList ? 'Убрать из списка' : 'Добавить в список'
}
symbolInput.addEventListener('change', applySymbol)
symbolInput.addEventListener('keydown', (e) => e.key === 'Enter' && applySymbol())
symbolInput.addEventListener('focus', () => symbolInput.select())

async function fillSymbols() {
  try {
    const list = await loadTickers(state.market)
    $('symbols').innerHTML = list
      .map((t) => `<option value="${t.symbol}">${(+t.priceChangePercent).toFixed(2)}%</option>`)
      .join('')
  } catch {
    // без подсказок тоже можно работать
  }
}

// ---------- Тип графика ----------
const chartTypeSelect = $('chartType')
chartTypeSelect.innerHTML = CHART_TYPES.map((t) => `<option value="${t.code}">${t.label}</option>`).join('')
chartTypeSelect.value = state.chartType
chartTypeSelect.onchange = () => {
  state.chartType = chartTypeSelect.value
  for (const p of panes) p.setChartType(state.chartType)
  save()
}

// ---------- Рынок ----------
marketSelect.innerHTML = marketOptions()
marketSelect.value = state.market
marketSelect.onchange = () => {
  state.market = marketSelect.value
  for (const p of panes) p.setSymbol(p.symbol, state.market)
  fillSymbols()
  updateChange()
  save()
  afterSymbolChange()
}

// ---------- Цена вверху ----------
let dayOpen = null
let changeFor = ''

async function updateChange() {
  const pane = activePane
  if (!pane) return
  const key = state.market + pane.symbol
  changeFor = key
  dayOpen = null
  changeEl.textContent = ''
  try {
    const t = await loadTicker(state.market, pane.symbol)
    if (changeFor !== key) return
    dayOpen = +t.openPrice
    showLastPrice(+t.lastPrice, pane.decimals)
  } catch {
    // без изменения за сутки
  }
}

function showLastPrice(price, decimals) {
  lastEl.textContent = fmt(price, decimals)
  if (dayOpen) {
    const pct = ((price - dayOpen) / dayOpen) * 100
    changeEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'
    changeEl.className = pct >= 0 ? 'up' : 'down'
  }
}

// ---------- Снимок ----------
const snapBox = document.querySelector('.snap')
const snapMenu = $('snapMenu')

// Отметить сохранённые варианты в меню
for (const [name, key] of [['snapWhat', 'what'], ['snapScale', 'scale'], ['snapTo', 'to']]) {
  for (const input of document.querySelectorAll(`input[name=${name}]`)) {
    input.checked = input.value === state.snap[key]
    input.onchange = () => {
      state.snap[key] = input.value
      showSnapSize()
      save()
    }
  }
}

// Подсказка: какого размера получится картинка
function showSnapSize() {
  const el = state.snap.what === 'all' ? grid : activePane?.el
  if (!el) return
  const r = el.getBoundingClientRect()
  const k = +state.snap.scale
  $('snapSize').textContent = `Картинка: ${Math.round(r.width * k)} × ${Math.round(r.height * k)} пикселей`
}

$('snapMenuBtn').onclick = (e) => {
  e.stopPropagation()
  showSnapSize()
  snapMenu.classList.toggle('open')
}
document.addEventListener('pointerdown', (e) => {
  if (!snapBox.contains(e.target)) snapMenu.classList.remove('open')
})
$('snapBtn').onclick = () => takeSnapshot()
$('snapGo').onclick = () => {
  snapMenu.classList.remove('open')
  takeSnapshot()
}
// Быстрая клавиша Alt+S
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyS') {
    e.preventDefault()
    takeSnapshot()
  }
})

async function takeSnapshot() {
  if (!activePane || snapBox.classList.contains('busy')) return
  snapBox.classList.add('busy')
  try {
    const scale = +state.snap.scale
    const all = state.snap.what === 'all'
    const canvas = all ? await renderAll(panes, grid, scale) : await renderPane(activePane, scale)
    const name = all ? fileName(`${activePane.symbol}_все-окна`) : fileName(`${activePane.symbol}_${activePane.intervalLabel}`)
    if (state.snap.to === 'clipboard') {
      await copyToClipboard(canvas)
      toast(`Снимок ${canvas.width}×${canvas.height} скопирован — вставьте его клавишами Ctrl+V`)
    } else {
      await download(canvas, name)
      toast(`Снимок ${canvas.width}×${canvas.height} сохранён в «Загрузки»`)
    }
  } catch (err) {
    toast('Не получилось сделать снимок: ' + err.message)
  } finally {
    snapBox.classList.remove('busy')
  }
}

let toastTimer
function toast(text) {
  const el = $('toast')
  el.textContent = text
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500)
}

// ---------- Настройки графика ----------
$('settingsBtn').onclick = () => openChartSettings()
onStyleChange(() => {
  for (const p of panes) p.applyStyle()
})

// ---------- Индикаторы ----------
const indDialog = initIndicatorsDialog({
  getList: () => state.indicators,
  onChange(list) {
    state.indicators = list
    for (const p of panes) p.setIndicators(list)
    $('indBtn').classList.toggle('active', list.length > 0)
    save()
  },
  getVolume: () => state.volume,
  setVolume(on) {
    state.volume = on
    for (const p of panes) p.setVolumeVisible(on)
    save()
  },
})
$('indBtn').onclick = () => indDialog.open()
$('indBtn').classList.toggle('active', state.indicators.length > 0)

// ---------- Список монет ----------
let watchlist = null
watchlist = initWatchlist({
  getCurrent: () => activePane && { symbol: activePane.symbol, market: activePane.market },
  getMarket: () => state.market,
  onOpen: (symbol, market) => openSymbol(symbol, market),
  onListChange: () => afterSymbolChange(),
})
$('starBtn').onclick = () => activePane && watchlist.toggle(activePane.symbol, activePane.market)
afterSymbolChange()

// ---------- Оповещения ----------
let alerts = null
alerts = initAlerts({
  getPanes: () => panes,
  getActivePane: () => activePane,
  onOpen: (symbol, market) => openSymbol(symbol, market),
})

// ---------- Рисование ----------
initToolbar({ getActiveKey: () => activePane?.key, getPanes: () => panes })

// ---------- Старт ----------
applyLayout(state.layout)
fillSymbols()
