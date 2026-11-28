// Объявления от владельца сайта: сверху над терминалом появляется плашка с текстом.
// Текст лежит на сервере (tools/alertd, команда `alertd-user news "текст"`); каждое объявление показывается один раз.
const SEEN = 'my-terminal-news-seen'

export function initNews() {
  const bar = document.createElement('div')
  bar.className = 'news-bar'
  bar.hidden = true
  bar.innerHTML = '<span class="news-ico">📢</span><span class="news-text"></span><button class="news-ok">Закрыть</button>'
  document.body.append(bar)
  let current = ''
  bar.querySelector('.news-ok').onclick = () => {
    bar.hidden = true
    try {
      localStorage.setItem(SEEN, current)
    } catch {}
  }
  async function check() {
    try {
      const r = await fetch('/api/news', { cache: 'no-store' })
      if (!r.ok) return
      const n = await r.json()
      if (!n?.id || !n.text) {
        bar.hidden = true // объявление убрали
        return
      }
      let seen = ''
      try {
        seen = localStorage.getItem(SEEN) || ''
      } catch {}
      if (seen === n.id) return
      current = n.id
      bar.querySelector('.news-text').textContent = n.text // именно текст, не разметка
      bar.hidden = false
    } catch {} // нет связи или сайт открыт без сервера — молча пропускаем
  }
  check()
  setInterval(check, 10 * 60 * 1000)
}
