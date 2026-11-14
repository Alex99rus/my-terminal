// Окно «Индикаторы»: добавить, настроить, удалить.
import { INDICATORS, INDICATOR_ORDER, newIndicator } from './indicators.js'
import { LOCKED, lockedState, openLocked, onLockedChange } from './locked.js'

/**
 * getList() — текущий список индикаторов
 * onChange(list) — список изменился (добавили, удалили, поменяли настройку)
 */
export function initIndicatorsDialog({ getList, onChange, getVolume, setVolume }) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal ind-modal">
      <div class="modal-head">
        <b>Индикаторы</b>
        <button class="modal-close" title="Закрыть (Esc)">✕</button>
      </div>
      <div class="ind-section">На графике</div>
      <div class="ind-active"></div>
      <div class="ind-section">Добавить</div>
      <div class="ind-add">
        <button data-type="volume" class="ind-add-volume"><b>Объём</b><span>Столбики объёма торгов внизу графика</span><em>на свечах</em></button>
        ${INDICATOR_ORDER.map((t) => {
          const d = INDICATORS[t]
          return `<button data-type="${t}"><b>${d.name}</b><span>${d.title}</span><em>${d.overlay ? 'на свечах' : 'под графиком'}</em></button>`
        }).join('')}
      </div>
      <div class="ind-section">🔒 Закрытые индикаторы</div>
      <div class="ind-add ind-locked"></div>
    </div>`
  document.body.append(overlay)

  const activeEl = overlay.querySelector('.ind-active')
  const close = () => overlay.classList.remove('open')
  overlay.querySelector('.modal-close').onclick = close
  overlay.addEventListener('pointerdown', (e) => e.target === overlay && close()) // щелчок мимо окна
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close())

  // Добавить индикатор
  for (const b of overlay.querySelectorAll('.ind-add button')) {
    if (b.dataset.type === 'volume') {
      b.onclick = () => {
        setVolume(true)
        render()
      }
      continue
    }
    b.onclick = () => {
      onChange([...getList(), newIndicator(b.dataset.type)])
      render()
    }
  }

  // Закрытые индикаторы: по паролю
  const lockedEl = overlay.querySelector('.ind-locked')
  function renderLocked() {
    const label = { locked: '🔒 нужен пароль', on: '✓ включён — настроить', off: 'выключен — настроить' }
    lockedEl.innerHTML = LOCKED.map(
      (d) => `<button data-locked="${d.id}" class="st-${lockedState(d.id)}"><b>${d.name}</b><span>${d.title}</span><em>${label[lockedState(d.id)]}</em></button>`,
    ).join('')
    for (const b of lockedEl.querySelectorAll('[data-locked]')) {
      b.onclick = () => {
        close()
        openLocked(b.dataset.locked)
      }
    }
  }
  onLockedChange(renderLocked)

  // Список добавленных: название, настройки, цвет, удалить
  function render() {
    renderLocked()
    const list = getList()
    const vol = getVolume()
    overlay.querySelector('.ind-add-volume').style.display = vol ? 'none' : ''
    const volumeRow = vol
      ? `<div class="ind-row"><span class="ind-vol-icon">▮▮</span><b>Объём</b><span class="ind-params">столбики внизу графика</span><button class="ind-del" data-volume="1" title="Убрать объём">✕</button></div>`
      : ''
    if (!list.length && !vol) {
      activeEl.innerHTML = '<div class="ind-empty">Пока нет индикаторов — выберите ниже</div>'
      return
    }
    activeEl.innerHTML = volumeRow + list
      .map((ind) => {
        const def = INDICATORS[ind.type]
        const params = Object.entries(def.params)
          .map(([k, [label, , options]]) =>
            options
              ? `<label>${label} <select data-id="${ind.id}" data-param="${k}">${options.map((o) => `<option ${String(ind.params[k]) === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`
              : `<label>${label} <input type="number" min="0.1" step="any" data-id="${ind.id}" data-param="${k}" value="${ind.params[k]}"></label>`,
          )
          .join('')
        return `<div class="ind-row">
          <input type="color" data-id="${ind.id}" value="${ind.color}" title="Цвет">
          <b>${def.name}</b>
          <span class="ind-params">${params}</span>
          <button class="ind-del" data-id="${ind.id}" title="Удалить">✕</button>
        </div>`
      })
      .join('')

    for (const sel of activeEl.querySelectorAll('select[data-param]')) {
      sel.onchange = () => change(sel.dataset.id, (ind) => ({ ...ind, params: { ...ind.params, [sel.dataset.param]: sel.value } }))
    }
    for (const input of activeEl.querySelectorAll('input[data-param]')) {
      input.onchange = () => {
        const v = parseFloat(input.value.replace(',', '.'))
        if (!(v > 0)) return render() // неправильное число — вернуть как было
        change(input.dataset.id, (ind) => ({ ...ind, params: { ...ind.params, [input.dataset.param]: v } }))
      }
    }
    for (const input of activeEl.querySelectorAll('input[type=color]')) {
      input.oninput = () => change(input.dataset.id, (ind) => ({ ...ind, color: input.value }))
    }
    for (const b of activeEl.querySelectorAll('.ind-del')) {
      if (b.dataset.volume) {
        b.onclick = () => {
          setVolume(false)
          render()
        }
        continue
      }
      b.onclick = () => {
        onChange(getList().filter((i) => i.id !== b.dataset.id))
        render()
      }
    }
  }

  function change(id, fn) {
    onChange(getList().map((i) => (i.id === id ? fn(i) : i)))
  }

  return {
    open() {
      render()
      overlay.classList.add('open')
    },
  }
}
