// Панель «Демо-счёт» внизу экрана: форма ордера, позиции, ордера, история, настройки счёта.
import { paper, fmtPrice, fmtUsd, fmtQty } from './paper.js'
import { draw } from './drawings.js'
import { marketShort } from './markets.js'

const STORAGE = 'my-terminal-paper-ui'

/**
 * getActive() — { key, symbol, market, price } монеты активного окна
 * onOpen(symbol, market) — открыть монету
 * toast(text) — короткое сообщение внизу экрана
 */
export function initPaperUI({ getActive, onOpen, toast }) {
  let ui = { open: false, height: 330, tab: 'positions' }
  try {
    ui = { ...ui, ...JSON.parse(localStorage.getItem(STORAGE)) }
  } catch {}
  const saveUI = () => localStorage.setItem(STORAGE, JSON.stringify(ui))

  const panel = document.getElementById('paper')
  panel.innerHTML = `
    <div class="pp-resize" title="Тяните, чтобы изменить высоту"></div>
    <div class="pp-head">
      <b>💼 Демо-счёт</b>
      <span class="pp-sum"></span>
      <div class="pp-tabs">
        <button data-tab="positions">Позиции</button>
        <button data-tab="orders">Открытые ордера</button>
        <button data-tab="history">История</button>
      </div>
      <div class="pp-set-wrap">
        <button class="pp-set-btn" title="Настройки счёта">⚙</button>
        <div class="pp-set">
          <label>Стартовый баланс, $ <input type="number" data-k="start" min="1"></label>
          <label title="Рыночные сделки, стоп-лосс (он рыночный), стоп-ордера">Комиссия тейкера, % <input type="number" data-k="fee" min="0" step="0.001"></label>
          <label title="Лимитные ордера и тейк-профит (он лимитный)">Комиссия мейкера, % <input type="number" data-k="makerFee" min="0" step="0.001"></label>
          <label>Плечо <input type="number" data-k="leverage" min="1" max="125"></label>
          <button class="pp-reset">Сбросить счёт (закрыть всё и начать заново)</button>
        </div>
      </div>
      <button class="pp-hide" title="Скрыть панель">✕</button>
    </div>
    <div class="pp-body">
      <form class="pp-form" autocomplete="off">
        <div class="pp-sym"></div>
        <div class="pp-side">
          <button type="button" data-side="buy" class="buy">Купить / Лонг</button>
          <button type="button" data-side="sell" class="sell">Продать / Шорт</button>
        </div>
        <div class="pp-types">
          <button type="button" data-type="market">Рынок</button>
          <button type="button" data-type="limit">Лимит</button>
          <button type="button" data-type="stop">Стоп</button>
        </div>
        <label class="pp-price-row">Цена <input name="price" type="number" step="any"></label>
        <label>Количество <span class="pp-qty-wrap"><input name="qty" type="number" step="any" min="0"><button type="button" class="pp-risk" title="Рассчитать объём так, чтобы при стопе потерять ровно сумму риска">по риску</button></span></label>
        <label>Стоп-лосс <input name="sl" type="number" step="any" placeholder="необязательно"></label>
        <label>Тейк-профит <input name="tp" type="number" step="any" placeholder="необязательно"></label>
        <div class="pp-info"></div>
        <button type="submit" class="pp-submit"></button>
      </form>
      <div class="pp-table"></div>
    </div>`

  const $ = (s) => panel.querySelector(s)
  const form = $('.pp-form')
  let side = 'buy'
  let type = 'market'

  // ---------- Открыть / скрыть, высота ----------
  const btn = document.getElementById('paperBtn')
  function applyOpen() {
    panel.classList.toggle('open', ui.open)
    btn.classList.toggle('active', ui.open)
    panel.style.height = ui.height + 'px'
    if (ui.open) render()
  }
  btn.onclick = () => {
    ui.open = !ui.open
    saveUI()
    applyOpen()
  }
  $('.pp-hide').onclick = btn.onclick
  const handle = $('.pp-resize')
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    const y0 = e.clientY
    const h0 = panel.offsetHeight
    document.body.classList.add('resizing-h')
    const move = (ev) => {
      ui.height = Math.max(150, Math.min(window.innerHeight * 0.7, h0 + (y0 - ev.clientY)))
      panel.style.height = ui.height + 'px'
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing-h')
      saveUI()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  })

  // ---------- Вкладки ----------
  for (const b of panel.querySelectorAll('.pp-tabs button')) {
    b.onclick = () => {
      ui.tab = b.dataset.tab
      saveUI()
      render()
    }
  }

  // ---------- Настройки счёта ----------
  const setBox = $('.pp-set')
  $('.pp-set-btn').onclick = () => {
    const a = paper.account
    for (const el of setBox.querySelectorAll('input')) el.value = a[el.dataset.k]
    setBox.classList.toggle('open')
  }
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.pp-set-wrap')) setBox.classList.remove('open')
  })
  for (const el of setBox.querySelectorAll('input')) {
    el.onchange = () => {
      const v = parseFloat(el.value.replace(',', '.'))
      if (!(v >= 0)) return
      paper.setSettings({ [el.dataset.k]: v })
    }
  }
  $('.pp-reset').onclick = () => {
    if (!confirm('Сбросить демо-счёт? Все позиции, ордера и история будут удалены.')) return
    paper.reset()
    setBox.classList.remove('open')
  }

  // ---------- Форма ордера ----------
  const num = (name) => {
    const v = parseFloat(String(form.elements[name].value).replace(',', '.'))
    return v > 0 ? v : null
  }
  function renderForm() {
    const a = getActive()
    $('.pp-sym').innerHTML = a ? `<b>${a.symbol}</b> <em>${marketShort(a.market)}</em> <span>${a.price ? fmtPrice(a.price) : '—'}</span>` : '—'
    for (const b of form.querySelectorAll('[data-side]')) b.classList.toggle('active', b.dataset.side === side)
    for (const b of form.querySelectorAll('[data-type]')) b.classList.toggle('active', b.dataset.type === type)
    $('.pp-price-row').style.display = type === 'market' ? 'none' : ''
    const submit = $('.pp-submit')
    submit.className = 'pp-submit ' + side
    submit.textContent = `${side === 'buy' ? 'Купить' : 'Продать'} ${type === 'market' ? 'по рынку' : type === 'limit' ? 'лимитом' : 'на пробое'}`
    // сколько это в долларах и сколько маржи займёт
    const px = type === 'market' ? a?.price : num('price')
    const qty = num('qty')
    const acc = paper.account
    const parts = []
    if (px && qty) parts.push(`Объём ≈ ${fmtUsd(px * qty)}`, `маржа ${fmtUsd((px * qty) / acc.leverage)} (×${acc.leverage})`)
    const sl = num('sl')
    if (px && qty && sl) parts.push(`риск ${fmtUsd(Math.abs(px - sl) * qty)}`)
    const tp = num('tp')
    if (px && sl && tp) parts.push(`${(Math.abs(tp - px) / Math.abs(px - sl)).toFixed(2).replace('.', ',')}R`)
    $('.pp-info').textContent = parts.join(' · ')
  }
  for (const b of form.querySelectorAll('[data-side]')) {
    b.onclick = () => {
      side = b.dataset.side
      renderForm()
    }
  }
  for (const b of form.querySelectorAll('[data-type]')) {
    b.onclick = () => {
      type = b.dataset.type
      const a = getActive()
      if (type !== 'market' && !num('price') && a?.price) form.elements.price.value = +a.price.toPrecision(8)
      renderForm()
    }
  }
  form.addEventListener('input', renderForm)
  // «по риску»: объём, при котором стоп = сумма риска (та же, что у инструмента позиции)
  $('.pp-risk').onclick = () => {
    const a = getActive()
    const px = type === 'market' ? a?.price : num('price')
    const sl = num('sl')
    if (!px || !sl) return toast('Сначала укажите стоп-лосс — объём считается от расстояния до стопа')
    const risk = draw.settings.risk
    form.elements.qty.value = +(risk / Math.abs(px - sl)).toPrecision(6)
    renderForm()
    toast(`Объём рассчитан на риск ${risk} $ (меняется в панели позиции: «Риск $»)`)
  }
  form.onsubmit = (e) => {
    e.preventDefault()
    const a = getActive()
    if (!a) return
    const err = paper.placeOrder({
      key: a.key, side, type, qty: num('qty'), price: num('price'), sl: num('sl'), tp: num('tp'),
    })
    if (err) return toast('⚠️ ' + err)
    toast(type === 'market' ? `💼 ${side === 'buy' ? 'Куплено' : 'Продано'} ${fmtQty(num('qty'))} ${a.symbol}` : '💼 Ордер выставлен — он виден на графике синей линией')
    form.elements.sl.value = ''
    form.elements.tp.value = ''
    renderForm()
  }

  // ---------- Таблицы ----------
  const sym = (key) => {
    const [market, symbol] = key.split(':')
    return `<a class="pp-open" data-key="${key}">${symbol}</a> <em>${marketShort(market)}</em>`
  }
  const pnlCell = (v) => `<td class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${fmtUsd(v)}</td>`
  const time = (ms) => new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

  function renderTable() {
    const acc = paper.account
    for (const b of panel.querySelectorAll('.pp-tabs button')) {
      b.classList.toggle('active', b.dataset.tab === ui.tab)
      const stops = acc.positions.reduce((n, p) => n + (p.sl != null) + (p.tp != null), 0)
      const n = b.dataset.tab === 'positions' ? acc.positions.length : b.dataset.tab === 'orders' ? acc.orders.length + stops : 0
      b.dataset.count = n || ''
    }
    let html = ''
    if (ui.tab === 'positions') {
      html = acc.positions.length
        ? `<table><tr><th>Монета</th><th>Сторона</th><th>Кол-во</th><th>Вход</th><th>Цена</th><th>Прибыль</th><th>%</th><th title="Стоп-лосс рыночный: при касании закрывается по рынку">Стоп (рын.)</th><th title="Тейк-профит лимитный: исполняется ровно по своей цене">Тейк (лимит)</th><th></th></tr>${acc.positions
            .map((p) => {
              const px = paper.price(p.key) ?? p.entry
              const pnl = paper.pnl(p)
              const pct = (pnl / ((p.qty * p.entry) / acc.leverage)) * 100
              return `<tr data-key="${p.key}"><td>${sym(p.key)}</td><td class="${p.side === 'long' ? 'up' : 'down'}">${p.side === 'long' ? 'Лонг' : 'Шорт'}</td>
                <td>${fmtQty(p.qty)}</td><td>${fmtPrice(p.entry)}</td><td class="px">${fmtPrice(px)}</td>${pnlCell(pnl).replace('<td class="', '<td class="pnl ')}
                <td class="pct ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2).replace('.', ',')}%</td>
                <td><a class="pp-edit" data-key="${p.key}" data-f="sl">${p.sl != null ? fmtPrice(p.sl) : '＋'}</a></td>
                <td><a class="pp-edit" data-key="${p.key}" data-f="tp">${p.tp != null ? fmtPrice(p.tp) : '＋'}</a></td>
                <td class="pp-actions"><button data-close="${p.key}" data-part="0.5" title="Закрыть половину">½</button><button data-close="${p.key}" data-part="1" title="Закрыть по рынку">Закрыть</button></td></tr>`
            })
            .join('')}</table>`
        : '<div class="pp-empty">Открытых позиций нет. Выберите «Купить» или «Продать» слева — или нарисуйте позицию на графике и нажмите «▶ В демо».</div>'
    } else if (ui.tab === 'orders') {
      // как «Открытые ордера» на Binance: ордера на вход + стоп-лосс и тейк-профит каждой позиции
      const rows = []
      for (const o of acc.orders) {
        const tpsl = o.tp != null || o.sl != null ? `${o.tp != null ? fmtPrice(o.tp) : '—'} / ${o.sl != null ? fmtPrice(o.sl) : '—'}` : '—'
        rows.push({ t: o.created, html: `<tr><td>${time(o.created)}</td><td>${sym(o.key)}</td><td>${o.type === 'limit' ? 'Лимит' : 'Стоп-маркет'}</td>
          <td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? 'Покупка' : 'Продажа'}</td>
          <td>${o.type === 'limit' ? fmtPrice(o.price) : 'Рынок'}</td>
          <td>${o.type === 'limit' ? '—' : `Цена ${o.side === 'buy' ? '≥' : '≤'} ${fmtPrice(o.price)}`}</td>
          <td>${fmtQty(o.qty)}</td><td>Нет</td><td>${tpsl}</td>
          <td class="pp-actions"><button data-cancel="${o.id}">Отменить</button></td></tr>` })
      }
      for (const p of acc.positions) {
        const long = p.side === 'long'
        const closeSide = `<td class="${long ? 'down' : 'up'}">${long ? 'Продажа' : 'Покупка'}</td>`
        if (p.sl != null)
          rows.push({ t: p.opened, html: `<tr><td>${time(p.opened)}</td><td>${sym(p.key)}</td><td>Стоп-маркет <span class="pp-tag sl">SL</span></td>${closeSide}
            <td>Рынок</td><td>Цена ${long ? '≤' : '≥'} ${fmtPrice(p.sl)}</td><td>Закрыть позицию</td><td>Да</td><td>—</td>
            <td class="pp-actions"><button class="pp-edit" data-key="${p.key}" data-f="sl">Изменить</button><button data-unstop="${p.key}" data-f="sl">Отменить</button></td></tr>` })
        if (p.tp != null)
          rows.push({ t: p.opened, html: `<tr><td>${time(p.opened)}</td><td>${sym(p.key)}</td><td>Тейк-профит лимит <span class="pp-tag tp">TP</span></td>${closeSide}
            <td>${fmtPrice(p.tp)}</td><td>Цена ${long ? '≥' : '≤'} ${fmtPrice(p.tp)}</td><td>Закрыть позицию</td><td>Да</td><td>—</td>
            <td class="pp-actions"><button class="pp-edit" data-key="${p.key}" data-f="tp">Изменить</button><button data-unstop="${p.key}" data-f="tp">Отменить</button></td></tr>` })
      }
      rows.sort((x, y) => y.t - x.t)
      html = rows.length
        ? `<table><tr><th>Время</th><th>Монета</th><th>Тип</th><th>Сторона</th><th>Цена</th><th>Условие</th><th>Кол-во</th><th title="Ордер только уменьшает / закрывает позицию">Уменьш.</th><th>Тейк / Стоп</th><th></th></tr>${rows.map((r) => r.html).join('')}</table>`
        : '<div class="pp-empty">Открытых ордеров нет. Здесь видны лимитные и стоп-ордера, а также стоп-лосс и тейк-профит каждой позиции.</div>'
    } else {
      const h = acc.history
      const wins = h.filter((t) => t.pnl > 0).length
      const net = h.reduce((s, t) => s + t.pnl - t.fee, 0)
      html = h.length
        ? `<div class="pp-stats">Сделок: <b>${h.length}</b> · прибыльных: <b>${Math.round((wins / h.length) * 100)}%</b> · итог с комиссиями: <b class="${net >= 0 ? 'up' : 'down'}">${net >= 0 ? '+' : ''}${fmtUsd(net)}</b></div>
          <table><tr><th>Закрыта</th><th>Монета</th><th>Сторона</th><th>Кол-во</th><th>Вход</th><th>Выход</th><th>Прибыль</th><th>Комиссия</th><th>Причина</th></tr>${h
            .map(
              (t) => `<tr><td>${time(t.closed)}</td><td>${sym(t.key)}</td><td class="${t.side === 'long' ? 'up' : 'down'}">${t.side === 'long' ? 'Лонг' : 'Шорт'}</td>
                <td>${fmtQty(t.qty)}</td><td>${fmtPrice(t.entry)}</td><td>${fmtPrice(t.exit)}</td>${pnlCell(t.pnl)}<td>${fmtUsd(t.fee)}</td><td>${t.reason}</td></tr>`,
            )
            .join('')}</table>`
        : '<div class="pp-empty">Закрытых сделок пока нет.</div>'
    }
    $('.pp-table').innerHTML = html
  }

  function renderSummary() {
    const s = paper.summary()
    const cls = (v) => (v >= 0 ? 'up' : 'down')
    $('.pp-sum').innerHTML =
      `Капитал <b>${fmtUsd(s.equity)}</b> · баланс ${fmtUsd(s.balance)} · ` +
      `открытые <b class="${cls(s.upnl)}">${s.upnl >= 0 ? '+' : ''}${fmtUsd(s.upnl)}</b> · маржа ${fmtUsd(s.margin)} · ` +
      `свободно ${fmtUsd(s.free)} · с начала <b class="${cls(s.total)}">${s.total >= 0 ? '+' : ''}${fmtUsd(s.total)}</b>`
  }

  // щелчки в таблице: открыть монету, закрыть, отменить, изменить стоп/тейк
  $('.pp-table').addEventListener('click', (e) => {
    const t = e.target
    if (t.closest('.pp-open')) {
      const [market, symbol] = t.closest('.pp-open').dataset.key.split(':')
      return onOpen(symbol, market)
    }
    const close = t.closest('[data-close]')
    if (close) return paper.close(close.dataset.close, +close.dataset.part)
    const cancel = t.closest('[data-cancel]')
    if (cancel) return paper.cancelOrder(cancel.dataset.cancel)
    const unstop = t.closest('[data-unstop]')
    if (unstop) return paper.setStops(unstop.dataset.unstop, { [unstop.dataset.f]: null })
    const edit = t.closest('.pp-edit')
    if (edit) {
      const field = edit.dataset.f
      const pos = paper.account.positions.find((p) => p.key === edit.dataset.key)
      const v = prompt(`${field === 'sl' ? 'Стоп-лосс' : 'Тейк-профит'} (пусто — убрать):`, pos?.[field] ?? '')
      if (v === null) return
      const n = parseFloat(v.replace(',', '.').replace(/\s/g, ''))
      paper.setStops(edit.dataset.key, { [field]: n > 0 ? n : null })
    }
  })

  // Новые цены: меняем только цифры в строках позиций (строки и кнопки остаются — щелчок не потеряется)
  function updateLive() {
    const acc = paper.account
    const rows = panel.querySelectorAll('.pp-table tr[data-key]')
    if (rows.length !== acc.positions.length) return renderTable()
    for (const row of rows) {
      const p = acc.positions.find((x) => x.key === row.dataset.key)
      if (!p) return renderTable()
      const pnl = paper.pnl(p)
      const pct = (pnl / ((p.qty * p.entry) / acc.leverage)) * 100
      const cls = pnl >= 0 ? 'up' : 'down'
      row.querySelector('.px').textContent = fmtPrice(paper.price(p.key) ?? p.entry)
      const pnlEl = row.querySelector('.pnl')
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + fmtUsd(pnl)
      pnlEl.className = 'pnl ' + cls
      const pctEl = row.querySelector('.pct')
      pctEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2).replace('.', ',') + '%'
      pctEl.className = 'pct ' + cls
    }
  }

  function render() {
    if (!ui.open) return
    renderSummary()
    renderForm()
    renderTable()
  }

  // цены меняются часто — перерисовываем не чаще 4 раз в секунду
  let timer = 0
  paper.subscribe((kind) => {
    if (kind === 'change') return render()
    if (timer) return
    timer = setTimeout(() => {
      timer = 0
      if (!ui.open) return
      renderSummary()
      if (ui.tab === 'positions') updateLive()
      const a = getActive()
      if (a?.price) panel.querySelector('.pp-sym span').textContent = fmtPrice(a.price)
    }, 250)
  })

  applyOpen()
  return { render }
}
