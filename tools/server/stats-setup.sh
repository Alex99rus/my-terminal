#!/usr/bin/env bash
# Страница статистики /stats/: показать откуда заходят (страны, города) и убрать ботов. Запускать под root:
#   curl -fsSL https://raw.githubusercontent.com/Alex99rus/my-terminal/main/tools/server/stats-setup.sh -o /tmp/stats-setup.sh && bash /tmp/stats-setup.sh [свой_IP]
# «свой_IP» (необязательно) — ваши собственные заходы не попадут в отчёт.
# Можно запускать повторно. Сайт, бот и сигналы не затрагиваются.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите от root."; exit 1; }
OWN="${1:-}"
DB=/var/lib/GeoIP/dbip-city-lite.mmdb
OUT=/var/www/stats/index.html

echo "1/4 Скачиваю базу адресов (DB-IP, бесплатная, ~120 МБ)…"
cat > /usr/local/bin/geoip-update <<'UPD'
#!/bin/sh
# Обновляет базу адресов (раз в месяц выходит новая)
set -e
mkdir -p /var/lib/GeoIP
for m in "$(date +%Y-%m)" "$(date -d '-1 month' +%Y-%m)"; do
  if curl -fsSL "https://download.db-ip.com/free/dbip-city-lite-$m.mmdb.gz" -o /tmp/geoip.gz; then
    gunzip -f /tmp/geoip.gz && mv /tmp/geoip /var/lib/GeoIP/dbip-city-lite.mmdb && exit 0
  fi
done
echo "не удалось скачать базу"; exit 1
UPD
chmod 755 /usr/local/bin/geoip-update
geoip-update

echo "2/4 Пробный отчёт…"
EX=""; [ -n "$OWN" ] && EX="--exclude-ip=$OWN"
CMD="zcat -f /var/log/nginx/access.log* | grep -vE '\"(GET|POST) /api/' | goaccess - --log-format=COMBINED --ignore-crawlers --unknown-as-crawlers --ignore-status=404 --ignore-status=400 --geoip-database=$DB $EX -o"
if ! bash -c "$CMD /tmp/stats-test.html" >/tmp/stats-test.log 2>&1; then
  # запасной вариант: без необязательных ключей
  CMD="zcat -f /var/log/nginx/access.log* | grep -vE '\"(GET|POST) /api/' | goaccess - --log-format=COMBINED --ignore-crawlers --ignore-status=404 --geoip-database=$DB $EX -o"
  bash -c "$CMD /tmp/stats-test.html" >/tmp/stats-test.log 2>&1 || { cat /tmp/stats-test.log; echo "Не получилось собрать отчёт. Пришлите это сообщение."; exit 1; }
fi
grep -q -i "geo" /tmp/stats-test.html && echo "Панель с местоположением есть."
rm -f /tmp/stats-test.html

echo "3/4 Обновляю расписание…"
( { crontab -l 2>/dev/null || true; } | { grep -v -e goaccess -e geoip-update || true; }
  echo "*/5 * * * * $CMD $OUT >/dev/null 2>&1"
  echo "0 4 5 * * /usr/local/bin/geoip-update >/dev/null 2>&1" ) | crontab -
echo "4/4 Строю отчёт сейчас…"
bash -c "$CMD $OUT"
echo
echo "ГОТОВО. Обновите страницу https://alex-terminal.duckdns.org/stats/ (Ctrl+F5) и промотайте вниз до «Geo Location»."
