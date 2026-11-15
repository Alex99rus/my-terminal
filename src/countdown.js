// Таймер до закрытия свечи — как в TradingView: на шкале цены, прямо под меткой текущей цены.
// Показывает, сколько осталось до конца текущей свечи (5 минут, часа, дня…).
import { style } from './chartSettings.js'

// 125 → «02:05», 4000 → «01:06:40», 200000 → «2д 07:33»
export function fmtLeft(s) {
  s = Math.max(0, Math.floor(s))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const p = (n) => String(n).padStart(2, '0')
  if (d) return `${d}д ${p(h)}:${p(m)}`
  if (h) return `${p(h)}:${p(m)}:${p(sec)}`
  return `${p(m)}:${p(sec)}`
}

// Цвет текста под фон: на светлом фоне — тёмный, на тёмном — белый (как у метки цены)
function textOn(color) {
  const m = /^#?([0-9a-f]{6})/i.exec(color || '')
  if (!m) return '#fff'
  const n = parseInt(m[1], 16)
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
  return lum > 150 ? '#131722' : '#fff'
}

export class CountdownPrimitive {
  /** getBars() — свечи, getSec() — длина свечи в секундах, getSeries() — главная серия, isLine() — тип «линия» */
  constructor(getBars, getSec, getSeries, isLine) {
    this.getBars = getBars
    this.getSec = getSec
    this.getSeries = getSeries
    this.isLine = isLine
    const view = {
      coordinate: () => this.y,
      text: () => this.text,
      textColor: () => textOn(this.color),
      backColor: () => this.color,
      visible: () => this.y != null,
      tickVisible: () => false,
    }
    this._views = [view]
  }
  attached({ chart, requestUpdate }) {
    this._chart = chart
    this._request = requestUpdate
    // раз в секунду обновляем цифры; если окно закрыли (график удалён) — таймер останавливаем
    this._timer = setInterval(() => {
      try {
        requestUpdate()
      } catch {
        clearInterval(this._timer)
      }
    }, 1000)
  }
  detached() {
    this.stop()
  }
  // окно закрывают — таймер больше не нужен (иначе график, которого уже нет, будут просить перерисоваться)
  stop() {
    clearInterval(this._timer)
    this._request = null
  }
  priceAxisViews() {
    this.y = null
    if (!style.countdown || !style.priceLabel) return this._views
    const bars = this.getBars()
    const last = bars?.at(-1)
    const series = this.getSeries()
    if (!last || !series) return this._views
    // последняя свеча за краем экрана (смотрим историю) — метка цены тоже не там, таймер прячем
    const range = this._chart?.timeScale().getVisibleLogicalRange()
    if (range && range.to < bars.length - 1) return this._views
    const left = last.time + this.getSec() - Date.now() / 1000
    // свеча уже должна была закрыться (например, биржа сейчас не торгует) — таймер не показываем
    if (left <= 0 || left > this.getSec()) return this._views
    const y = series.priceToCoordinate(last.close)
    if (y == null) return this._views
    // ставим сразу под меткой цены: её высота ≈ размер шрифта + отступы
    this.y = y + style.fontSize + 7
    this.text = fmtLeft(left)
    this.color = this.isLine() ? style.lineColor : last.close >= last.open ? style.bodyUp : style.bodyDown
    return this._views
  }
}
