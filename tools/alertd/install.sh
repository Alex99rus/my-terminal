#!/usr/bin/env bash
# Установка сервера оповещений (alertd) на ваш сервер. Запускать под root:
#   curl -fsSL https://raw.githubusercontent.com/Alex99rus/my-terminal/main/tools/alertd/install.sh -o /tmp/alertd-install.sh && bash /tmp/alertd-install.sh
# Бота для торговли скрипт не трогает. Можно запускать повторно: настройки обновятся, ключ сохранится.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Запустите от root."; exit 1; }
command -v python3 >/dev/null || apt-get install -y python3
command -v git >/dev/null || apt-get install -y git
command -v curl >/dev/null || apt-get install -y curl

SRC=/opt/my-terminal-src
ENVF=/etc/alertd.env
SITE=/etc/nginx/sites-available/default

echo "1/6 Скачиваю программу…"
if [ -d "$SRC/.git" ]; then git -C "$SRC" pull -q --ff-only; else git clone -q --depth 1 https://github.com/Alex99rus/my-terminal.git "$SRC"; fi

echo "2/6 Создаю отдельного пользователя без прав входа…"
id alertd >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin alertd

echo "3/6 Настройка Телеграма"
if [ -f "$ENVF" ] && grep -q '^ALERTD_BOT_TOKEN=.\+' "$ENVF"; then
  read -rp "Телеграм уже настроен. Оставить как есть? [Y/n] " keep
  case "${keep:-Y}" in n|N) rm -f "$ENVF.keep";; *) cp "$ENVF" "$ENVF.keep";; esac
fi
KEY=""
if [ -f "$ENVF.keep" ]; then
  set -a; . "$ENVF.keep"; set +a
  TOKEN="$ALERTD_BOT_TOKEN"; CHAT="$ALERTD_CHAT_ID"; KEY="${ALERTD_KEY:-}"
  rm -f "$ENVF.keep"
else
  echo "Откройте в Телеграме @BotFather, отправьте /newbot, придумайте имя и логин бота (логин заканчивается на bot)."
  echo "Он пришлёт токен — длинную строку. Вставьте её сюда (на экране она не отображается) и нажмите Enter."
  read -rsp "Токен бота: " TOKEN; echo
  NAME=$(curl -fsS "https://api.telegram.org/bot${TOKEN}/getMe" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["username"])' 2>/dev/null) || { echo "Токен не подошёл. Проверьте и запустите снова."; exit 1; }
  echo "Бот найден: @${NAME}"
  echo "Теперь откройте этого бота в Телеграме и отправьте ему любое сообщение (например, /start)."
  read -rp "Когда отправите, нажмите Enter… " _
  CHAT=$(ALERTD_BOT_TOKEN="$TOKEN" python3 "$SRC/tools/alertd/alertd.py" --find-chat) || { echo "Сообщение боту не найдено. Отправьте ему /start и запустите скрипт снова."; exit 1; }
  echo "Чат найден."
fi
[ -n "$KEY" ] || KEY=$(python3 -c 'import secrets;print(secrets.token_hex(16))')
umask 077
printf 'ALERTD_BOT_TOKEN=%s\nALERTD_CHAT_ID=%s\nALERTD_KEY=%s\n' "$TOKEN" "$CHAT" "$KEY" > "$ENVF"
chmod 600 "$ENVF"

echo "4/6 Создаю службу…"
cat > /etc/systemd/system/alertd.service <<UNIT
[Unit]
Description=Terminal price alerts to Telegram
After=network-online.target
Wants=network-online.target

[Service]
User=alertd
EnvironmentFile=$ENVF
StateDirectory=alertd
ExecStart=/usr/bin/python3 $SRC/tools/alertd/alertd.py
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

echo "5/6 Подключаю к сайту (nginx)…"
cat > /etc/nginx/snippets/alertd.conf <<'NGX'
location /api/ {
    proxy_pass http://127.0.0.1:8787;
    client_max_body_size 256k;
    proxy_read_timeout 20s;
}
NGX
if ! grep -q 'snippets/alertd.conf' "$SITE"; then
  cp "$SITE" "$SITE.bak.alertd"
  python3 - "$SITE" <<'PY'
import re, sys
p = sys.argv[1]
t = open(p, encoding='utf-8').read()
m = re.search(r'^[ \t]*server_name [^;]+;\s*$', t, re.M)
if not m:
    sys.exit('в настройках nginx не найден server_name')
t = t[:m.end()] + '\n    include snippets/alertd.conf;' + t[m.end():]
open(p, 'w', encoding='utf-8').write(t)
PY
  if ! nginx -t 2>/dev/null; then
    cp "$SITE.bak.alertd" "$SITE"; nginx -t || true
    echo "Не получилось подключить к nginx, вернул как было. Пришлите это сообщение."; exit 1
  fi
fi
nginx -t && systemctl reload nginx

echo "6/6 Запускаю…"
systemctl daemon-reload
systemctl enable alertd >/dev/null 2>&1
systemctl restart alertd
sleep 2
systemctl is-active --quiet alertd || { journalctl -u alertd --no-pager -n 15; echo "Служба не запустилась."; exit 1; }
curl -fsS http://127.0.0.1:8787/api/alerts/ping >/dev/null && echo "Служба работает."

echo
echo "=================================================================="
echo "ГОТОВО. Ваш секретный ключ для терминала (никому не показывайте):"
echo
echo "    $KEY"
echo
echo "Откройте терминал → кнопка 🔔 → «Сигналы на телефон» → вставьте ключ."
echo "=================================================================="
