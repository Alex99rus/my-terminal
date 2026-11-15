// Настройки внешнего вида графика: цвета свечей, фон, линии, перекрестие…
// Одни и те же для всех окон, запоминаются в браузере.

const STORAGE = 'my-terminal-chart-style'

export const DEFAULT_STYLE = {
  // свечи и бары
  bodyUp: '#26a69a',
  bodyDown: '#ef5350',
  wick: true,
  wickUp: '#26a69a',
  wickDown: '#ef5350',
  border: false,
  borderUp: '#26a69a',
  borderDown: '#ef5350',
  lineColor: '#2962ff', // тип «Линия» и «Область»
  // фон и шкалы
  bg: '#0e1116',
  text: '#d1d4dc',
  fontSize: 12,
  barThickness: 1, // толщина баров OHLC: 1–4 пикселя, 0 — авто (толще при приближении)
  rightOffset: 8, // отступ справа от последней свечи (в барах)
  // линии
  periodLines: true, // границы дня / недели / месяца / года
  periodColor: '#3a3f4b',
  grid: false,
  gridColor: '#1c2030',
  crosshairStyle: 'dashed',
  crosshairColor: '#9598a1',
  lastPriceLine: true,
  priceLabel: true,
  countdown: true, // таймер до закрытия свечи под меткой цены
  // объём
  volumeOpacity: 50, // %
}

let saved = {}
try {
  saved = JSON.parse(localStorage.getItem(STORAGE)) || {}
} catch {}
export const style = { ...DEFAULT_STYLE, ...saved }

const listeners = new Set()
export function onStyleChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function set(patch) {
  Object.assign(style, patch)
  localStorage.setItem(STORAGE, JSON.stringify(style))
  listeners.forEach((fn) => fn())
}

/** Цвет с прозрачностью: '#26a69a', 50 → '#26a69a80' */
export function withAlpha(color, percent) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color
  return color + Math.round((percent / 100) * 255).toString(16).padStart(2, '0')
}

// Вид линии в библиотеке графиков: 0 — сплошная, 1 — точки, 2 — пунктир
export const LINE_STYLE = { solid: 0, dotted: 1, dashed: 2 }

// ---------- Окно настроек ----------

// Описание полей окна: [раздел, [поле, подпись, вид]]
const SECTIONS = [
  ['Свечи и бары', [
    ['bodyUp', 'Рост — тело', 'color'],
    ['bodyDown', 'Падение — тело', 'color'],
    ['wick', 'Фитили', 'check'],
    ['wickUp', 'Рост — фитиль', 'color'],
    ['wickDown', 'Падение — фитиль', 'color'],
    ['border', 'Контур свечей', 'check'],
    ['borderUp', 'Рост — контур', 'color'],
    ['borderDown', 'Падение — контур', 'color'],
    ['barThickness', 'Толщина баров (тип «Бары»)', 'select', [[1, 'тонкие — 1 пиксель'], [2, 'средние — 2'], [3, 'толстые — 3'], [4, 'очень толстые — 4'], [0, 'авто — толще при приближении']]],
    ['lineColor', 'Линия и область', 'color'],
  ]],
  ['Фон и шкалы', [
    ['bg', 'Фон графика', 'color'],
    ['text', 'Текст шкал', 'color'],
    ['fontSize', 'Размер текста', 'select', [10, 11, 12, 13, 14, 16]],
    ['rightOffset', 'Отступ справа от последней свечи', 'select', [[0, 'нет'], [3, '3 бара'], [5, '5 баров'], [8, '8 баров'], [12, '12 баров'], [20, '20 баров'], [40, '40 баров']]],
  ]],
  ['Линии', [
    ['periodLines', 'Границы дня / недели / месяца / года', 'check'],
    ['periodColor', 'Цвет границ', 'color'],
    ['grid', 'Сетка', 'check'],
    ['gridColor', 'Цвет сетки', 'color'],
    ['crosshairStyle', 'Перекрестие', 'select', [['dashed', 'пунктир'], ['dotted', 'точки'], ['solid', 'сплошное']]],
    ['crosshairColor', 'Цвет перекрестия', 'color'],
    ['lastPriceLine', 'Линия текущей цены', 'check'],
    ['priceLabel', 'Метка цены на шкале', 'check'],
    ['countdown', 'Таймер до закрытия свечи', 'check'],
  ]],
  ['Объём', [
    ['volumeOpacity', 'Яркость столбиков объёма', 'select', [[25, '25%'], [50, '50%'], [75, '75%'], [100, '100%']]],
  ]],
]

export function openChartSettings() {
  document.querySelector('.settings-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay settings-overlay open'
  overlay.innerHTML = `
    <div class="modal settings-modal">
      <div class="modal-head"><b>Настройки графика</b><button class="modal-close" title="Закрыть (Esc)">✕</button></div>
      ${SECTIONS.map(([title, fields]) => `
        <div class="ind-section">${title}</div>
        <div class="st-grid">
          ${fields.map(([key, label, kind, options]) => {
            if (kind === 'color') return `<label class="st-row"><input type="color" data-key="${key}"> ${label}</label>`
            if (kind === 'check') return `<label class="st-row st-check"><input type="checkbox" data-key="${key}"> ${label}</label>`
            const opts = options.map((o) => (Array.isArray(o) ? o : [o, o]))
            return `<label class="st-row">${label} <select data-key="${key}">${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>`
          }).join('')}
        </div>`).join('')}
      <button class="st-reset">Сбросить всё по умолчанию</button>
    </div>`
  document.body.append(overlay)

  const fill = () => {
    for (const el of overlay.querySelectorAll('[data-key]')) {
      const v = style[el.dataset.key]
      if (el.type === 'checkbox') el.checked = !!v
      else el.value = String(v)
    }
    // подсветить, какие цвета сейчас не действуют (например, фитили выключены)
    const dim = { wickUp: !style.wick, wickDown: !style.wick, borderUp: !style.border, borderDown: !style.border, periodColor: !style.periodLines, gridColor: !style.grid }
    for (const el of overlay.querySelectorAll('input[type=color]')) el.closest('label').classList.toggle('off', !!dim[el.dataset.key])
  }
  fill()

  for (const el of overlay.querySelectorAll('[data-key]')) {
    const key = el.dataset.key
    const apply = () => {
      let v = el.type === 'checkbox' ? el.checked : el.value
      if (typeof DEFAULT_STYLE[key] === 'number') v = +v
      set({ [key]: v })
      fill()
    }
    el.addEventListener(el.type === 'color' ? 'input' : 'change', apply)
  }
  overlay.querySelector('.st-reset').onclick = () => {
    set({ ...DEFAULT_STYLE })
    fill()
  }
  const close = () => overlay.remove()
  overlay.querySelector('.modal-close').onclick = close
  overlay.addEventListener('pointerdown', (e) => e.target === overlay && close())
  overlay.addEventListener('keydown', (e) => e.key === 'Escape' && close())
  overlay.tabIndex = -1
  overlay.focus()
}
