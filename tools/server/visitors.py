#!/usr/bin/env python3
"""Кто на самом деле заходил на сайт: настоящие посетители с городом и страной, без сканеров.

Настоящим считается адрес, у которого браузер открыл страницу И загрузил файлы сайта (/assets/…),
или который успешно синхронизировал сигналы (нужен секретный ключ). Адреса облачных серверов и хостингов
(Amazon, Google, OVH, Hetzner…) показываются отдельно: это почти всегда роботы-проверяльщики.

  python3 visitors.py [--all] [свой_IP …]
     --all  — показать и облачные серверы тоже
"""
import glob
import gzip
import re
import sys
from collections import defaultdict
from datetime import datetime

LOG = '/var/log/nginx/access.log*'
DB = '/var/lib/GeoIP/dbip-city-lite.mmdb'
ASN_DB = '/var/lib/GeoIP/dbip-asn-lite.mmdb'
HOSTING = re.compile(
    r'amazon|aws|google|microsoft|azure|ovh|hetzner|digitalocean|linode|akamai|scaleway|oracle|contabo|vultr|choopa|'
    r'm247|datacamp|cdn77|leaseweb|quadranet|cloud|hosting|hoster|server|vps|colo|datacenter|data center|dedic|'
    r'constant|psychz|frantech|buyvm|ionos|upcloud|alibaba|tencent|huawei cloud|digital ocean|packet|equinix|zenlayer|'
    r'stark industries|aeza|selectel|timeweb|reg\.ru|firstbyte|vdsina|netcup|ipxo|ip volume|colocation|'
    r'clouvider|path network|cogent|zscaler|palo alto',
    re.I,
)
LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) \d+ "[^"]*" "([^"]*)"')
BOT_UA = re.compile(r'bot|crawl|spider|curl|wget|python|go-http|java|scan|leakix|censys|zgrab|nmap|masscan|headless|monitor|uptime|check', re.I)

def ensure_asn():
    """Если базы провайдеров нет — один раз скачать (около 9 МБ), так же как это делает geoip-update."""
    import os
    import subprocess
    from datetime import date, timedelta

    if os.path.exists(ASN_DB):
        return
    first = date.today().replace(day=1)
    for d in (first, first - timedelta(days=1)):
        url = f'https://download.db-ip.com/free/dbip-asn-lite-{d:%Y-%m}.mmdb.gz'
        tmp = '/tmp/dbip-asn.gz'
        r = subprocess.run(['curl', '-fsSL', '-A', 'Mozilla/5.0', url, '-o', tmp], capture_output=True, text=True)
        if r.returncode == 0:
            try:
                with open(tmp, 'rb') as f, open(ASN_DB, 'wb') as out:
                    out.write(gzip.decompress(f.read()))
                return
            except Exception as e:  # noqa: BLE001
                print('не удалось распаковать базу провайдеров:', e)
        else:
            print('не удалось скачать', url, '-', (r.stderr or '').strip()[:120])


try:
    import maxminddb

    geo = maxminddb.open_database(DB)
    ensure_asn()
    try:
        asn = maxminddb.open_database(ASN_DB)
    except Exception:  # noqa: BLE001
        asn = None
except Exception:  # noqa: BLE001
    geo = asn = None


def provider(ip):
    if not asn:
        return ''
    try:
        r = asn.get(ip) or {}
        return str(r.get('autonomous_system_organization') or r.get('organization') or '')
    except Exception:  # noqa: BLE001
        return ''


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


show_all = '--all' in sys.argv
own = {a for a in sys.argv[1:] if not a.startswith('--')}
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
    elif path.startswith('/api/alerts/sync') and status == '200':  # только с настоящим ключом
        d['api'] += 1
    else:
        continue
    d['days'].add(t.date())
    d['first'] = min(d['first'] or t, t)
    d['last'] = max(d['last'] or t, t)
    d['ua'] = ua

rows = [(ip, d) for ip, d in v.items() if (d['page'] and d['assets']) or d['api']]
rows.sort(key=lambda r: r[1]['last'], reverse=True)
cloud = [(ip, d) for ip, d in rows if HOSTING.search(provider(ip))] if asn else []
people = [r for r in rows if r not in cloud]


def table(title, rs):
    print(f"{title}: {len(rs)}\n")
    print(f"{'Адрес':<16} {'Откуда':<30} {'Провайдер':<24} {'Устройство':<9} {'Дней':>4} {'Откр.':>5} {'Сигн.':>5}  Последний раз")
    for ip, d in rs:
        print(f"{ip:<16} {where(ip)[:30]:<30} {provider(ip)[:24]:<24} {device(d['ua']):<9} {len(d['days']):>4} {d['page']:>5} {'да' if d['api'] else '':>5}  {d['last']:%d.%m %H:%M}")
    print()


table('Скорее живые люди (домашний и мобильный интернет)', people)
if cloud:
    if show_all:
        table('Облачные серверы и хостинги (скорее роботы)', cloud)
    else:
        print(f'Ещё {len(cloud)} адресов — облачные серверы и хостинги (скорее роботы). Показать: python3 visitors.py --all\n')
if not asn:
    print('(Базы провайдеров нет — разделить людей и облачные серверы не удалось.)')
print('Время — по часам сервера (UTC+1: на 2 часа раньше московского).')
