// Бары OHLC, как в TradingView: вертикальная палочка всегда толщиной 1 пиксель,
// при любом приближении. Засечки открытия (слева) и закрытия (справа) растут вместе
// с расстоянием между барами, но не налезают на соседние бары.
// В библиотеке графиков бары при приближении становятся толстыми, поэтому рисуем их сами.

class ThinBarsRenderer {
  update(data, options) {
    this.data = data
    this.options = options
  }
  draw(target, priceToY) {
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const d = this.data
      const o = this.options
      if (!d?.visibleRange || !d.bars.length) return
      const k = o.thinScale || 1 // для снимков в высоком разрешении линии толще
      const lw = Math.max(1, Math.floor(hr * k)) // толщина линии
      const half = Math.floor(lw / 2)
      const tick = Math.max(lw, Math.round(Math.min(d.barSpacing * 0.28, 10) * hr)) // длина засечки
      const ticks = d.barSpacing >= 3 // при сильном отдалении — только палочки
      let color = null
      for (let i = d.visibleRange.from; i < d.visibleRange.to; i++) {
        const bar = d.bars[i]
        const b = bar.originalData
        if (b.close === undefined) continue
        const c = b.close >= b.open ? o.upColor : o.downColor
        if (c !== color) ctx.fillStyle = color = c
        const x = Math.round(bar.x * hr) - half
        const yh = Math.round(priceToY(b.high) * vr)
        const yl = Math.round(priceToY(b.low) * vr)
        ctx.fillRect(x, yh - half, lw, Math.max(lw, yl - yh + lw))
        if (!ticks) continue
        ctx.fillRect(x - tick, Math.round(priceToY(b.open) * vr) - half, tick, lw)
        ctx.fillRect(x + lw, Math.round(priceToY(b.close) * vr) - half, tick, lw)
      }
    })
  }
}

class ThinBarsView {
  constructor() {
    this._renderer = new ThinBarsRenderer()
  }
  renderer() {
    return this._renderer
  }
  update(data, options) {
    this._renderer.update(data, options)
  }
  priceValueBuilder(b) {
    return [b.high, b.low, b.close] // последнее значение — текущая цена (метка на шкале)
  }
  isWhitespace(b) {
    return b.close === undefined
  }
  defaultOptions() {
    return { upColor: '#26a69a', downColor: '#ef5350', color: '#26a69a', thinScale: 1 }
  }
}

// Заменитель BarSeries: addMainSeries ниже умеет создавать и обычные серии, и эту
export const ThinBarSeries = { custom: true, make: () => new ThinBarsView() }

export function addMainSeries(chart, ctor, options, paneIndex = 0) {
  return ctor.custom ? chart.addCustomSeries(ctor.make(), options, paneIndex) : chart.addSeries(ctor, options, paneIndex)
}
