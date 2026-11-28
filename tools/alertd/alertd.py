#!/usr/bin/env python3
"""Сервер оповещений: следит за ценами и присылает уведомление на телефон, когда цена дошла до уровня.

Терминал присылает сюда список ваших оповещений о цене (POST /api/alerts/sync) и «подписку» телефона
(как у сайтов с push-уведомлениями). Сервер проверяет цены каждые несколько секунд и, когда уровень
достигнут, отправляет push (и, если настроено, сообщение в Телеграм). Работает, даже если терминал закрыт.
Нужен только пакет python3-cryptography (ставит install.sh).

Пользователей может быть несколько (вы и друзья): у каждого свой ключ, свои оповещения и свои телефоны.
Управление — командой на сервере:  alertd-user add Имя | list | del Имя
Сообщения всем:  alertd-user say "текст" (и пуш, и плашка в терминале) | push "текст" | news "текст" | news-off

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

import trading
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
state = {'users': {}, 'news': None}  # news: последнее объявление для плашки в терминале {id, text, at}
vapid = {'priv': None, 'pub': ''}


def log(*a):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), *a, flush=True)


def load():
    try:
        with open(os.path.join(DATA, 'alerts.json'), encoding='utf-8') as f:
            s = json.load(f)
        state['news'] = s.get('news')
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


def cli_trade(args):
    """alertd-user keys set|list|test|remove <рынок> [--testnet] / trade on|off|limits|status"""
    import getpass

    cmd, sub = args[0], (args[1] if len(args) > 1 else '')
    c = trading.load_cfg()
    if cmd == 'trade':
        if sub in ('on', 'off'):
            c['limits']['enabled'] = sub == 'on'
            trading.save_cfg(c)
            print('Торговля с терминала ВКЛЮЧЕНА' if sub == 'on' else 'Торговля с терминала выключена (просмотр счёта остаётся)')
            return 0
        if sub == 'limits':
            try:
                if len(args) > 2:
                    c['limits']['max_order_usd'] = float(args[2])
                if len(args) > 3:
                    c['limits']['max_leverage'] = int(args[3])
            except ValueError:
                print('Формат: trade limits МАКС_СУММА_ДОЛЛАРОВ (0 = без ограничения) [МАКС_ПЛЕЧО]')
                return 1
            trading.save_cfg(c)
        mo = c['limits']['max_order_usd']
        print(f"Торговля: {'включена' if c['limits']['enabled'] else 'выключена'}; макс. сумма ордера {'без ограничения' if mo <= 0 else f'{mo:.0f} $'}; макс. плечо {c['limits']['max_leverage']}")
        return 0
    markets = ' | '.join(trading.MARKETS)
    if sub == 'list' or not sub:
        for m in trading.MARKETS:
            a = c['accounts'].get(m)
            print(f"{m:14} {'ключ добавлен' + (' (тестовая сеть)' if a.get('testnet') else '') if a else '—'}")
        return 0
    m = args[2] if len(args) > 2 else ''
    if m not in trading.MARKETS:
        print(f'Формат: keys {sub} <рынок>   где рынок: {markets}')
        return 1
    if sub == 'remove':
        c['accounts'].pop(m, None)
        trading.save_cfg(c)
        print('Ключ удалён')
        return 0
    if sub == 'set':
        print('Ключи вводятся скрыто (на экране не видны). Права на вывод средств у ключа должны быть ВЫКЛЮЧЕНЫ.')
        k = getpass.getpass('API Key: ').strip()
        sec = getpass.getpass('API Secret: ').strip()
        if len(k) < 8 or len(sec) < 8:
            print('Пустой или слишком короткий ключ — отмена')
            return 1
        c['accounts'][m] = {'key': k, 'secret': sec, 'testnet': '--testnet' in args}
        trading.save_cfg(c)
        print('Ключ сохранён на сервере. Проверка: alertd-user keys test ' + m)
        return 0
    if sub == 'test':
        try:
            ex = trading.get_exchange(m)
            p = trading.permissions(ex, m)
            a = trading.account(m)
        except Exception as e:  # noqa: BLE001
            print('Ошибка:', trading.err_text(e))
            return 1
        print(f"Связь с биржей есть. Баланс USDT: всего {a['usdt']['total']}, свободно {a['usdt']['free']}; позиций: {len(a['positions'])}")
        if p['withdraw']:
            print('⚠️  У КЛЮЧА ВКЛЮЧЁН ВЫВОД СРЕДСТВ. Отключите это право на бирже и создайте ключ заново!')
            return 2
        print('Вывод средств у ключа: ' + ('выключен ✅' if p['withdraw'] is False else 'не удалось проверить'))
        print('Привязка к IP: ' + ('есть ✅' if p['ip_restricted'] else 'нет (лучше добавить IP сервера 82.25.60.228)' if p['ip_restricted'] is False else 'не удалось проверить'))
        return 0
    print('Команды: keys list | keys set <рынок> [--testnet] | keys test <рынок> | keys remove <рынок> | trade on|off | trade limits СУММА $ [ПЛЕЧО]')
    return 1


def cli_users(args):
    import re
    import secrets

    if args and args[0] in ('keys', 'trade'):
        return cli_trade(args)
    if args and args[0] == 'newkey':  # заменить ключ владельца (старая ссылка перестаёт работать)
        import re as _re
        import secrets as _sec
        import subprocess

        envf = '/etc/alertd.env'
        new = _sec.token_hex(16)
        txt = open(envf, encoding='utf-8').read()
        txt = _re.sub(r'(?m)^ALERTD_KEY=.*$', 'ALERTD_KEY=' + new, txt)
        with open(envf, 'w', encoding='utf-8') as f:
            f.write(txt)
        us0 = read_users()
        if us0.pop('owner', None) is not None:
            write_users(us0)
        subprocess.run(['systemctl', 'restart', 'alertd'], check=False)
        print('Новый ключ владельца создан, старая ссылка больше не работает.')
        print(f'Откройте на КАЖДОМ устройстве:  {SUBJECT}/#alertkey={new}')
        return 0

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
    if cmd in ('say', 'push', 'news', 'news-off'):
        text = ' '.join(args[1:]).strip()
        if cmd != 'news-off' and not text:
            print(f'Напишите текст в кавычках: alertd-user {cmd} "текст"')
            return 1
        payload = {'text': text, 'push': cmd in ('say', 'push'), 'news': cmd in ('say', 'news'), 'clear': cmd == 'news-off'}
        try:
            req = urllib.request.Request(
                f'http://127.0.0.1:{PORT}/api/admin/broadcast', data=json.dumps(payload).encode(), headers={'X-Key': KEY}
            )
            r = json.loads(urllib.request.urlopen(req, timeout=60).read())
        except Exception as e:  # noqa: BLE001
            print('Служба alertd не отвечает:', e)
            return 1
        if cmd == 'news-off':
            print('Плашка убрана.')
        else:
            if payload['push']:
                print(f"Пуш отправлен на устройств: {r.get('push', 0)}")
            if payload['news']:
                print('Плашка появится в терминале у всех в течение 10 минут (или при следующем открытии).')
        return 0
    print('Команды: add Имя | list | del Имя | say "текст" | push "текст" | news "текст" | news-off')
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


def send_push(name, text, skip=''):
    """Отправляет уведомление на телефоны пользователя (кроме адреса skip). Возвращает, сколько приняли."""
    with lock:
        subs = [s for s in user(name)['subs'].values() if s['endpoint'] != skip]
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

    def trade_api(self, path, body):
        try:
            if path == '/api/trade/status':
                return self.reply(200, trading.public_status())
            if path == '/api/trade/account':
                return self.reply(200, trading.account(body.get('market')))
            if path == '/api/trade/order':
                return self.reply(200, trading.place_order(body))
            if path == '/api/trade/cancel':
                return self.reply(200, trading.cancel(body))
            if path == '/api/trade/close':
                return self.reply(200, trading.close_position(body))
        except trading.TradeError as e:
            return self.reply(400, {'error': str(e)})
        except Exception as e:  # noqa: BLE001
            log('trade error', path, type(e).__name__)
            return self.reply(500, {'error': 'Ошибка: ' + trading.err_text(e)})
        self.reply(404, {'error': 'not found'})

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
        if path.startswith('/api/trade/'):
            if name != 'owner':
                return self.reply(403, {'error': 'Торговля доступна только владельцу'})
            return self.trade_api(path, body)
        if path == '/api/admin/broadcast':
            if name != 'owner':
                return self.reply(403, {'error': 'owner only'})
            text = str(body.get('text') or '').strip()[:500]
            sent = 0
            if body.get('clear'):
                with lock:
                    state['news'] = None
                    save()
            if body.get('news') and text:
                with lock:
                    state['news'] = {'id': str(int(time.time() * 1000)), 'text': text, 'at': int(time.time() * 1000)}
                    save()
            if body.get('push') and text:
                with lock:
                    names = list(state['users'])
                for n in names:
                    sent += send_push(n, '📢 Сообщение\n' + text[:200])
            return self.reply(200, {'ok': True, 'push': sent})
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
        if path == '/api/alerts/fired':
            # терминал сам поймал сигнал (он открыт на каком-то устройстве) — разослать остальным устройствам
            text = str(body.get('text') or '')[:200].strip()
            if not text:
                return self.reply(400, {'error': 'no text'})
            aid = str(body.get('id') or '')[:40]
            with lock:
                u = user(name)
                if aid and aid in u['fired'] and body.get('armed', 0) <= u['fired'][aid]['at']:
                    return self.reply(200, {'ok': True, 'dup': True})  # сервер уже сам отправил
                if aid:
                    u['alerts'].pop(aid, None)
                    u['fired'][aid] = {'at': int(time.time() * 1000), 'price': body.get('price') or 0, 'sent': True}
                    save()
            n = send_push(name, '🔔 Оповещение\n' + text, skip=str(body.get('endpoint') or ''))
            return self.reply(200, {'ok': True, 'push': n})
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
        if path == '/api/news':  # объявление для плашки в терминале: видят все, кто открыл сайт
            with lock:
                n = state.get('news') or {}
            return self.reply(200, n)
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
