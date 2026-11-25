// Добавляется на страницу при записи видеоинструкции:
//  1) подставные живые цены вместо WebSocket биржи (график «дышит», связь не обрывается),
//  2) видимая стрелка мыши и кружок при щелчке (в записи экрана курсора нет),
//  3) субтитры внизу экрана: window.__cap('текст').
(() => {
  // ---------- 1. Живые цены ----------
  const REST = 'https://fapi.binance.com/fapi/v1'
  const SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800, '12h': 43200, '1d': 86400, '1w': 604800 }
  const tick = {} // монета → { price, open, qv }
  const ready = fetch(REST + '/ticker/24hr')
    .then((r) => r.json())
    .then((list) => { for (const t of list) tick[t.symbol] = { price: +t.lastPrice, open: +t.openPrice, qv: +t.quoteVolume } })
    .catch(() => {})
  const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }
  setInterval(() => { for (const k in tick) tick[k].price *= Math.exp(randn() * 0.00018) }, 250)

  class FakeWS {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.timers = []
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}) }, 30)
    }
    send(data) {
      let m
      try { m = JSON.parse(data) } catch { return }
      if (m.method === 'SUBSCRIBE' && /binance/.test(this.url)) for (const s of m.params) this.sub(s)
    }
    emit(stream, data) { this.onmessage && this.onmessage({ data: JSON.stringify({ stream, data }) }) }
    every(ms, fn) { this.timers.push(setInterval(fn, ms)) }
    async sub(stream) {
      await ready
      const [name, type] = stream.split('@')
      const sym = name.toUpperCase()
      const T = tick[sym]
      if (!T) return
      if (type === 'miniTicker') {
        this.every(1000, () => this.emit(stream, { e: '24hrMiniTicker', s: sym, c: String(T.price), o: String(T.open), q: String(T.qv) }))
      } else if (type === 'aggTrade') {
        this.every(300, () => this.emit(stream, { e: 'aggTrade', E: Date.now(), s: sym, p: String(T.price), q: '0.01', T: Date.now() }))
      } else if (type.startsWith('kline_')) {
        const iv = type.slice(6)
        const sec = SEC[iv] || 3600
        let c = null
        try {
          const last = (await (await fetch(`${REST}/klines?symbol=${sym}&interval=${iv}&limit=1`)).json())[0]
          c = { t: last[0] / 1000, o: +last[1], h: +last[2], l: +last[3], c: +last[4], v: +last[5] }
        } catch {}
        this.every(500, () => {
          const bucket = Math.floor(Date.now() / 1000 / sec) * sec
          const p = T.price
          if (!c || c.t < bucket) c = { t: bucket, o: p, h: p, l: p, c: p, v: 0 }
          c.h = Math.max(c.h, p); c.l = Math.min(c.l, p); c.c = p; c.v += Math.random() * T.qv / 86400 / p * 0.5
          this.emit(stream, { e: 'kline', E: Date.now(), s: sym, k: { t: c.t * 1000, T: (c.t + sec) * 1000 - 1, s: sym, i: iv, o: String(c.o), c: String(c.c), h: String(c.h), l: String(c.l), v: String(c.v), x: false } })
        })
      }
    }
    close() {
      this.timers.forEach(clearInterval)
      this.readyState = 3
      this.onclose && this.onclose({})
    }
    addEventListener(t, fn) { this['on' + t] = fn }
    removeEventListener() {}
  }
  window.WebSocket = FakeWS

  // ---------- 2 и 3. Стрелка мыши и субтитры ----------
  const style = document.createElement('style')
  style.textContent = `
    #toast { display: none !important; }
    #__cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483646; pointer-events: none; opacity: 0; transition: opacity .2s; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
    .__ripple { position: fixed; z-index: 2147483645; pointer-events: none; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 3px solid #ffeb3b; animation: __rip .5s ease-out forwards; }
    @keyframes __rip { to { transform: scale(4); opacity: 0; } }
    #__cap { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%); z-index: 2147483647; pointer-events: none; max-width: 78%; text-align: center;
      font: 600 23px/1.3 system-ui, 'Segoe UI', Arial, sans-serif; color: #fff; background: rgba(10,12,20,.9); padding: 10px 22px; border-radius: 12px; opacity: 0; transition: opacity .25s; }
    #__cap.on { opacity: 1; }`
  const build = () => {
    document.head.append(style)
    const cur = document.createElement('div')
    cur.id = '__cursor'
    cur.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M3 2l15 9-6.5 1.6L8.6 19.5z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>'
    const cap = document.createElement('div')
    cap.id = '__cap'
    document.body.append(cur, cap)
    document.addEventListener('mousemove', (e) => { cur.style.opacity = 1; cur.style.transform = `translate(${e.clientX}px, ${e.clientY}px)` }, true)
    document.addEventListener('mousedown', (e) => {
      const r = document.createElement('div')
      r.className = '__ripple'
      r.style.left = e.clientX + 'px'
      r.style.top = e.clientY + 'px'
      document.body.append(r)
      setTimeout(() => r.remove(), 600)
    }, true)
    window.__cap = (text) => { cap.textContent = text || ''; cap.classList.toggle('on', !!text) }
  }
  if (document.body) build()
  else document.addEventListener('DOMContentLoaded', build)
})()
