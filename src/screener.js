// Скринер: все монеты рынка (к USDT) с фильтрами и сортировкой. Вкладка в правой панели.
// Данные — суточная статистика биржи (цена, изменение, оборот, максимум и минимум за 24 часа),
// обновляется каждые 10 секунд.
import { loadTickers } from './binance.js'
import { marketOptions, marketShort } from './markets.js'

const STORAGE = 'my-terminal-screener'
const REFRESH_MS = 10_000

// Столбцы: подпись, значение из строки, как показать
// width — ширина столбца (одинаковая в заголовке и строках, чтобы столбцы не «гуляли»)
const COLUMNS = {
  last: { label: 'Цена', width: 84, value: (r) => r.last, show: (r) => fmtPrice(r.last) },
  chg: { label: 'Изм. 24ч', width: 66, value: (r) => r.chg, show: (r) => `<span class="${r.chg >= 0 ? 'up' : 'down'}">${r.chg >= 0 ? '+' : ''}${r.chg.toFixed(2)}%</span>` },
  vol: { label: 'Оборот', width: 54, value: (r) => r.vol, show: (r) => fmtVol(r.vol) },
  range: { label: 'Размах', width: 56, value: (r) => r.range, show: (r) => r.range.toFixed(1) + '%', title: 'Размах за 24 часа: (максимум − минимум) / минимум' },
  pos: {
    label: 'Диапазон', width: 64, value: (r) => r.pos, title: 'Где цена в диапазоне 24 часов: 0% — у минимума, 100% — у максимума',
    show: (r) => `<span class="sc-pos"><i style="left:${Math.round(r.pos)}%"></i></span>`,
  },
}
const DEFAULT = {
  market: 'futures',
  minVol: 30, // млн $
  chgMin: '',
  chgMax: '',
  minRange: '',
  search: '',
  sort: { col: 'vol', dir: -1 },
  cols: ['last', 'chg', 'vol'],
}

function decimalsFor(price) {
  if (price >= 1000) return 2
  if (price >= 1) return 4
  if (price >= 0.01) return 6
  return 8
}
const fmtPrice = (p) => p.toLocaleString('ru-RU', { minimumFractionDigits: decimalsFor(p), maximumFractionDigits: decimalsFor(p) })
const fmtVol = (v) => (v >= 1e9 ? (v / 1e9).toFixed(1).replace('.', ',') + ' B' : v >= 1e6 ? Math.round(v / 1e6) + ' M' : Math.round(v / 1e3) + ' K')

/**
 * container — куда рисовать; getCurrent() — монета активного окна; onOpen(symbol, market) — открыть;
 * watchlist — список монет (для ☆); isActive() — открыта ли вкладка скринера
 */
