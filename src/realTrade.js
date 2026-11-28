// Панель «💰 Реал»: торговля на настоящей бирже через ваш сервер (tools/alertd).
// API-ключи биржи хранятся ТОЛЬКО на сервере, здесь их нет. Кнопка видна, только если сервер признал вас владельцем.
// Каждая отправка ордера — через окно подтверждения; сервер дополнительно проверяет лимиты суммы и плеча.
import { MARKETS } from './markets.js'

const LS_KEY = 'terminal.alertKey'
const LS_UI = 'my-terminal-real-ui'
const TRADE_MARKETS = MARKETS.filter((m) => !m.delayed)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const num = (v, d = 2) => (v == null || v === '' || isNaN(+v) ? '—' : (+v).toLocaleString('ru-RU', { maximumFractionDigits: d }))
const readKey = () => {
  try { return localStorage.getItem(LS_KEY) || '' } catch { return '' }
}

export function initRealTrade({ getActive, toast }) {
  const btn = document.getElementById('realBtn')
  const panel = document.getElementById('real')
  if (!btn || !panel) return
  let ui = { open: false, height: 340, tab: 'positions', market: '', usd: 50, lev: 3 }
  try { ui = { ...ui, ...JSON.parse(localStorage.getItem(LS_UI)) } } catch {}
  const saveUI = () => { try { localStorage.setItem(LS_UI, JSON.stringify(ui)) } catch {} }
  let status = null // ответ /api/trade/status
  let acc = null // последний ответ /api/trade/account
  let accErr = ''
  let side = 'buy'
  let type = 'market'
  let busy = false

  async function call(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'X-Key': readKey(), 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    let j = {}
    try { j = await r.json() } catch {}
    if (!r.ok) throw new Error(j.error || 'Сервер ответил ' + r.status)
    return j
  }

  panel.innerHTML = `
    <div class="pp-resize" title="Тяните, чтобы изменить высоту"></div>
    <div class="pp-head">
      <b>💰 Реал</b>
      <select class="rt-market"></select>
      <span class="pp-sum"></span>
      <div class="pp-tabs"><button data-tab="positions">Позиции</button><button data-tab="orders">Ордера</button></div>
      <button class="pp-set-btn rt-refresh" title="Обновить">⟳</button>
      <button class="pp-hide" title="Скрыть панель">✕</button>
    </div>
    <div class="rt-warn"></div>
    <div class="pp-body">
      <form class="pp-form" autocomplete="off">
        <div class="pp-sym"></div>
        <div class="pp-side"><button type="button" data-side="buy" class="buy">Лонг / Купить</button><button type="button" data-side="sell" class="sell">Шорт / Продать</button></div>
        <div class="pp-types"><button type="button" data-type="market">Рынок</button><button type="button" data-type="limit">Лимит</button></div>
        <label class="pp-price-row">Цена <input name="price" type="number" step="any"></label>
        <label>Сумма, $ <input name="usd" type="number" step="any" min="0"></label>
        <label class="rt-fut">Плечо <input name="lev" type="number" min="1" max="125"></label>
        <label class="rt-fut">Стоп-лосс <input name="sl" type="number" step="any" placeholder="необязательно"></label>
        <label class="rt-fut">Тейк-профит <input name="tp" type="number" step="any" placeholder="необязательно"></label>
        <div class="pp-info"></div>
        <button type="submit" class="pp-submit"></button>
      </form>
      <div class="pp-table"></div>
    </div>`
  const $ = (s) => panel.querySelector(s)
  const form = $('.pp-form')
  const sel = $('.rt-market')
  sel.innerHTML = TRADE_MARKETS.map((m) => `<option value="${m.code}">${m.label}</option>`).join('')
  const isFut = () => ui.market === 'futures' || ui.market === 'bybit-futures'

  // ---------- видимость и размер ----------
  function applyOpen() {
    panel.classList.toggle('open', ui.open)
    btn.classList.toggle('active', ui.open)
    panel.style.height = ui.height + 'px'
    if (ui.open) { refresh(); render() }
  }
  btn.onclick = () => { ui.open = !ui.open; saveUI(); applyOpen() }
  $('.pp-hide').onclick = btn.onclick
  const handle = $('.pp-resize')
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    const y0 = e.clientY, h0 = panel.offsetHeight
    const move = (ev) => { ui.height = Math.max(150, Math.min(window.innerHeight * 0.7, h0 + (y0 - ev.clientY))); panel.style.height = ui.height + 'px' }
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); saveUI() }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  })
  for (const b of panel.querySelectorAll('.pp-tabs button')) b.onclick = () => { ui.tab = b.dataset.tab; saveUI(); render() }
  sel.onchange = () => { ui.market = sel.value; saveUI(); acc = null; accErr = ''; render(); refresh() }
  $('.rt-refresh').onclick = () => refresh()

  // ---------- данные ----------
  async function loadStatus() {
    if (!readKey()) { btn.hidden = true; return }
    try {
      status = await call('/api/trade/status')
      btn.hidden = false
      if (!ui.market || !TRADE_MARKETS.some((m) => m.code === ui.market)) ui.market = TRADE_MARKETS[0].code
      render()
    } catch {
      btn.hidden = true // не владелец или сервер недоступен
    }
  }
  async function refresh() {
    if (!ui.open || !status || !ui.market) return
    if (!status.accounts[ui.market]?.configured) { acc = null; accErr = ''; return render() }
    try {
      acc = await call('/api/trade/account', { market: ui.market })
      accErr = ''
    } catch (e) { accErr = e.message }
    render()
  }
  setInterval(() => { if (ui.open && !document.hidden && !busy) refresh() }, 5000)

  // ---------- отрисовка ----------
  function render() {
    if (!status) return
    sel.value = ui.market
    for (const b of panel.querySelectorAll('.pp-tabs button')) b.classList.toggle('active', b.dataset.tab === ui.tab)
    for (const b of panel.querySelectorAll('.pp-side button')) b.classList.toggle('active', b.dataset.side === side)
    for (const b of panel.querySelectorAll('.pp-types button')) b.classList.toggle('active', b.dataset.type === type)
    panel.querySelector('.pp-price-row').style.display = type === 'limit' ? '' : 'none'
    for (const el of panel.querySelectorAll('.rt-fut')) el.style.display = isFut() ? '' : 'none'
    const a = status.accounts[ui.market]
    const w = $('.rt-warn')
    if (!a?.configured) w.innerHTML = '⚠️ Для этого рынка на сервере нет API-ключа. Добавьте его командой <code>alertd-user keys set ' + esc(ui.market) + '</code> (см. README в tools/alertd).'
    else if (!status.enabled) w.innerHTML = '🔒 Торговля выключена на сервере — можно только смотреть счёт. Включить: <code>alertd-user trade on</code>'
    else w.innerHTML = a.testnet ? '🧪 Тестовая сеть биржи — деньги не настоящие.' : '⚡ Это НАСТОЯЩИЙ счёт. Лимит ордера: ' + esc(status.limits.max_order_usd) + ' $, плечо до ' + esc(status.limits.max_leverage) + '.'
    w.className = 'rt-warn' + (a?.configured && status.enabled && !a.testnet ? ' live' : '')
    w.style.display = w.innerHTML ? '' : 'none'
    const sum = $('.pp-sum')
    sum.innerHTML = accErr ? `<b class="down">${esc(accErr)}</b>` : acc ? `Баланс USDT: <b>${num(acc.usdt.total)}</b> · свободно <b>${num(acc.usdt.free)}</b>` : ''
    // форма
    const act = getActive()
    const same = act && act.market === ui.market
    $('.pp-sym').innerHTML = act ? `<b>${esc(act.symbol)}</b>${same ? '' : ' <em>другой рынок на графике!</em>'}<span>${num(act.price, 8)}</span>` : 'нет активного графика'
    const submit = $('.pp-submit')
    submit.className = 'pp-submit ' + side
    submit.textContent = (side === 'buy' ? 'Лонг / Купить ' : 'Шорт / Продать ') + (act?.symbol || '')
    submit.disabled = !(status.enabled && a?.configured)
    updateInfo()
    // таблицы
    const t = $('.pp-table')
    if (!a?.configured) { t.innerHTML = '<div class="pp-empty">Нет ключа для этого рынка.</div>'; return }
    if (!acc) { t.innerHTML = '<div class="pp-empty">Загрузка…</div>'; return }
    if (ui.tab === 'positions') {
      if (!isFut()) {
        const rows = Object.entries(acc.assets || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${num(v, 8)}</td></tr>`).join('')
        t.innerHTML = rows ? `<table><tr><th>Актив</th><th>Количество</th></tr>${rows}</table>` : '<div class="pp-empty">Активов нет.</div>'
        return
      }
      const rows = acc.positions.map((p) => `<tr><td><b>${esc(p.symbol)}</b></td><td class="${p.side === 'long' ? 'up' : 'down'}">${p.side === 'long' ? 'Лонг' : 'Шорт'}</td><td>${num(p.size, 8)}</td><td>${num(p.entry, 8)}</td><td>${num(p.mark, 8)}</td><td class="${+p.pnl >= 0 ? 'up' : 'down'}">${num(p.pnl)}</td><td>${num(p.leverage, 0)}x</td><td>${num(p.liq, 8)}</td><td class="pp-actions"><button data-close="${esc(p.symbol)}">Закрыть</button></td></tr>`).join('')
      t.innerHTML = rows ? `<table><tr><th>Монета</th><th>Сторона</th><th>Объём</th><th>Вход</th><th>Цена</th><th>PnL $</th><th>Плечо</th><th>Ликвид.</th><th></th></tr>${rows}</table>` : '<div class="pp-empty">Открытых позиций нет.</div>'
    } else {
      const rows = acc.orders.map((o) => `<tr><td><b>${esc(o.symbol)}</b></td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? 'Покупка' : 'Продажа'}</td><td>${esc(o.type)}${o.reduce ? ' <em>закрытие</em>' : ''}</td><td>${num(o.price || o.trigger, 8)}</td><td>${num(o.qty, 8)}</td><td class="pp-actions"><button data-cancel="${esc(o.id)}" data-sym="${esc(o.symbol)}" data-algo="${o.algo ? 1 : 0}">Отменить</button></td></tr>`).join('')
      t.innerHTML = rows ? `<table><tr><th>Монета</th><th>Сторона</th><th>Тип</th><th>Цена / триггер</th><th>Объём</th><th></th></tr>${rows}</table>` : '<div class="pp-empty">Открытых ордеров нет.</div>'
    }
  }

  function updateInfo() {
    const act = getActive()
    const info = $('.pp-info')
    const px = type === 'limit' ? parseFloat(form.price.value) : act?.price
    const usd = parseFloat(form.usd.value)
    if (!act || !px || !(usd > 0)) { info.textContent = ''; return }
    const lev = isFut() ? Math.max(1, parseInt(form.lev.value) || 1) : 1
    info.textContent = `Объём ≈ ${num(usd / px, 6)} ${act.symbol.replace(/USDT$/, '')}` + (isFut() ? ` · своих денег (залог) ≈ ${num(usd / lev)} $` : '')
  }

  // ---------- действия ----------
  for (const b of panel.querySelectorAll('.pp-side button')) b.onclick = () => { side = b.dataset.side; render() }
  for (const b of panel.querySelectorAll('.pp-types button')) b.onclick = () => { type = b.dataset.type; render() }
  form.usd.value = ui.usd
  form.lev.value = ui.lev
  form.oninput = () => { ui.usd = parseFloat(form.usd.value) || 0; ui.lev = parseInt(form.lev.value) || 1; saveUI(); updateInfo() }

  async function act(fn, okText) {
    if (busy) return
    busy = true
    try {
      const res = await fn()
      toast((res?.warnings?.length ? '⚠️ ' + res.warnings.join(' ') : okText), res?.warnings?.length ? 9000 : 4000)
    } catch (e) {
      toast('❌ ' + e.message, 9000)
    } finally {
      busy = false
      refresh()
    }
  }

  form.onsubmit = (e) => {
    e.preventDefault()
    const a = getActive()
    if (!a) return toast('Нет активного графика')
    if (a.market !== ui.market) return toast('Рынок графика (' + a.market + ') не совпадает с выбранным в панели. Переключите рынок на графике или в панели.')
    const px = type === 'limit' ? parseFloat(form.price.value) : a.price
    const usd = parseFloat(form.usd.value)
    if (!(px > 0) || !(usd > 0)) return toast('Впишите сумму' + (type === 'limit' ? ' и цену' : ''))
    const qty = usd / px
    const sl = parseFloat(form.sl.value) || 0
    const tp = parseFloat(form.tp.value) || 0
    const lev = isFut() ? parseInt(form.lev.value) || 1 : undefined
    const text = [
      'НАСТОЯЩАЯ СДЕЛКА',
      '',
      `${side === 'buy' ? 'Лонг / Купить' : 'Шорт / Продать'} ${a.symbol} (${TRADE_MARKETS.find((m) => m.code === ui.market).label})`,
      `Тип: ${type === 'limit' ? 'лимит по ' + px : 'по рынку, ≈ ' + a.price}`,
      `Сумма: ${usd} $ (≈ ${qty.toPrecision(5)} монет)` + (lev ? `, плечо ${lev}x` : ''),
      sl ? 'Стоп-лосс: ' + sl : 'Стоп-лосс: НЕТ',
      tp ? 'Тейк-профит: ' + tp : '',
      status.accounts[ui.market].testnet ? '(тестовая сеть)' : '',
      '',
      'Отправить на биржу?',
    ].filter((x, i) => x || i === 1 || i === 8).join('\n')
    if (!confirm(text)) return
    act(() => call('/api/trade/order', { market: ui.market, symbol: a.symbol, side, type, qty, price: type === 'limit' ? px : undefined, sl, tp, leverage: lev, confirm: true }), '✅ Ордер отправлен')
  }

  $('.pp-table').onclick = (e) => {
    const c = e.target.closest('button')
    if (!c) return
    if (c.dataset.close) {
      if (confirm(`Закрыть позицию ${c.dataset.close} по рынку и снять её ордера?`)) act(() => call('/api/trade/close', { market: ui.market, symbol: c.dataset.close, confirm: true }), '✅ Позиция закрыта')
    } else if (c.dataset.cancel) {
      if (confirm('Отменить ордер?')) act(() => call('/api/trade/cancel', { market: ui.market, symbol: c.dataset.sym, id: c.dataset.cancel, algo: c.dataset.algo === '1' }), '✅ Ордер отменён')
    }
  }

  addEventListener('hashchange', () => setTimeout(loadStatus, 500))
  btn.hidden = true
  loadStatus()
  applyOpen()
  // цена на графике меняется — обновляем подписи формы
  setInterval(() => { if (ui.open && status) { const s = $('.pp-sym'); const a = getActive(); if (a) { const sp = s.querySelector('span'); if (sp) sp.textContent = num(a.price, 8) } updateInfo() } }, 1000)
}
