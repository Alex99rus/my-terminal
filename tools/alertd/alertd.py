#!/usr/bin/env python3
"""Сервер оповещений: следит за ценами и присылает уведомление на телефон, когда цена дошла до уровня.

Терминал присылает сюда список ваших оповещений о цене (POST /api/alerts/sync) и «подписку» телефона
(как у сайтов с push-уведомлениями). Сервер проверяет цены каждые несколько секунд и, когда уровень
достигнут, отправляет push (и, если настроено, сообщение в Телеграм). Работает, даже если терминал закрыт.
Нужен только пакет python3-cryptography (ставит install.sh).

Пользователей может быть несколько (вы и друзья): у каждого свой ключ, свои оповещения и свои телефоны.
Управление — командой на сервере:  alertd-user add Имя | list | del Имя

Настройки берутся из переменных окружения (файл /etc/alertd.env):
  ALERTD_SUBJECT     адрес вашего сайта, например https://alex-terminal.duckdns.org (нужен push-службам)
  ALERTD_BOT_TOKEN   (необязательно) токен Telegram-бота
  ALERTD_CHAT_ID     (необязательно) номер чата в Телеграме
  ALERTD_KEY         ключ владельца (пользователь «owner»); остальные — через alertd-user
  ALERTD_PORT        порт (по умолчанию 8787), слушает только 127.0.0.1
  ALERTD_DATA        папка для файла с оповещениями (по умолчанию /var/lib/alertd)
"""
import hashlib
import hmac
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import webpush

BOT = os.environ.get('ALERTD_BOT_TOKEN', '')
CHAT = os.environ.get('ALERTD_CHAT_ID', '')
KEY = os.environ.get('ALERTD_KEY', '')
SUBJECT = os.environ.get('ALERTD_SUBJECT', 'https://example.org')
PORT = int(os.environ.get('ALERTD_PORT', '8787'))
DATA = os.environ.get('ALERTD_DATA', '/var/lib/alertd')
POLL_SEC = 1
KEEP_FIRED_SEC = 30 * 86400
MAX_ALERTS = 500
MAX_BODY = 200_000
MAX_SUBS = 20
MAX_USERS = 50

# где брать цены: рынок терминала → (адрес, как разобрать ответ)
PRICE_URLS = {
    'futures': 'https://fapi.binance.com/fapi/v1/ticker/price',
    'spot': 'https://api.binance.com/api/v3/ticker/price',
    'bybit-futures': 'https://api.bybit.com/v5/market/tickers?category=linear',
    'bybit-spot': 'https://api.bybit.com/v5/market/tickers?category=spot',
}
MARKET_NAMES = {'futures': 'Binance фьюч', 'spot': 'Binance спот', 'bybit-futures': 'Bybit фьюч', 'bybit-spot': 'Bybit спот'}

lock = threading.Lock()
# users: имя → {alerts: id → {...}, fired: id → {at, price}, subs: адрес → подписка телефона}
state = {'users': {}}
vapid = {'priv': None, 'pub': ''}


def log(*a):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), *a, flush=True)


def load():
    try:
        with open(os.path.join(DATA, 'alerts.json'), encoding='utf-8') as f:
            s = json.load(f)
        if 'users' in s:
            state['users'] = s['users']
        else:  # старый формат (один пользователь) → «owner»
            state['users'] = {'owner': {'alerts': s.get('alerts', {}), 'fired': s.get('fired', {}), 'subs': s.get('subs', {})}}
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        log('не удалось прочитать файл оповещений:', e)


