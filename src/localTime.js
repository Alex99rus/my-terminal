// Время на графике — в часовом поясе пользователя (а не по UTC, как по умолчанию у библиотеки).
// Свечи и границы дня остаются биржевыми (UTC) — меняются только подписи.

const two = (n) => String(n).padStart(2, '0')
const MONTHS = ['янв.', 'февр.', 'март', 'апр.', 'май', 'июнь', 'июль', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.']

/** Подписи на шкале времени. type: 0 — год, 1 — месяц, 2 — день, 3 — время, 4 — время с секундами */
export function tickMarkFormatter(time, type) {
  const d = new Date(time * 1000)
  switch (type) {
    case 0:
      return String(d.getFullYear())
    case 1:
      return MONTHS[d.getMonth()]
    case 2:
      return String(d.getDate())
    case 4:
      return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
    default:
      return `${two(d.getHours())}:${two(d.getMinutes())}`
  }
}

/** Подпись времени у перекрестия: «14 нояб. '26 15:53». withTime = false — только дата (для 1Д и 1Н) */
export function crosshairTime(time, withTime = true) {
  const d = new Date(time * 1000)
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]} '${String(d.getFullYear()).slice(2)}`
  return withTime ? `${date}  ${two(d.getHours())}:${two(d.getMinutes())}` : date
}
