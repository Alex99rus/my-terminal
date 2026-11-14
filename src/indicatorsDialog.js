// Окно «Индикаторы»: добавить, настроить, удалить.
import { INDICATORS, INDICATOR_ORDER, newIndicator } from './indicators.js'

/**
 * getList() — текущий список индикаторов
 * onChange(list) — список изменился (добавили, удалили, поменяли настройку)
 */
export function initIndicatorsDialog({ getList, onChange }) {
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
        ${INDICATOR_ORDER.map((t) => {
          const d = INDICATORS[t]
          return `<button data-type="${t}"><b>${d.name}</b><span>${d.title}</span><em>${d.overlay ? 'на свечах' : 'под графиком'}</em></button>`
        }).join('')}
      </div>
    </div>`
  document.body.append(overlay)

  const activeEl = overlay.querySelector('.ind-active')
  const close = () => overlay.classList.remove('open')
  overlay.querySelector('.modal-close').onclick = close
  overlay.addEventListener('pointerdown', (e) => e.target === overlay && close()) // щелчок мимо окна
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close())

  // Добавить индикатор
  for (const b of overlay.querySelectorAll('.ind-add button')) {
    b.onclick = () => {
      onChange([...getList(), newIndicator(b.dataset.type)])
      render()
    }
  }

  // Список добавленных: название, настройки, цвет, удалить
  function render() {
    const list = getList()
    if (!list.length) {
      activeEl.innerHTML = '<div class="ind-empty">Пока нет индикаторов — выберите ниже</div>'
      return
    }
    activeEl.innerHTML = list
      .map((ind) => {
        const def = INDICATORS[ind.type]
        const params = Object.entries(def.params)
          .map(([k, [label]]) => `<label>${label} <input type="number" min="1" step="${k === 'mult' ? 0.1 : 1}" data-id="${ind.id}" data-param="${k}" value="${ind.params[k]}"></label>`)
          .join('')
        return `<div class="ind-row">
          <input type="color" data-id="${ind.id}" value="${ind.color}" title="Цвет">
          <b>${def.name}</b>
          <span class="ind-params">${params}</span>
          <button class="ind-del" data-id="${ind.id}" title="Удалить">✕</button>
        </div>`
      })
      .join('')

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
