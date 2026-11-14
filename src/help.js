// Видеоинструкция по терминалу (кнопка «❓ Помощь») и связь с разработчиком
export const DEVELOPER_TG = 'https://t.me/vedmedik45'

const BASE = import.meta.env.BASE_URL || './'
const CHAPTERS = [
  { id: 'overview', title: 'Обзор терминала', len: '0:38', steps: ['Сверху — панель с основными кнопками', 'Слева — инструменты рисования', 'В центре — окна с графиками, справа — список монет'] },
  { id: 'symbol', title: 'Монета, рынок, таймфрейм', len: '1:04', steps: ['Впишите монету в поле сверху и нажмите Enter', 'Или щёлкните по монете в списке справа', 'Таймфрейм выбирается в каждом окне отдельно', 'Колесо мыши — масштаб, перетаскивание — листать историю'] },
  { id: 'layout', title: 'Окна и раскладки', len: '1:03', steps: ['Кнопка раскладки — от 1 до 6 окон', 'Границы между окнами тянутся мышью, двойной щелчок — выровнять', 'Значок ⠿ — поменять окна местами', '🔗 ✛ ⏱ — синхронизация монеты, перекрестия и времени'] },
  { id: 'draw', title: 'Рисование', len: '1:22', steps: ['Выберите инструмент слева и щёлкните по графику', 'Щелчок по рисунку — выбрать: цвет, толщина, оповещение', 'Delete — удалить, Esc — обычный курсор', 'Ctrl или кнопка магнита — прилипание к свечам'] },
  { id: 'ind', title: 'Индикаторы', len: '0:32', steps: ['Кнопка «ƒx Индикаторы»', 'Индикатор добавляется в активное окно', 'Там же — изменить настройки или удалить'] },
  { id: 'alerts', title: 'Оповещения', len: '0:35', steps: ['Инструмент 🔔 слева — оповещение на цене', 'Меню 🔔 сверху — все оповещения', '«Умное оповещение» — по индикаторам, закрытию свечи, движению'] },
  { id: 'paper', title: 'Демо-торговля', len: '0:39', steps: ['Кнопка «💼 Демо» — виртуальный счёт', 'Купить / Продать, тип заявки, количество', 'Стоп и тейк — в таблице или перетаскиванием на графике'] },
  { id: 'list', title: 'Список монет и скринер', len: '0:46', steps: ['«+ Добавить монету» или ☆ рядом с названием', 'Несколько списков — меню ⋯', 'Скринер: сортировка по столбцам и фильтры'] },
  { id: 'snap', title: 'Снимки и настройки', len: '0:23', steps: ['📷 Снимок — картинка окна в высоком разрешении', '⚙ — цвета, фон, линии, таймер свечи'] },
  { id: 'phone', title: 'Телефон и синхронизация', len: '0:26', steps: ['«📱 Телефон» → включить синхронизацию', 'Наведите камеру телефона на QR-код', 'Меню браузера → «Добавить на главный экран»'] },
]

let lastChapter = 'overview'

export function openHelp(id = lastChapter) {
  document.querySelector('.help-overlay')?.remove()
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay help-overlay open'
  overlay.innerHTML = `
    <div class="modal help-modal">
      <div class="modal-head"><b>❓ Видеоинструкция</b><button class="modal-close" title="Закрыть (Esc)">✕</button></div>
      <div class="help-body">
        <div class="help-list">
          ${CHAPTERS.map((c, i) => `
            <button class="help-item" data-id="${c.id}">
              <img src="${BASE}help/${c.id}.jpg" alt="" loading="lazy">
              <span><b>${i + 1}. ${c.title}</b><small>${c.len}</small></span>
            </button>`).join('')}
        </div>
        <div class="help-main">
          <video class="help-video" controls playsinline preload="metadata"></video>
          <div class="help-title"></div>
          <ul class="help-steps"></ul>
          <div class="help-nav"><button class="help-prev">← Назад</button><button class="help-next">Дальше →</button></div>
        </div>
      </div>
      <div class="help-foot">
        <span>Есть вопрос, нашли ошибку или хотите предложить идею? Напишите разработчику:</span>
        <a class="help-tg" href="${DEVELOPER_TG}" target="_blank" rel="noopener">✈ Написать в Telegram</a>
      </div>
    </div>`
  document.body.append(overlay)
  const video = overlay.querySelector('.help-video')

  function show(cid, autoplay) {
    const i = Math.max(0, CHAPTERS.findIndex((c) => c.id === cid))
    const c = CHAPTERS[i]
    lastChapter = c.id
    for (const b of overlay.querySelectorAll('.help-item')) b.classList.toggle('active', b.dataset.id === c.id)
    video.poster = `${BASE}help/${c.id}.jpg`
    video.src = `${BASE}help/${c.id}.mp4`
    overlay.querySelector('.help-title').textContent = `${i + 1}. ${c.title}`
    overlay.querySelector('.help-steps').innerHTML = c.steps.map((s) => `<li>${s}</li>`).join('')
    overlay.querySelector('.help-prev').disabled = i === 0
    overlay.querySelector('.help-next').disabled = i === CHAPTERS.length - 1
    overlay.querySelector('.help-prev').onclick = () => show(CHAPTERS[i - 1].id, true)
    overlay.querySelector('.help-next').onclick = () => show(CHAPTERS[i + 1].id, true)
    if (autoplay) video.play().catch(() => {})
  }
  for (const b of overlay.querySelectorAll('.help-item')) b.onclick = () => show(b.dataset.id, true)
  // досмотрели главу — через пару секунд предлагаем следующую
  video.onended = () => {
    const i = CHAPTERS.findIndex((c) => c.id === lastChapter)
    if (i < CHAPTERS.length - 1) overlay.querySelector('.help-next').classList.add('pulse')
  }
  video.onplay = () => overlay.querySelector('.help-next').classList.remove('pulse')

  const close = () => {
    video.pause()
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
  }
  const onKey = (e) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    close()
  }
  document.addEventListener('keydown', onKey, true)
  overlay.querySelector('.modal-close').onclick = close
  overlay.addEventListener('pointerdown', (e) => e.target === overlay && close())
  overlay.addEventListener('keydown', (e) => e.key !== 'Escape' && e.stopPropagation())
  show(id, false)
}
