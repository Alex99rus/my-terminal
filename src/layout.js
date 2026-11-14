// Раскладки окон и границы между ними, которые можно тянуть мышью.
//
// Раскладка — это «карта» из букв: каждая буква — одно окно (a — первое, b — второе…).
// Например ['a a', 'b c'] — окно a занимает всю верхнюю строку, b и c делят нижнюю.
// cols / rows — начальные доли ширины столбцов и высоты строк.

export const LAYOUTS = {
  1: { title: '1 окно', areas: ['a'], cols: [1], rows: [1] },
  2: { title: '2 окна рядом', areas: ['a b'], cols: [1, 1], rows: [1] },
  '2v': { title: '2 окна друг под другом', areas: ['a', 'b'], cols: [1], rows: [1, 1] },
  3: { title: 'Большое слева + 2', areas: ['a b', 'a c'], cols: [2, 1], rows: [1, 1] },
  '3r': { title: 'Большое справа + 2', areas: ['b a', 'c a'], cols: [1, 2], rows: [1, 1] },
  '3t': { title: 'Большое сверху + 2 снизу', areas: ['a a', 'b c'], cols: [1, 1], rows: [2, 1] },
  '3b': { title: '2 сверху + большое снизу', areas: ['b c', 'a a'], cols: [1, 1], rows: [1, 2] },
  4: { title: '4 окна', areas: ['a b', 'c d'], cols: [1, 1], rows: [1, 1] },
  6: { title: '6 окон', areas: ['a b c', 'd e f'], cols: [1, 1, 1], rows: [1, 1] },
}
export const LAYOUT_ORDER = ['1', '2', '2v', '3', '3r', '3t', '3b', '4', '6']
export const LETTERS = 'abcdef'

// Сколько окон в раскладке
export const paneCount = (key) => new Set(LAYOUTS[key].areas.join(' ').split(' ')).size

const GAP = 2 // ширина щели между окнами, px (как gap в style.css)
const MIN_SIZE = 120 // окно нельзя сделать уже/ниже этого, px

// Нарисовать раскладку в элементе-сетке (и в большом поле, и в маленьком значке кнопки)
export function applyGridTemplate(el, key, sizes) {
  const L = LAYOUTS[key]
  el.style.gridTemplateAreas = L.areas.map((r) => `"${r}"`).join(' ')
  el.style.gridTemplateColumns = (sizes?.cols || L.cols).map((f) => f + 'fr').join(' ')
  el.style.gridTemplateRows = (sizes?.rows || L.rows).map((f) => f + 'fr').join(' ')
}

/**
 * Границы между окнами. grid — элемент с окнами.
 * getKey() — текущая раскладка, getSizes()/setSizes() — сохранённые размеры.
 */
