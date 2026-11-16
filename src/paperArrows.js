// Стрелки демо-сделок на барах: ▲ / ▼ на свече, где вошли в позицию, и отметка выхода.
// Вход в лонг — зелёная стрелка вверх под свечой, в шорт — красная вниз над свечой.
// Выход — маленькая стрелка с другой стороны свечи, цветом по результату (+ / −).
import { style } from './chartSettings.js'

export class PaperArrowsPrimitive {
  constructor(pane) {
    this.pane = pane
    this.items = [] // { time (начало свечи), long, exit, color, text }
    this.view = { renderer: () => ({ draw: (t) => t.useMediaCoordinateSpace(({ context }) => this.draw(context)) }) }
  }
  attached({ requestUpdate }) {
    this.req = requestUpdate
  }
  detached() {
    this.req = null
  }
  paneViews() {
    return [this.view]
  }
  setItems(items) {
    this.items = items
    this.req?.()
  }
  draw(ctx) {
    if (style.paperArrows === false || !this.items.length) return
    const p = this.pane
    const a = p.adapter
    const series = p.candles
    // сколько стрелок уже стоит на свече сверху/снизу — следующие сдвигаем дальше
    const stack = new Map()
    ctx.save()
    ctx.font = '11px -apple-system, "Segoe UI", Roboto, sans-serif'
    ctx.textAlign = 'center'
    for (const it of this.items) {
      const i = p.indexAtOrBefore(it.time)
      const bar = p.bars[i]
      if (!bar) continue
      const x = a.timeToX(bar.time)
      if (x == null) continue
      const below = it.exit ? !it.long : it.long // где рисовать: под свечой или над ней
      const key = bar.time + (below ? 'b' : 'a')
      const n = stack.get(key) || 0
      stack.set(key, n + 1)
      const yBar = series.priceToCoordinate(below ? bar.low : bar.high)
      if (yBar == null) continue
      const size = it.exit ? 6 : 8
      const gap = 6 + n * (size * 2 + 16)
      const tip = below ? yBar + gap : yBar - gap // острие стрелки смотрит на свечу
      const dir = below ? 1 : -1
      ctx.fillStyle = it.color
      ctx.beginPath()
      ctx.moveTo(x, tip)
      ctx.lineTo(x + size, tip + dir * size)
      ctx.lineTo(x + size * 0.4, tip + dir * size)
      ctx.lineTo(x + size * 0.4, tip + dir * size * 2)
      ctx.lineTo(x - size * 0.4, tip + dir * size * 2)
      ctx.lineTo(x - size * 0.4, tip + dir * size)
      ctx.lineTo(x - size, tip + dir * size)
      ctx.closePath()
      ctx.fill()
      if (it.text) {
        ctx.textBaseline = below ? 'top' : 'bottom'
        ctx.fillText(it.text, x, tip + dir * (size * 2 + 2))
      }
    }
    ctx.restore()
  }
}
