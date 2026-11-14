// Рынки: биржа + вид торговли. Код рынка входит в «ключ» монеты (например 'bybit-futures:BTCUSDT'),
// поэтому рисунки, оповещения и списки у одной и той же монеты на разных биржах — свои.
export const MARKETS = [
  { code: 'futures', label: 'Binance фьючерсы', short: 'фьюч' },
  { code: 'spot', label: 'Binance спот', short: 'спот' },
  { code: 'bybit-futures', label: 'Bybit фьючерсы', short: 'Bybit фьюч' },
  { code: 'bybit-spot', label: 'Bybit спот', short: 'Bybit спот' },
]
export const marketLabel = (code) => MARKETS.find((m) => m.code === code)?.label || code
export const marketShort = (code) => MARKETS.find((m) => m.code === code)?.short || code
export const marketOptions = () => MARKETS.map((m) => `<option value="${m.code}">${m.label}</option>`).join('')