export function createSplitters(grid, { getKey, getSizes, setSizes }) {
  const layer = document.createElement('div')
  layer.className = 'splitters'
  grid.append(layer)

  // Текущие доли столбцов и строк (копия, чтобы менять при перетаскивании)
  const current = () => {
    const L = LAYOUTS[getKey()]
    const s = getSizes()
    return { cols: [...(s?.cols || L.cols)], rows: [...(s?.rows || L.rows)] }
  }

  // Размеры столбцов (или строк) в пикселях
  function trackPx(fracs, totalPx) {
    const free = totalPx - GAP * (fracs.length - 1)
    const sum = fracs.reduce((a, b) => a + b, 0)
    return fracs.map((f) => (f / sum) * free)
  }

  // Где начинается каждый столбец/строка
  function starts(px) {
    const out = []
    let pos = 0
    for (const p of px) {
      out.push(pos)
      pos += p + GAP
    }
    return out
  }

  // Расставить «ручки» границ поверх сетки
  // Ручки не пересоздаём, а только двигаем: иначе ту, которую сейчас тянут, «вырвало» бы из-под мыши
  const handles = new Map() // 'v0', 'h1'… → элемент
  let seen = new Set()

  function render() {
    seen = new Set()
    const key = getKey()
    const L = LAYOUTS[key]
    const cells = L.areas.map((r) => r.split(' ')) // [строка][столбец] → буква окна
    const { cols, rows } = current()
    const W = grid.clientWidth
    const H = grid.clientHeight
    const colPx = trackPx(cols, W)
    const rowPx = trackPx(rows, H)
    const colStart = starts(colPx)
    const rowStart = starts(rowPx)

    // Вертикальные границы — между столбцами k и k+1
    for (let k = 0; k < cols.length - 1; k++) {
      // в каких строках здесь правда стык двух разных окон
      const rs = cells.map((row, r) => (row[k] !== row[k + 1] ? r : -1)).filter((r) => r >= 0)
      if (!rs.length) continue
      const top = rowStart[rs[0]]
      const bottom = rowStart[rs.at(-1)] + rowPx[rs.at(-1)]
      addHandle('v', k, colStart[k + 1] - GAP / 2, top, bottom - top)
    }
    // Горизонтальные границы — между строками k и k+1
    for (let k = 0; k < rows.length - 1; k++) {
      const cs = cells[k].map((c, i) => (c !== cells[k + 1][i] ? i : -1)).filter((i) => i >= 0)
      if (!cs.length) continue
      const left = colStart[cs[0]]
      const right = colStart[cs.at(-1)] + colPx[cs.at(-1)]
      addHandle('h', k, rowStart[k + 1] - GAP / 2, left, right - left)
    }
    // ручки, которых в этой раскладке нет, убираем
    for (const [id, el] of handles) {
      if (!seen.has(id)) {
        el.remove()
        handles.delete(id)
      }
    }
  }

  // Одна ручка. dir 'v' — вертикальная граница (тянем влево-вправо), 'h' — горизонтальная
  function addHandle(dir, k, pos, from, length) {
    const id = dir + k
    seen.add(id)
    let h = handles.get(id)
    if (!h) {
      h = createHandle(dir, k)
      handles.set(id, h)
      layer.append(h)
    }
    if (dir === 'v') Object.assign(h.style, { left: pos + 'px', top: from + 'px', height: length + 'px' })
    else Object.assign(h.style, { top: pos + 'px', left: from + 'px', width: length + 'px' })
  }

  function createHandle(dir, k) {
    const h = document.createElement('div')
    h.className = `splitter ${dir}`
    h.title = 'Тяните, чтобы изменить размер. Двойной щелчок — поровну'

    h.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      h.setPointerCapture(e.pointerId)
      h.classList.add('dragging')
      document.body.classList.add(dir === 'v' ? 'resizing-v' : 'resizing-h')
      const sizes = current()
      const list = dir === 'v' ? sizes.cols : sizes.rows
      const total = dir === 'v' ? grid.clientWidth : grid.clientHeight
      const px = trackPx(list, total)
      const sum = list.reduce((a, b) => a + b, 0)
      const fracPerPx = sum / px.reduce((a, b) => a + b, 0)
      const startPos = dir === 'v' ? e.clientX : e.clientY
      const a0 = px[k]
      const b0 = px[k + 1]

      const move = (ev) => {
        let d = (dir === 'v' ? ev.clientX : ev.clientY) - startPos
        d = Math.max(MIN_SIZE - a0, Math.min(b0 - MIN_SIZE, d)) // не даём окну стать слишком маленьким
        list[k] = (a0 + d) * fracPerPx
        list[k + 1] = (b0 - d) * fracPerPx
        setSizes(sizes, false)
        applyGridTemplate(grid, getKey(), sizes)
        render()
      }
      const up = () => {
        h.removeEventListener('pointermove', move)
        h.removeEventListener('pointerup', up)
        h.removeEventListener('pointercancel', up)
        h.classList.remove('dragging')
        document.body.classList.remove('resizing-v', 'resizing-h')
        setSizes(sizes, true) // сохраняем
      }
      h.addEventListener('pointermove', move)
      h.addEventListener('pointerup', up)
      h.addEventListener('pointercancel', up)
    })

    // Двойной щелчок — два соседних окна снова поровну
    h.addEventListener('dblclick', () => {
      const sizes = current()
      const list = dir === 'v' ? sizes.cols : sizes.rows
      const half = (list[k] + list[k + 1]) / 2
      list[k] = list[k + 1] = half
      setSizes(sizes, true)
      applyGridTemplate(grid, getKey(), sizes)
      render()
    })

    return h
  }

  // При изменении размера окна браузера — переставить ручки
  new ResizeObserver(render).observe(grid)

  return { render }
}
