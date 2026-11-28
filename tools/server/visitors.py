#!/usr/bin/env python3
"""Кто на самом деле заходил на сайт: настоящие посетители с городом и страной, без сканеров.

Настоящим считается адрес, у которого браузер открыл страницу И загрузил файлы сайта (/assets/…) —
сканеры обычно просят только отдельные адреса и файлы не грузят. Боты по названию программы тоже отсеиваются.

  python3 visitors.py [свой_IP …]       — свои адреса не показывать
"""
import glob
import gzip
import re
import sys
from collections import defaultdict
from datetime import datetime

LOG = '/var/log/nginx/access.log*'
DB = '/var/lib/GeoIP/dbip-city-lite.mmdb'
LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) \d+ "[^"]*" "([^"]*)"')
BOT_UA = re.compile(r'bot|crawl|spider|curl|wget|python|go-http|java|scan|leakix|censys|zgrab|nmap|masscan|headless|monitor|uptime|check', re.I)

try:
    import maxminddb

    geo = maxminddb.open_database(DB)
except Exception:  # noqa: BLE001
    geo = None


def where(ip):
    if not geo:
        return '—'
    try:
        r = geo.get(ip) or {}
        city = (r.get('city') or {}).get('names', {}).get('en', '')
        country = (r.get('country') or {}).get('names', {}).get('en', '')
        return ', '.join(x for x in (country, city) if x) or '—'
    except Exception:  # noqa: BLE001
        return '—'


def device(ua):
    for key, name in (('iPhone', 'iPhone'), ('iPad', 'iPad'), ('Android', 'Android'), ('Windows', 'Windows'), ('Macintosh', 'Mac'), ('Linux', 'Linux')):
        if key in ua:
            return name
    return '?'


def lines():
    for f in sorted(glob.glob(LOG)):
        op = gzip.open if f.endswith('.gz') else open
        with op(f, 'rt', errors='replace') as fh:
            yield from fh


own = set(sys.argv[1:])
v = defaultdict(lambda: {'page': 0, 'assets': 0, 'api': 0, 'days': set(), 'first': None, 'last': None, 'ua': ''})
for ln in lines():
    m = LINE.match(ln)
    if not m:
        continue
    ip, ts, _meth, path, status, ua = m.groups()
    if ip in own or BOT_UA.search(ua) or not ua or ua == '-':
        continue
    try:
        t = datetime.strptime(ts.split()[0], '%d/%b/%Y:%H:%M:%S')
    except ValueError:
        continue
    d = v[ip]
    if status == '200' and path == '/':
        d['page'] += 1
    elif status in ('200', '304') and path.startswith('/assets/'):
        d['assets'] += 1
    elif path.startswith('/api/'):
        d['api'] += 1
    else:
        continue
    d['days'].add(t.date())
    d['first'] = min(d['first'] or t, t)
    d['last'] = max(d['last'] or t, t)
    d['ua'] = ua

rows = [(ip, d) for ip, d in v.items() if (d['page'] or d['api']) and (d['assets'] or d['api'])]
rows.sort(key=lambda r: r[1]['last'], reverse=True)
print(f"Настоящие посетители (браузер загрузил сайт). Найдено: {len(rows)}\n")
print(f"{'Адрес':<16} {'Откуда':<34} {'Устройство':<9} {'Дней':>4} {'Открытий':>8} {'Сигналы':>7}  Последний раз")
for ip, d in rows:
    print(f"{ip:<16} {where(ip)[:34]:<34} {device(d['ua']):<9} {len(d['days']):>4} {d['page']:>8} {'да' if d['api'] else '':>7}  {d['last']:%d.%m %H:%M}")
if not geo:
    print('\n(Базы адресов нет — страны не показаны. Запустите stats-setup.sh и python3-maxminddb.)')
print('\nВремя — по часам сервера (UTC+1: на 2 часа раньше московского).')
