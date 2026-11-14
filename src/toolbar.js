// Панель инструментов рисования (слева) и панель настроек выделенного рисунка (сверху).
import { draw, TOOLS, COLORS } from './drawings.js'

// Значки — маленькие картинки SVG, нарисованные линиями
const svg = (inner) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
const ICONS = {
  cursor: svg('<path d="M6 3l12 9-5.5 1.2L15 20l-2.4 1-2.6-6.6L6 18z"/>'),
  hline: svg('<path d="M3 12h18"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'),
  hray: svg('<path d="M7 12h14"/><circle cx="6" cy="12" r="2"/>'),
  vline: svg('<path d="M12 3v18"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'),
  trend: svg('<path d="M6 18L18 6"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/>'),
  ray: svg('<path d="M6 18L21 3"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="12" r="2"/>'),
  rect: svg('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  fib: svg('<path d="M3 5h18M3 9.5h18M3 14h18M3 19h18"/>'),
  magnet: svg('<path d="M6 4v8a6 6 0 0012 0V4"/><path d="M6 8h4M14 8h4"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0122 12s-1 2-3 4M6.3 6.3C3.6 8 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
}

/**
 * getActiveKey() — монета активного окна (для «Удалить все рисунки»)
 * getPanes() — все окна (чтобы отменить незаконченный рисунок по Esc)
 */
export function initToolbar({ getActiveKey, getPanes }) {
  const bar = document.getElementById('toolbar')
  const props = document.getElementById('drawProps')

  // ---------- Кнопки слева ----------
  const toolButtons = TOOLS.map((t) => {
    const b = document.createElement('button')
    b.innerHTML = ICONS[t.code]
    b.title = t.title
    b.onclick = () => {
      cancelPlacing()
      draw.setTool(draw.tool === t.code ? 'cursor' : t.code) // повторный щелчок — выключить
    }
    bar.append(b)
    return [t.code, b]
  })
  bar.append(Object.assign(document.createElement('div'), { className: 'sep' }))

  const magnetBtn = document.createElement('button')
  magnetBtn.innerHTML = ICONS.magnet
  magnetBtn.title = 'Магнит: точки липнут к ценам свечей (или держите Ctrl)'
  magnetBtn.onclick = () => {
    const on = !draw.settings.magnet
    draw.setSetting('magnet', on)
    hint(on ? '🧲 Магнит включён: при рисовании точка прилипает к открытию, максимуму, минимуму или закрытию свечи' : 'Магнит выключен')
  }

  const hideBtn = document.createElement('button')
  hideBtn.onclick = () => draw.setSetting('hidden', !draw.settings.hidden)

  const clearBtn = document.createElement('button')
  clearBtn.innerHTML = ICONS.trash
  clearBtn.title = 'Удалить все рисунки этой монеты'
  clearBtn.onclick = () => {
    const key = getActiveKey()
    if (!key || !draw.list(key).length) return
    if (confirm(`Удалить все рисунки ${key.split(':')[1]}?`)) draw.clear(key)
  }
  bar.append(magnetBtn, hideBtn, clearBtn)

  // ---------- Настройки выделенного рисунка ----------
  props.innerHTML = `
    <div class="colors">${COLORS.map((c) => `<button class="color" data-color="${c}" style="background:${c}" title="Цвет"></button>`).join('')}</div>
    <span class="dp-sep"></span>
    ${[1, 2, 3, 4].map((w) => `<button class="width" data-width="${w}" title="Толщина ${w}"><i style="height:${w}px"></i></button>`).join('')}
    <span class="dp-sep"></span>
    <button class="dash" title="Пунктир"><i></i></button>
    <span class="dp-sep"></span>
    <button class="delete" title="Удалить (Delete)">${ICONS.trash}</button>`

  // меняем выделенный рисунок и запоминаем как стиль для следующих
  const change = (patch) => {
    const sel = draw.selected
    if (sel) draw.update(sel.key, sel.id, patch)
    for (const [k, v] of Object.entries(patch)) draw.setSetting(k, v)
  }
  for (const b of props.querySelectorAll('.color')) b.onclick = () => change({ color: b.dataset.color })
  for (const b of props.querySelectorAll('.width')) b.onclick = () => change({ width: +b.dataset.width })
  props.querySelector('.dash').onclick = () => change({ dash: !draw.selectedDrawing()?.dash })
  props.querySelector('.delete').onclick = () => deleteSelected()
  // щелчки по панели не должны снимать выделение
  props.addEventListener('pointerdown', (e) => e.stopPropagation())

  function deleteSelected() {
    const sel = draw.selected
    if (sel) draw.remove(sel.key, sel.id)
  }
  function cancelPlacing() {
    for (const p of getPanes()) p.drawCtl.cancel()
  }

  // ---------- Обновление вида ----------
  function render() {
    for (const [code, b] of toolButtons) b.classList.toggle('active', draw.tool === code)
    magnetBtn.classList.toggle('active', draw.settings.magnet || draw.ctrl)
    hideBtn.innerHTML = draw.settings.hidden ? ICONS.eyeOff : ICONS.eye
    hideBtn.title = draw.settings.hidden ? 'Показать рисунки' : 'Скрыть рисунки'
    hideBtn.classList.toggle('active', draw.settings.hidden)

    const d = draw.selectedDrawing()
    props.classList.toggle('show', !!d)
    if (d) {
      for (const b of props.querySelectorAll('.color')) b.classList.toggle('active', b.dataset.color === d.color)
      for (const b of props.querySelectorAll('.width')) b.classList.toggle('active', +b.dataset.width === d.width)
      props.querySelector('.dash').classList.toggle('active', !!d.dash)
    }
    document.body.classList.toggle('drawing', draw.tool !== 'cursor')
  }
  draw.subscribe(render)
  render()

  // Короткое сообщение внизу экрана
  let hintTimer
  function hint(text) {
    const el = document.getElementById('toast')
    if (!el) return
    el.textContent = text
    el.classList.add('show')
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => el.classList.remove('show'), 3500)
  }

  // Ctrl — временный магнит (пока держите)
  document.addEventListener('keydown', (e) => e.key === 'Control' && draw.setCtrl(true))
  document.addEventListener('keyup', (e) => e.key === 'Control' && draw.setCtrl(false))
  window.addEventListener('blur', () => draw.setCtrl(false))

  // ---------- Клавиши ----------
  const HOTKEYS = { KeyH: 'hline', KeyJ: 'hray', KeyV: 'vline', KeyT: 'trend', KeyR: 'rect', KeyF: 'fib' }
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return
    if (e.key === 'Escape') {
      cancelPlacing()
      draw.setTool('cursor')
      draw.select(null)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && draw.selected) {
      e.preventDefault()
      deleteSelected()
    } else if (e.altKey && HOTKEYS[e.code]) {
      e.preventDefault()
      cancelPlacing()
      draw.setTool(HOTKEYS[e.code])
    }
  })
}
