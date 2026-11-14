// Список монет справа: живые цены, изменение за сутки, несколько списков.
import { loadTickers, subscribeTickers } from './binance.js'

const STORAGE = 'my-terminal-watchlists'
const DEFAULT_ITEMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'].map((symbol) => ({ market: 'futures', symbol }))

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE))
    if (s?.lists?.length) return s
  } catch {}
  const id = uid()
  return {
    lists: [{ id, name: 'Избранное', items: DEFAULT_ITEMS }],
    current: id,
    open: window.innerWidth > 700, // на телефоне сначала свёрнут
    sort: null, // { col: 'symbol' | 'last' | 'change', dir: 1 | -1 } или null — свой порядок
    width: 300, // ширина панели в пикселях
  }
}

// Сколько знаков после запятой: у дорогих монет 2, у дешёвых больше
function decimalsFor(price) {
  if (price >= 1000) return 2
  if (price >= 1) return 4
  if (price >= 0.01) return 6
  return 8
}
const fmtPrice = (p) => p.toLocaleString('ru-RU', { minimumFractionDigits: decimalsFor(p), maximumFractionDigits: decimalsFor(p) })

/**
 * getCurrent() — { symbol, market } монеты активного окна (её строка подсвечивается)
 * getMarket() — рынок, выбранный вверху (для подсказок при добавлении)
 * onOpen(symbol, market) — щёлкнули по монете в списке
 * onListChange() — состав текущего списка изменился (чтобы обновить звёздочку ☆)
 */
