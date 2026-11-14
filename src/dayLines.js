// Вертикальные линии на границах дня — на таймфреймах до 1 часа включительно.
// День — как у бирж: по UTC (00:00 UTC = 03:00 по Москве), там же, где начинается дневная свеча.

const MAX_SEC = 3600 // показываем на 1м … 1ч
const COLOR = '#3a3f4b'

export class DayLinesPrimitive {
  /**
   * chart — график, getBars() — свечи, getSec() — длина свечи в секундах
   * scale — для снимков (линии толще пропорционально)
   */
  constructor(chart, getBars, getSec, scale = 1) {
    this.chart = chart
    this.getBars = getBars
    this.getSec = getSec
    this.k = scale
    this._view = {
      zOrder: () => 'bottom', // под свечами
      renderer: () => ({
        draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.render(context, mediaSize)),
      }),
    }
  }
  attached({ requestUpdate }) {
    this._request = requestUpdate
  }
  detached() {
    this._request = null
  }
  paneViews() {
    return [this._view]
  }

  render(ctx, size) {
    if (this.getSec() > MAX_SEC) return
    const bars = this.getBars()
    const ts = this.chart.timeScale()
    const range = ts.getVisibleLogicalRange()
    if (!range || bars.length < 2) return
    const from = Math.max(1, Math.floor(range.from))
    const to = Math.min(bars.length - 1, Math.ceil(range.to))
    // расстояние между соседними свечами — линия встаёт посередине между ними
    const step = (ts.logicalToCoordinate(1) ?? 0) - (ts.logicalToCoordinate(0) ?? 0)
    ctx.save()
    ctx.strokeStyle = COLOR
    ctx.lineWidth = this.k
    ctx.setLineDash([4 * this.k, 4 * this.k])
    ctx.beginPath()
    for (let i = from; i <= to; i++) {
      // свеча i — первая в новом дне
      if (Math.floor(bars[i].time / 86400) === Math.floor(bars[i - 1].time / 86400)) continue
      const x = ts.logicalToCoordinate(i)
      if (x == null) continue
      const xx = Math.round(x - step / 2) + 0.5
      ctx.moveTo(xx, 0)
      ctx.lineTo(xx, size.height)
    }
    ctx.stroke()
    ctx.restore()
  }
}