export function initScreener({ container, getCurrent, onOpen, watchlist, isActive }) {
  let st = { ...DEFAULT }
  try {
    st = { ...DEFAULT, ...JSON.parse(localStorage.getItem(STORAGE)) }
  } catch {}
  const save = () => localStorage.setItem(STORAGE, JSON.stringify(st))

  container.innerHTML = `
    <div class="sc-head">
      <select class="sc-market" title="Биржа и рынок">${marketOptions()}</select>
      <button class="sc-filter-btn" title="Фильтры и столбцы">⚙ Фильтры</button>
      <div class="sc-filters">
        <label>Оборот за 24ч от, млн $ <input type="number" data-k="minVol" min="0" step="any"></label>
        <label>Изменение 24ч от, % <input type="number" data-k="chgMin" step="any" placeholder="любое"></label>
        <label>Изменение 24ч до, % <input type="number" data-k="chgMax" step="any" placeholder="любое"></label>
        <label>Размах 24ч от, % <input type="number" data-k="minRange" min="0" step="any" placeholder="любой"></label>
        <div class="sc-cols-title">Столбцы</div>
        ${Object.entries(COLUMNS).map(([k, c]) => `<label class="sc-col"><input type="checkbox" data-col="${k}"> ${c.label}</label>`).join('')}
        <button class="sc-reset">Сбросить фильтры</button>
      </div>
    </div>
    <input class="sc-search" placeholder="Поиск: BTC, PEPE…" autocomplete="off">
    <div class="sc-count"></div>
    <div class="sc-table">
      <div class="sc-colhead"></div>
      <div class="sc-rows"></div>
    </div>`
  const $ = (s) => container.querySelector(s)
  const filtersBox = $('.sc-filters')

  // ---------- Данные ----------
  let all = [] // строки рынка: { symbol, last, chg, vol, range, pos }
  let loadedFor = ''
  async function load() {
    const market = st.market
    try {
      const list = await loadTickers(market)
      if (market !== st.market) return
      all = list.map((t) => {
        const last = +t.lastPrice
        const high = +t.highPrice || last
        const low = +t.lowPrice || last
        return {
          symbol: t.symbol,
          last,
          chg: +t.priceChangePercent || 0,
          vol: +t.quoteVolume || 0,
          range: low > 0 ? ((high - low) / low) * 100 : 0,
          pos: high > low ? ((last - low) / (high - low)) * 100 : 50,
        }
      })
      loadedFor = market
      render()
    } catch {
      $('.sc-count').textContent = 'Не удалось загрузить монеты — нет связи с биржей'
    }
  }
  setInterval(() => isActive() && load(), REFRESH_MS)

  // ---------- Фильтр и сортировка ----------
  function filtered() {
    const q = st.search.trim().toUpperCase()
    const n = (v) => (v === '' || v == null ? null : +v)
    const chgMin = n(st.chgMin)
    const chgMax = n(st.chgMax)
    const minRange = n(st.minRange)
    const rows = all.filter(
      (r) =>
        r.vol >= (+st.minVol || 0) * 1e6 &&
        (chgMin == null || r.chg >= chgMin) &&
        (chgMax == null || r.chg <= chgMax) &&
        (minRange == null || r.range >= minRange) &&
        (!q || r.symbol.includes(q)),
    )
    const { col, dir } = st.sort
    const val = col === 'symbol' ? (r) => r.symbol : COLUMNS[col]?.value || ((r) => r.vol)
    return rows.sort((a, b) => {
      const x = val(a)
      const y = val(b)
      return (x < y ? -1 : x > y ? 1 : 0) * dir
    })
  }

  // ---------- Отрисовка ----------
  let shown = []
  function render() {
    if (!isActive()) return
    const cols = st.cols.filter((c) => COLUMNS[c])
    const grid = `minmax(78px, 1fr) ${cols.map((c) => COLUMNS[c].width + 'px').join(' ')} 18px`
    const arrow = (c) => (st.sort.col === c ? (st.sort.dir > 0 ? ' ▲' : ' ▼') : '')
    $('.sc-colhead').style.gridTemplateColumns = grid
    $('.sc-colhead').innerHTML =
      `<span data-sort="symbol">Монета${arrow('symbol')}</span>` +
      cols.map((c) => `<span data-sort="${c}" title="${COLUMNS[c].title || ''}">${COLUMNS[c].label}${arrow(c)}</span>`).join('') +
      '<span></span>'
    shown = filtered()
    $('.sc-count').textContent = loadedFor === st.market ? `Монет: ${shown.length} из ${all.length}` : 'Загрузка…'
    const cur = getCurrent()
    $('.sc-rows').innerHTML = shown
      .map((r) => {
        const inList = watchlist.has(r.symbol, st.market)
        const current = cur && cur.symbol === r.symbol && cur.market === st.market
        return `<div class="sc-row ${current ? 'current' : ''}" data-symbol="${r.symbol}" style="grid-template-columns:${grid}">
          <span class="sc-sym">${r.symbol.replace(/USDT$/, '')}<small>USDT</small></span>
          ${cols.map((c) => `<span class="sc-${c}">${COLUMNS[c].show(r)}</span>`).join('')}
          <button class="sc-star ${inList ? 'on' : ''}" title="${inList ? 'Убрать из списка' : 'Добавить в список'}">${inList ? '★' : '☆'}</button>
        </div>`
      })
      .join('')
  }

  // ---------- Действия ----------
  $('.sc-rows').addEventListener('click', (e) => {
    const row = e.target.closest('.sc-row')
    if (!row) return
    if (e.target.closest('.sc-star')) {
      watchlist.toggle(row.dataset.symbol, st.market)
      return render()
    }
    onOpen(row.dataset.symbol, st.market)
  })
  $('.sc-colhead').addEventListener('click', (e) => {
    const c = e.target.closest('[data-sort]')?.dataset.sort
    if (!c) return
    st.sort = st.sort.col === c ? { col: c, dir: -st.sort.dir } : { col: c, dir: c === 'symbol' ? 1 : -1 }
    save()
    render()
  })
  $('.sc-market').value = st.market
  $('.sc-market').onchange = () => {
    st.market = $('.sc-market').value
    save()
    all = []
    render()
    load()
  }
  $('.sc-search').value = st.search
  $('.sc-search').addEventListener('input', () => {
    st.search = $('.sc-search').value
    save()
    render()
  })
  $('.sc-search').addEventListener('keydown', (e) => e.stopPropagation())

  // фильтры и столбцы
  $('.sc-filter-btn').onclick = () => {
    for (const el of filtersBox.querySelectorAll('[data-k]')) el.value = st[el.dataset.k]
    for (const el of filtersBox.querySelectorAll('[data-col]')) el.checked = st.cols.includes(el.dataset.col)
    filtersBox.classList.toggle('open')
  }
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.sc-head')) filtersBox.classList.remove('open')
  })
  for (const el of filtersBox.querySelectorAll('[data-k]')) {
    el.addEventListener('input', () => {
      st[el.dataset.k] = el.value.replace(',', '.')
      save()
      render()
      showFilterState()
    })
    el.addEventListener('keydown', (e) => e.stopPropagation())
  }
  for (const el of filtersBox.querySelectorAll('[data-col]')) {
    el.onchange = () => {
      st.cols = Object.keys(COLUMNS).filter((k) => filtersBox.querySelector(`[data-col="${k}"]`).checked)
      save()
      render()
    }
  }
  $('.sc-reset').onclick = () => {
    Object.assign(st, { minVol: DEFAULT.minVol, chgMin: '', chgMax: '', minRange: '', search: '' })
    $('.sc-search').value = ''
    for (const el of filtersBox.querySelectorAll('[data-k]')) el.value = st[el.dataset.k]
    save()
    render()
    showFilterState()
  }
  // подсказка на кнопке: сколько фильтров включено
  function showFilterState() {
    const n = [st.chgMin, st.chgMax, st.minRange].filter((v) => v !== '').length + (+st.minVol > 0 ? 1 : 0)
    $('.sc-filter-btn').textContent = n ? `⚙ Фильтры (${n})` : '⚙ Фильтры'
  }
  showFilterState()

  // ↑ ↓ — следующая / предыдущая монета скринера
  document.addEventListener('keydown', (e) => {
    if (!isActive() || e.target.closest('input, select, textarea') || e.altKey || e.ctrlKey) return
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    if (!shown.length) return
    e.preventDefault()
    const cur = getCurrent()
    let i = shown.findIndex((r) => cur && r.symbol === cur.symbol && cur.market === st.market)
    i = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length
    onOpen(shown[i].symbol, st.market)
    container.querySelector(`.sc-row[data-symbol="${shown[i].symbol}"]`)?.scrollIntoView({ block: 'nearest' })
  })

  return {
    // вкладку открыли — сразу свежие данные
    activate() {
      if (loadedFor !== st.market || !all.length) load()
      else {
        render()
        load()
      }
    },
    render,
  }
}
