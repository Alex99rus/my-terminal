// Видеоинструкция по терминалу (кнопка «❓ Помощь»): видео с подписями и голосом, и связь с разработчиком
export const DEVELOPER_TG = 'https://t.me/vedmedik45'

const BASE = import.meta.env.BASE_URL || './'
const CHAPTERS = [
  { id: 'overview', title: 'Что где находится', len: '0:52', steps: ['Сверху — главная панель: монета, биржа, индикаторы, окна, оповещения, демо-счёт', 'Слева — инструменты рисования', 'В центре — график, справа — список ваших монет', 'Если что-то непонятно — нажмите ❓ наверху, тут собраны видео по каждой функции'] },
  { id: 'symbol', title: 'Как открыть другую монету', len: '0:46', steps: ['Впишите название монеты в поле сверху (например ETHUSDT) и нажмите Enter', 'Или просто щёлкните по монете в списке справа', 'Рядом выбирается рынок: фьючерсы или спот, Binance, Bybit, Мосбиржа', 'Таймфрейм — это время одной свечи (1 минута, 1 час, 1 день). Он выбирается в каждом окне отдельно', 'Колёсико мыши — масштаб, зажать левую кнопку и потянуть — прокрутка'] },
  { id: 'layout', title: 'Несколько графиков сразу', len: '0:43', steps: ['Нажмите кнопку раскладки наверху и выберите от 1 до 6 окон', '🔗 — одна монета во всех окнах', '✛ — перекрестие мыши видно во всех окнах', '⏱ — все графики двигаются к одному и тому же времени', 'Чтобы поменять окна местами, перетащите значок ⠿ из угла окна на другое окно'] },
  { id: 'draw', title: 'Как рисовать на графике', len: '1:05', steps: ['Выберите инструмент слева и щёлкните по графику', 'Щёлкните по рисунку — он выделится, и сверху появятся его настройки: цвет, толщина, цена', 'Цену можно ввести цифрами: впишите число в поле и нажмите Enter', 'Стрелки ↑↓ или колёсико мыши меняют цену на один шаг, а с зажатым Shift — на десять шагов', 'Лонг и шорт показывают вход, стоп и цель. В поле R:R впишите, например, 3 — и цель встанет втрое дальше стопа', 'Когда тянете точку, виден крестик-перекрестие. Магнит слева заставляет точку прилипать к цене свечи (или держите Ctrl)', 'Выделенный рисунок (в том числе всю рамку лонга или шорта) можно двигать аккуратно: стрелки ↑↓ — на один шаг цены, ←→ — на одну свечу; колёсико мыши над рисунком — по цене, с Alt — по времени. Shift — шаг в десять раз больше', 'Delete — удалить выделенный рисунок, Esc — вернуть обычный курсор'] },
  { id: 'ind', title: 'Индикаторы', len: '0:30', steps: ['Нажмите «ƒx Индикаторы» наверху', 'Выберите нужный в списке — он сразу появится на графике', 'В этом же окне можно поменять цвет и числа или убрать индикатор крестиком'] },
  { id: 'alerts', title: 'Оповещения — сигнал о цене', len: '0:32', steps: ['Нажмите 🔔 слева и щёлкните по графику на нужной цене — появится оранжевая линия', 'Все оповещения собраны в меню 🔔 наверху: там их видно и можно удалить', '«Умное оповещение» следит за индикаторами, закрытием свечи и резким движением цены', 'Сигнал на телефон (если у вас свой сервер): откройте на телефоне ссылку с ключом, которую показал установщик (tools/alertd/README.md), нажмите 🔔 → «Включить на этом устройстве». Тогда оповещение о цене придёт уведомлением, даже когда терминал закрыт. Друзьям — отдельные ссылки: команда alertd-user add Имя на сервере'] },
  { id: 'paper', title: 'Демо-счёт: торговля понарошку', len: '0:49', steps: ['Нажмите «💼 Демо» наверху — откроется счёт с виртуальными деньгами', 'Выберите «Купить» или «Продать», потом тип заявки: Рынок — сразу по текущей цене, Лимит и Стоп — когда цена дойдёт до вашей', 'Впишите цену и количество. Стоп-лосс — цена, где сделка закроется с убытком, тейк-профит — где с прибылью', 'Во вкладке «Открытые ордера» стоп и тейк видны сразу отдельными строками «после входа» — их можно изменить или отменить', 'Сработавшая сделка переходит во вкладку «Позиции», закрытые — в «Историю»'] },
  { id: 'list', title: 'Список монет и скринер', len: '0:39', steps: ['Впишите монету в поле «+ Добавить монету» и нажмите Enter, или нажмите ☆ рядом с названием наверху', 'Несколько списков создаются в меню ⋯', '«Скринер» сам ищет монеты: нажмите на название столбца, чтобы отсортировать', 'Кнопка «Фильтры» убирает лишнее, например монеты с маленьким оборотом'] },
  { id: 'snap', title: 'Снимок и настройки', len: '0:27', steps: ['📷 «Снимок» сохраняет чёткую картинку графика', 'Стрелка ▾ рядом: одно окно или все, качество, сохранить файлом или скопировать', '⚙ — цвета свечей, фон, сетка и линии'] },
  { id: 'phone', title: 'Телефон и синхронизация', len: '0:35', steps: ['Нажмите «📱 Телефон» → «Включить синхронизацию». Регистрация не нужна', 'Откройте этот же сайт на телефоне и вставьте ссылку или код в нижнее поле', 'В меню браузера на телефоне выберите «Добавить на главный экран» — терминал станет как приложение'] },
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