def save():
    try:
        os.makedirs(DATA, exist_ok=True)
        tmp = os.path.join(DATA, 'alerts.json.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False)
        os.replace(tmp, os.path.join(DATA, 'alerts.json'))
    except Exception as e:  # noqa: BLE001
        log('не удалось сохранить:', e)


def user(name):
    return state['users'].setdefault(name, {'alerts': {}, 'fired': {}, 'subs': {}})


# ---------- Пользователи и ключи ----------
def users_path():
    return os.path.join(DATA, 'users.json')


def key_hash(k):
    return hashlib.sha256(k.encode()).hexdigest()


def read_users():
    """{имя: хэш ключа}. Сам ключ нигде не хранится — только его отпечаток."""
    try:
        with open(users_path(), encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


_users_cache = {'mtime': -1, 'map': {}}


def key_to_user(k):
    """Имя пользователя по ключу или None."""
    if not k:
        return None
    try:
        m = os.path.getmtime(users_path())
    except OSError:
        m = 0
    if m != _users_cache['mtime']:
        _users_cache['mtime'] = m
        _users_cache['map'] = {h: n for n, h in read_users().items()}
    h = key_hash(k)
    found = None
    for hh, n in _users_cache['map'].items():  # перебираем все, без раннего выхода
        if hmac.compare_digest(hh, h):
            found = n
    if KEY and hmac.compare_digest(key_hash(KEY), h):
        found = 'owner'
    return found


def cli_users(args):
    import re
    import secrets

    us = read_users()
    if KEY:
        us.setdefault('owner', key_hash(KEY))
    cmd = args[0] if args else 'list'
    name = args[1] if len(args) > 1 else ''
    if cmd == 'list':
        load()
        for n in us:
            u = state['users'].get(n, {})
            print(f"{n}: оповещений {len(u.get('alerts', {}))}, телефонов {len(u.get('subs', {}))}")
        return 0
    if cmd in ('add', 'del'):
        if not re.fullmatch(r'[\w-]{1,30}', name):
            print('Укажите имя: буквы, цифры, - или _ (до 30 знаков)')
            return 1
        stored = read_users()
        if cmd == 'add':
            if name == 'owner' or name in stored:
                print('Такое имя уже есть')
                return 1
            if len(stored) >= MAX_USERS:
                print('Слишком много пользователей')
                return 1
            k = secrets.token_hex(16)
            stored[name] = key_hash(k)
            write_users(stored)
            print(f'Пользователь {name} добавлен. Ссылка для него (в ней секретный ключ, отдайте только ему):')
            print(f'\n    {SUBJECT}/#alertkey={k}\n')
            return 0
        if name not in stored:
            print('Такого пользователя нет')
            return 1
        del stored[name]
        write_users(stored)
        print(f'Пользователь {name} удалён, его ключ больше не работает.')
        return 0
    print('Команды: add Имя | list | del Имя')
    return 1


def write_users(d):
    os.makedirs(DATA, exist_ok=True)
    tmp = users_path() + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f)
    os.chmod(tmp, 0o644)
    os.replace(tmp, users_path())


def http_json(url, data=None, timeout=10):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': 'alertd/1'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def fetch_prices(market):
    """Все цены рынка одним запросом: { 'BTCUSDT': 65000.0, ... }"""
    url = PRICE_URLS[market]
    d = http_json(url)
    if market.startswith('bybit'):
        return {t['symbol']: float(t['lastPrice']) for t in d['result']['list']}
    return {t['symbol']: float(t['price']) for t in d}


def fmt(p):
    p = float(p)
    if p >= 1000:
        return f'{p:,.2f}'.replace(',', ' ')
    dec = 4 if p >= 1 else 6 if p >= 0.01 else 8
    return f'{p:.{dec}f}'


def send_telegram(text):
    if not BOT or not CHAT:
        return False
    try:
        body = urllib.parse.urlencode({'chat_id': CHAT, 'text': text}).encode()
        d = http_json(f'https://api.telegram.org/bot{BOT}/sendMessage', body)
        return bool(d.get('ok'))
    except Exception as e:  # noqa: BLE001
        log('ошибка отправки в Телеграм:', type(e).__name__)  # без текста ошибки: в нём может быть токен
        return False


def send_push(name, text):
    """Отправляет уведомление на телефоны пользователя. Возвращает, сколько приняли."""
    with lock:
        subs = list(user(name)['subs'].values())
    title, _, body = text.partition('\n')
    payload = json.dumps({'title': title, 'body': body, 'url': './'}, ensure_ascii=False).encode()
    ok, dead = 0, []
    for s in subs:
        code = webpush.send(s, payload, vapid['priv'], vapid['pub'], SUBJECT)
        if 200 <= code < 300:
            ok += 1
        elif code in (404, 410):
            dead.append(s['endpoint'])
        else:
            log('push не принят, код', code)
    if dead:
        with lock:
            for e in dead:
                user(name)['subs'].pop(e, None)
            save()
    return ok


def send_all(name, text):
    """Push + (для владельца, если настроен) Телеграм. True, если хоть куда-то дошло."""
    a = send_push(name, text)
    b = send_telegram(text) if name == 'owner' and BOT and CHAT else False
    return bool(a) or b


def check_once(get_prices=fetch_prices, send=send_all):
    """Один проход: сработавшие оповещения отправляются и переходят в «сработавшие»."""
    with lock:
        by_market = {}
        for u in state['users'].values():
            for a in u['alerts'].values():
                by_market.setdefault(a['market'], set()).add(a['symbol'])
    hits = []
    for market in by_market:
        try:
            prices = get_prices(market)
        except Exception as e:  # noqa: BLE001
            log('нет цен', market, type(e).__name__)
            continue
        with lock:
            for name, u in state['users'].items():
                for i, a in list(u['alerts'].items()):
                    if a['market'] != market:
                        continue
                    p = prices.get(a['symbol'])
                    if p is None:
                        continue
                    if a['dir'] == 'cross':
                        prev = a.get('prev')
                        a['prev'] = p
                        if prev is not None and prev != p and (prev - a['price']) * (p - a['price']) <= 0:
                            a['up'] = p > prev
                            hits.append((name, i, a, p))
                    elif (a['dir'] == 'up' and p >= a['price']) or (a['dir'] == 'down' and p <= a['price']):
                        hits.append((name, i, a, p))
    for name, i, a, p in hits:
        if a['dir'] == 'cross':
            text = f"🔔 {a['symbol']} ({MARKET_NAMES.get(a['market'], a['market'])}) пересёк {'вверх' if a.get('up') else 'вниз'}: {a.get('label', 'линия')} ({fmt(a['price'])})\nСейчас: {fmt(p)}"
        else:
            arrow = 'вырос до' if a['dir'] == 'up' else 'упал до'
            text = f"🔔 {a['symbol']} ({MARKET_NAMES.get(a['market'], a['market'])}) {arrow} {fmt(a['price'])}\nСейчас: {fmt(p)}"
        ok = send(name, text)
        with lock:
            u = user(name)
            u['alerts'].pop(i, None)
            u['fired'][i] = {'at': int(time.time() * 1000), 'price': p, 'sent': ok}
        log('сработало', name, a['symbol'], a['price'], 'отправлено' if ok else 'НЕ отправлено')
    if hits:
        with lock:
            save()
    return len(hits)


def loop():
    while True:
        try:
            check_once()
            cutoff = (time.time() - KEEP_FIRED_SEC) * 1000
            with lock:
                for u in state['users'].values():
                    for i in [i for i, f in u['fired'].items() if f['at'] < cutoff]:
                        del u['fired'][i]
                # удалённых пользователей забываем
                known = set(read_users()) | {'owner'}
                for n in [n for n in state['users'] if n not in known]:
                    del state['users'][n]
        except Exception as e:  # noqa: BLE001
            log('ошибка цикла:', type(e).__name__, e)
        time.sleep(POLL_SEC)


def clean_alert(a):
    """Проверяет присланное оповещение; возвращает аккуратную запись или None."""
    try:
        i = str(a['id'])[:40]
        market = str(a['market'])
        symbol = str(a['symbol']).upper()
        price = float(a['price'])
        d = a['dir']
        if market not in PRICE_URLS or d not in ('up', 'down', 'cross') or not (price > 0) or not symbol.isalnum() or len(symbol) > 20:
            return None
        out = {'market': market, 'symbol': symbol, 'price': price, 'dir': d}
        try:
            out['armed'] = float(a.get('armed') or 0)  # когда оповещение поставлено или запущено снова (мс, часы устройства)
        except (TypeError, ValueError):
            out['armed'] = 0
        if d == 'cross':  # оповещение на линии: сработает, когда цена пересечёт уровень в любую сторону
            out['label'] = str(a.get('label') or 'линия')[:40]
        return i, out
    except Exception:  # noqa: BLE001
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = 'alertd'

    def log_message(self, *a):  # тихо
        pass

    def reply(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def who(self):
        return key_to_user(self.headers.get('X-Key', ''))

    def do_POST(self):
        path = self.path.split('?')[0]
        name = self.who()
        if not name:
            time.sleep(0.5)  # чтобы подбор ключа был бесполезен
            return self.reply(403, {'error': 'bad key'})
        try:
            n = int(self.headers.get('Content-Length', '0'))
            if n > MAX_BODY:
                return self.reply(413, {'error': 'too big'})
            body = json.loads(self.rfile.read(n) or b'{}')
        except Exception:  # noqa: BLE001
            return self.reply(400, {'error': 'bad json'})
        if path == '/api/alerts/test':
            n = send_push(name, '✅ Проверка\nОповещения с терминала будут приходить сюда.')
            tg = send_telegram('✅ Проверка: оповещения с терминала будут приходить сюда.') if name == 'owner' and BOT and CHAT else False
            return self.reply(200, {'ok': bool(n) or tg, 'push': n})
        if path == '/api/push/subscribe':
            sub = body.get('subscription') or {}
            try:
                ep = str(sub['endpoint'])
                clean = {'endpoint': ep, 'keys': {'p256dh': str(sub['keys']['p256dh']), 'auth': str(sub['keys']['auth'])}}
                if not ep.startswith('https://') or len(ep) > 1000:
                    raise ValueError
                webpush.b64d(clean['keys']['p256dh'])
            except Exception:  # noqa: BLE001
                return self.reply(400, {'error': 'bad subscription'})
            with lock:
                u = user(name)
                if len(u['subs']) >= MAX_SUBS and ep not in u['subs']:
                    return self.reply(400, {'error': 'too many devices'})
                u['subs'][ep] = clean
                save()
                n = len(u['subs'])
            return self.reply(200, {'ok': True, 'devices': n})
        if path == '/api/push/unsubscribe':
            with lock:
                user(name)['subs'].pop(str(body.get('endpoint', '')), None)
                save()
            return self.reply(200, {'ok': True})
        if path == '/api/alerts/sync':
            incoming = {}
            for a in body.get('alerts', [])[:MAX_ALERTS]:
                c = clean_alert(a)
                if c:
                    incoming[c[0]] = c[1]
            with lock:
                u = user(name)
                device = str(body.get('device') or 'x')[:40]
                # у каждого устройства свой список: телефон и компьютер не затирают друг друга
                kept = {i: a for i, a in u['alerts'].items() if a.get('dev') not in (None, device)}
                # уже сработавшие не возвращаем, даже если терминал ещё считает их активными
                old = u['alerts']
                mine = {}
                for i, a in incoming.items():
                    # оповещение, которое запустили заново (↻) после срабатывания: снова следим за ним
                    if i in u['fired'] and a.get('armed', 0) > u['fired'][i]['at']:
                        del u['fired'][i]
                    if i in u['fired']:
                        continue
                    mine[i] = {**a, 'dev': device}
                    if a['dir'] == 'cross' and i in old and old[i].get('prev') is not None:
                        mine[i]['prev'] = old[i]['prev']  # линия могла чуть сдвинуться — прежнюю цену помним
                u['alerts'] = {**kept, **mine}
                fired = [{'id': i, **f} for i, f in u['fired'].items()]
                active = len(mine)
                save()
                subs = len(u['subs'])
            return self.reply(200, {'ok': True, 'active': active, 'fired': fired, 'telegram': name == 'owner' and bool(BOT and CHAT), 'push': subs})
        self.reply(404, {'error': 'not found'})

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/alerts/ping':
            return self.reply(200, {'ok': True})
        if path == '/api/push/key':  # открытый ключ не секрет
            return self.reply(200, {'key': vapid['pub']})
        self.reply(404, {'error': 'not found'})


def find_chat():
    """Помощник установки: находит номер чата по первому сообщению боту."""
    d = http_json(f'https://api.telegram.org/bot{BOT}/getUpdates')
    for u in reversed(d.get('result', [])):
        m = u.get('message') or u.get('edited_message')
        if m:
            print(m['chat']['id'])
            return 0
    return 1


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--find-chat':
        sys.exit(find_chat())
    if len(sys.argv) > 1 and sys.argv[1] == 'user':
        sys.exit(cli_users(sys.argv[2:]))
    if not KEY or len(KEY) < 16:
        sys.exit('ALERTD_KEY не задан или слишком короткий (нужно хотя бы 16 символов)')
    vapid['priv'], vapid['pub'] = webpush.load_or_create_vapid(os.path.join(DATA, 'vapid.json'))
    load()
    threading.Thread(target=loop, daemon=True).start()
    log(f'запущен на 127.0.0.1:{PORT}; пользователей: {len(state["users"])}; Телеграм: {"да" if BOT and CHAT else "нет"}')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