export function initWatchlist({ getCurrent, getMarket, onOpen, onListChange }) {
  const state = loadState()
  const save = () => localStorage.setItem(STORAGE, JSON.stringify(state))
  const list = () => state.lists.find((l) => l.id === state.current) || state.lists[0]
  const keyOf = (it) => `${it.market}:${it.symbol}`

  const tickers = new Map() // 'futures:BTCUSDT' → { last, open, quoteVolume }
  const rowsByKey = new Map() // 'futures:BTCUSDT' → элемент строки

  // ---------- Разметка ----------
  const panel = document.getElementById('watchlist')
  panel.innerHTML = `
    <div class="wl-resize" title="Тяните, чтобы изменить ширину. Двойной щелчок — обычная ширина"></div>
    <div class="wl-head">
      <select class="wl-lists" title="Список"></select>
      <button class="wl-menu-btn" title="Списки: создать, переименовать, удалить">⋯</button>
      <button class="wl-hide" title="Скрыть список (Alt+W)">»</button>
      <div class="wl-menu">
        <button data-act="new">➕ Новый список</button>
        <button data-act="rename">✏️ Переименовать</button>
        <button data-act="delete">🗑 Удалить список</button>
      </div>
    </div>
    <input class="wl-add" list="wl-suggest" placeholder="+ Добавить монету" autocomplete="off" />
    <datalist id="wl-suggest"></datalist>
    <div class="wl-cols">
      <span data-sort="symbol">Монета</span>
      <span data-sort="last">Цена</span>
      <span data-sort="change">Изм.</span>
    </div>
    <div class="wl-rows"></div>
    <div class="wl-empty">Список пуст. Добавьте монету в поле выше или кнопкой ☆ рядом с названием монеты.</div>`

  const listsSelect = panel.querySelector('.wl-lists')
  const rowsEl = panel.querySelector('.wl-rows')
  const addInput = panel.querySelector('.wl-add')
  const menu = panel.querySelector('.wl-menu')

  // ---------- Открыть / свернуть панель ----------
  const toggleBtn = document.getElementById('wlToggle')
  function applyOpen() {
    panel.classList.toggle('open', state.open)
    toggleBtn.classList.toggle('active', state.open)
  }
  function toggle() {
    state.open = !state.open
    applyOpen()
    save()
  }
  toggleBtn.onclick = toggle
  panel.querySelector('.wl-hide').onclick = toggle
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyW') {
      e.preventDefault()
      toggle()
    }
  })

  // ---------- Ширина: тянем левую границу ----------
  const MIN_W = 200
  const MAX_W = 600
  const applyWidth = () => (panel.style.width = (state.width || 300) + 'px')
  const handle = panel.querySelector('.wl-resize')
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = panel.offsetWidth
    document.body.classList.add('resizing-v')
    const move = (ev) => {
      // панель справа: тянем влево — шире
      state.width = Math.max(MIN_W, Math.min(MAX_W, startW + (startX - ev.clientX)))
      applyWidth()
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing-v')
      save()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  })
  handle.addEventListener('dblclick', () => {
    state.width = 300
    applyWidth()
    save()
  })
  applyWidth()

  // ---------- Списки ----------
  function renderLists() {
    listsSelect.innerHTML = state.lists
      .map((l) => `<option value="${l.id}">${l.name} (${l.items.length})</option>`)
      .join('')
    listsSelect.value = list().id
  }
  listsSelect.onchange = () => {
    state.current = listsSelect.value
    save()
    rebuild()
  }
  panel.querySelector('.wl-menu-btn').onclick = () => menu.classList.toggle('open')
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.wl-head')) menu.classList.remove('open')
  })
  menu.onclick = (e) => {
    const act = e.target.closest('button')?.dataset.act
    menu.classList.remove('open')
    if (act === 'new') {
      const name = prompt('Название нового списка:', 'Новый список')
      if (!name) return
      const l = { id: uid(), name: name.trim(), items: [] }
      state.lists.push(l)
      state.current = l.id
    } else if (act === 'rename') {
      const name = prompt('Новое название списка:', list().name)
      if (!name) return
      list().name = name.trim()
    } else if (act === 'delete') {
      if (state.lists.length === 1) return alert('Это единственный список — его нельзя удалить')
      if (!confirm(`Удалить список «${list().name}»?`)) return
      state.lists = state.lists.filter((l) => l.id !== list().id)
      state.current = state.lists[0].id
    } else return
    save()
    rebuild()
  }

  // ---------- Добавить монету ----------
  async function fillSuggest() {
    try {
      const all = await loadTickers(getMarket())
      panel.querySelector('#wl-suggest').innerHTML = all.map((t) => `<option value="${t.symbol}"></option>`).join('')
    } catch {}
  }
  function add(symbol, market = getMarket()) {
    symbol = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!symbol) return
    const l = list()
    if (!l.items.some((it) => it.symbol === symbol && it.market === market)) l.items.push({ market, symbol })
    save()
    rebuild()
  }
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      add(addInput.value)
      addInput.value = ''
    }
  })
  addInput.addEventListener('change', () => {
    if (!addInput.value) return
    add(addInput.value)
    addInput.value = ''
  })
  addInput.addEventListener('focus', fillSuggest)

  function remove(key) {
    const l = list()
    l.items = l.items.filter((it) => keyOf(it) !== key)
    save()
    rebuild()
  }

  // ---------- Сортировка ----------
  for (const col of panel.querySelectorAll('.wl-cols [data-sort]')) {
    col.onclick = () => {
      const c = col.dataset.sort
      // по кругу: по убыванию → по возрастанию → свой порядок
      if (state.sort?.col !== c) state.sort = { col: c, dir: c === 'symbol' ? 1 : -1 }
      else if ((state.sort.dir === -1) === (c !== 'symbol')) state.sort.dir *= -1
      else state.sort = null
      save()
      renderRows()
    }
  }
  const changeOf = (key) => {
    const t = tickers.get(key)
    return t && t.open ? ((t.last - t.open) / t.open) * 100 : null
  }
  function ordered() {
    const items = [...list().items]
    const s = state.sort
    if (!s) return items
    const val = (it) => {
      if (s.col === 'symbol') return it.symbol
      if (s.col === 'last') return tickers.get(keyOf(it))?.last ?? -Infinity
      return changeOf(keyOf(it)) ?? -Infinity
    }
    return items.sort((a, b) => {
      const x = val(a)
      const y = val(b)
      return (x < y ? -1 : x > y ? 1 : 0) * s.dir
    })
  }

  // ---------- Строки ----------
  let dragKey = null
  function renderRows() {
    rowsByKey.clear()
    rowsEl.innerHTML = ''
    const items = ordered()
    const mixed = new Set(items.map((it) => it.market)).size > 1 // если в списке и спот, и фьючерсы — подписываем
    for (const it of items) {
      const key = keyOf(it)
      const row = document.createElement('div')
      row.className = 'wl-row'
      row.draggable = !state.sort
      row.dataset.key = key
      row.innerHTML = `
        <span class="wl-sym">${it.symbol.replace(/USDT$/, '')}<small>${it.symbol.endsWith('USDT') ? 'USDT' : ''}</small>${mixed ? `<em>${it.market === 'futures' ? 'фьюч' : 'спот'}</em>` : ''}</span>
        <span class="wl-last">—</span>
        <span class="wl-chg"></span>
        <button class="wl-del" title="Убрать из списка">✕</button>`
      row.onclick = (e) => {
        if (e.target.closest('.wl-del')) return remove(key)
        onOpen(it.symbol, it.market)
      }
      // перетаскивание строк — свой порядок
      row.addEventListener('dragstart', () => {
        dragKey = key
        row.classList.add('dragging')
      })
      row.addEventListener('dragend', () => {
        dragKey = null
        row.classList.remove('dragging')
        for (const r of rowsEl.querySelectorAll('.drop-above, .drop-below')) r.classList.remove('drop-above', 'drop-below')
      })
      row.addEventListener('dragover', (e) => {
        if (!dragKey || dragKey === key) return
        e.preventDefault()
        const below = e.offsetY > row.offsetHeight / 2
        row.classList.toggle('drop-below', below)
        row.classList.toggle('drop-above', !below)
      })
      row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'))
      row.addEventListener('drop', (e) => {
        e.preventDefault()
        const below = row.classList.contains('drop-below')
        row.classList.remove('drop-above', 'drop-below')
        const l = list()
        const from = l.items.findIndex((x) => keyOf(x) === dragKey)
        const [moved] = l.items.splice(from, 1)
        let to = l.items.findIndex((x) => keyOf(x) === key)
        if (below) to++
        l.items.splice(to, 0, moved)
        save()
        renderRows()
      })
      rowsEl.append(row)
      rowsByKey.set(key, row)
      paint(key, false)
    }
    // стрелка у заголовка, по которому отсортировано
    for (const col of panel.querySelectorAll('.wl-cols [data-sort]')) {
      const s = state.sort
      col.dataset.arrow = s?.col === col.dataset.sort ? (s.dir > 0 ? '▲' : '▼') : ''
    }
    panel.classList.toggle('empty', !items.length)
    markCurrent()
  }

  // Обновить цену в строке; flash — мигнуть зелёным/красным
  function paint(key, flash = true) {
    const row = rowsByKey.get(key)
    const t = tickers.get(key)
    if (!row || !t) return
    const lastEl = row.querySelector('.wl-last')
    const text = fmtPrice(t.last)
    if (lastEl.textContent !== text) {
      if (flash && t.prev != null && t.last !== t.prev) {
        lastEl.classList.remove('flash-up', 'flash-down')
        void lastEl.offsetWidth // перезапуск анимации
        lastEl.classList.add(t.last > t.prev ? 'flash-up' : 'flash-down')
      }
      lastEl.textContent = text
    }
    const chg = changeOf(key)
    const chgEl = row.querySelector('.wl-chg')
    if (chg != null) {
      chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%'
      chgEl.className = 'wl-chg ' + (chg >= 0 ? 'up' : 'down')
    }
  }

  function markCurrent() {
    const cur = getCurrent()
    const key = cur && `${cur.market}:${cur.symbol}`
    for (const [k, row] of rowsByKey) row.classList.toggle('current', k === key)
  }

  // ---------- Цены ----------
  let unsubs = []
  async function rebuild() {
    renderLists()
    renderRows()
    onListChange?.()
    for (const off of unsubs) off()
    unsubs = []
    const byMarket = { futures: [], spot: [] }
    for (const it of list().items) byMarket[it.market]?.push(it.symbol)
    for (const [market, symbols] of Object.entries(byMarket)) {
      if (!symbols.length) continue
      // сначала цены разом (REST), потом живые обновления (WebSocket)
      loadTickers(market)
        .then((all) => {
          for (const t of all) {
            const key = `${market}:${t.symbol}`
            if (!rowsByKey.has(key) || tickers.has(key)) continue
            tickers.set(key, { last: +t.lastPrice, open: +t.openPrice, quoteVolume: +t.quoteVolume })
            paint(key, false)
          }
          if (state.sort) renderRows()
        })
        .catch(() => {})
      unsubs.push(
        subscribeTickers(market, symbols, (t) => {
          const key = `${market}:${t.symbol}`
          const prev = tickers.get(key)?.last
          tickers.set(key, { ...t, prev })
          paint(key)
        }),
      )
    }
  }

  // Пересортировать раз в 5 секунд, если список отсортирован по цене или изменению
  setInterval(() => {
    if (state.sort && state.sort.col !== 'symbol' && !panel.matches(':hover')) renderRows()
  }, 5000)

  // ---------- Клавиши ↑ ↓ — следующая / предыдущая монета ----------
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.altKey || e.ctrlKey) return
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = ordered()
    if (!items.length) return
    e.preventDefault()
    const cur = getCurrent()
    let i = items.findIndex((it) => it.symbol === cur?.symbol && it.market === cur?.market)
    i = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    onOpen(items[i].symbol, items[i].market)
    rowsByKey.get(keyOf(items[i]))?.scrollIntoView({ block: 'nearest' })
  })

  applyOpen()
  rebuild()

  return {
    markCurrent,
    // ☆ рядом с названием монеты: есть ли монета в текущем списке, добавить/убрать
    has: (symbol, market) => list().items.some((it) => it.symbol === symbol && it.market === market),
    toggle(symbol, market) {
      if (this.has(symbol, market)) remove(`${market}:${symbol}`)
      else add(symbol, market)
    },
  }
}
