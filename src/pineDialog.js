// Окна для своих индикаторов на Pine Script: вставить код и изменить настройки (input.*)
import { loadPine, pineTitle, pineInputs } from './pine.js'

function modal(cls, html) {
  document.querySelector('.' + cls)?.remove()
  const o = document.createElement('div')
  o.className = `modal-overlay ${cls} open`
  o.innerHTML = html
  document.body.append(o)
  const close = () => o.remove()
  o.querySelector('.modal-close').onclick = close
  o.addEventListener('pointerdown', (e) => e.target === o && close())
  o.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') close()
  })
  return [o, close]
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/** Вставить / изменить код. ind = null — новый индикатор */
export function openPineEditor(ind, onSave) {
  const [o, close] = modal('pine-overlay', `
    <div class="modal pine-modal">
      <div class="modal-head"><b>📜 ${ind ? 'Код индикатора' : 'Свой индикатор из TradingView'}</b><button class="modal-close">✕</button></div>
      ${ind ? '' : `<ol class="pine-how">
        <li>В TradingView откройте индикатор и нажмите <b>«{ }»</b> (Исходный код). Код открыт только у индикаторов с открытым исходным кодом.</li>
        <li>Выделите весь код (<b>Ctrl+A</b>), скопируйте (<b>Ctrl+C</b>) и вставьте сюда (<b>Ctrl+V</b>).</li>
        <li>Нажмите <b>«Добавить»</b> — индикатор появится во всех окнах.</li></ol>`}
      <textarea class="pine-code" spellcheck="false" placeholder="//@version=5&#10;indicator(&quot;Мой индикатор&quot;, overlay=true)&#10;plot(ta.ema(close, 20))">${esc(ind?.code || '')}</textarea>
      <div class="pine-err"></div>
      <div class="lr-btns"><span class="pine-note">Поддерживаются Pine Script v5 и v6. Сложные скрипты (таблицы, рисунки, данные других монет) могут работать не полностью.</span><button class="lr-save pine-save">${ind ? 'Сохранить' : 'Добавить'}</button></div>
    </div>`)
  const ta = o.querySelector('textarea')
  setTimeout(() => ta.focus(), 50)
  o.querySelector('.pine-save').onclick = async () => {
    const code = ta.value.trim()
    const err = o.querySelector('.pine-err')
    if (!/\b(indicator|study|strategy)\s*\(/.test(code)) {
      err.textContent = 'Это не похоже на код индикатора: в нём нет строки indicator(…). Скопируйте код целиком.'
      return
    }
    const btn = o.querySelector('.pine-save')
    btn.disabled = true
    btn.textContent = 'Проверяю…'
    try {
      const { Indicator } = await loadPine()
      const i = new Indicator(code)
      i.prepare() // разбор кода: синтаксические ошибки видны сразу
      i.getInputsMeta()
    } catch (e) {
      err.textContent = 'Не получилось разобрать код: ' + String(e?.message || e).split('\n')[0].slice(0, 300)
      btn.disabled = false
      btn.textContent = ind ? 'Сохранить' : 'Добавить'
      return
    }
    const name = pineTitle(code)
    if (ind) onSave({ ...ind, code, name, inputs: code === ind.code ? ind.inputs : {} })
    else onSave({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: 'pine', name, code, inputs: {}, color: '#e0a800' })
    close()
  }
}

/** Настройки индикатора (его input.*) */
export async function openPineInputs(ind, onSave) {
  let meta
  try {
    meta = await pineInputs(ind.code)
  } catch (e) {
    alert('Не удалось прочитать настройки: ' + e.message)
    return
  }
  const cur = ind.inputs || {}
  const key = (m) => m.title || m.name
  const TF = [['', 'как у графика'], ['1', '1м'], ['5', '5м'], ['15', '15м'], ['30', '30м'], ['60', '1ч'], ['240', '4ч'], ['D', '1Д'], ['W', '1Н']]
  let group = null
  const rows = meta
    .map((m, n) => {
      const v = cur[key(m)] ?? m.defval
      let head = ''
      if ((m.group || '') !== group) {
        group = m.group || ''
        if (group) head = `<div class="lr-sec">${esc(group)}</div>`
      }
      const id = `pi${n}`
      let field
      if (m.type === 'bool') field = `<input type="checkbox" data-i="${n}" ${v ? 'checked' : ''}>`
      else if (m.type === 'color') field = `<input type="color" data-i="${n}" value="${esc(String(v || '#2962ff').slice(0, 7))}">`
      else if (m.type === 'timeframe') field = `<select data-i="${n}">${TF.map(([c, l]) => `<option value="${c}" ${String(v) === c ? 'selected' : ''}>${l}</option>`).join('')}</select>`
      else if (m.options?.length) field = `<select data-i="${n}">${m.options.map((op) => `<option ${String(op) === String(v) ? 'selected' : ''}>${esc(op)}</option>`).join('')}</select>`
      else if (m.type === 'int' || m.type === 'float' || m.type === 'price')
        field = `<input type="number" data-i="${n}" value="${esc(v)}" step="${m.step ?? (m.type === 'int' ? 1 : 'any')}" ${m.minval != null ? `min="${m.minval}"` : ''} ${m.maxval != null ? `max="${m.maxval}"` : ''}>`
      else if (m.type === 'text_area') field = `<textarea data-i="${n}" rows="3">${esc(v)}</textarea>`
      else field = `<input type="text" data-i="${n}" value="${esc(v)}">`
      return `${head}<label class="lr-f pine-f" for="${id}" title="${esc(m.tooltip || '')}">${esc(key(m))}${field}</label>`
    })
    .join('')
  const [o, close] = modal('pine-overlay', `
    <div class="modal pine-modal">
      <div class="modal-head"><b>⚙ ${esc(ind.name)}</b><button class="modal-close">✕</button></div>
      <div class="pine-inputs">${rows || '<p class="muted">У этого индикатора нет настроек.</p>'}</div>
      <div class="lr-btns"><button class="pine-reset">Сбросить к стандартным</button><button class="lr-save">Сохранить</button></div>
    </div>`)
  o.querySelector('.pine-reset').onclick = () => {
    onSave({})
    close()
  }
  o.querySelector('.lr-save').onclick = () => {
    const out = {}
    for (const el of o.querySelectorAll('[data-i]')) {
      const m = meta[+el.dataset.i]
      let v = el.type === 'checkbox' ? el.checked : el.value
      if (m.type === 'int') v = parseInt(v, 10)
      else if (m.type === 'float' || m.type === 'price') v = parseFloat(String(v).replace(',', '.'))
      if (Number.isNaN(v)) continue
      const def = m.type === 'color' ? String(m.defval || '').slice(0, 7).toLowerCase() : m.defval
      if (String(v).toLowerCase() !== String(def).toLowerCase()) out[key(m)] = v
    }
    onSave(out)
    close()
  }
}
