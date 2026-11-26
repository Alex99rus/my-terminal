#!/usr/bin/env python3
"""Сервер оповещений: следит за ценами и присылает уведомление на телефон, когда цена дошла до уровня.

Терминал присылает сюда список ваших оповещений о цене (POST /api/alerts/sync) и «подписку» телефона
(как у сайтов с push-уведомлениями). Сервер проверяет цены каждые несколько секунд и, когда уровень
достигнут, отправляет push (и, если настроено, сообщение в Телеграм). Работает, даже если терминал закрыт.
Нужен только пакет python3-cryptography (ставит install.sh).

Настройки берутся из переменных окружения (файл /etc/alertd.env):
  ALERTD_SUBJECT     адрес вашего сайта, например https://alex-terminal.duckdns.org (нужен push-службам)
  ALERTD_BOT_TOKEN   (необязательно) токен Telegram-бота
  ALERTD_CHAT_ID     (необязательно) номер чата в Телеграме
  ALERTD_KEY         секретный ключ, который терминал присылает вместе с запросами
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
POLL_SEC = 3
KEEP_FIRED_SEC = 30 * 86400
MAX_ALERTS = 500
MAX_BODY = 200_000

# где брать цены: рынок терминала → (адрес, как разобрать ответ)
PRICE_URLS = {
    'futures': 'https://fapi.binance.com/fapi/v1/ticker/price',
    'spot': 'https://api.binance.com/api/v3/ticker/price',
    'bybit-futures': 'https://api.bybit.com/v5/market/tickers?category=linear',
    'bybit-spot': 'https://api.bybit.com/v5/market/tickers?category=spot',
}
MARKET_NAMES = {'futures': 'Binance фьюч', 'spot': 'Binance спот', 'bybit-futures': 'Bybit фьюч', 'bybit-spot': 'Bybit спот'}

lock = threading.Lock()
state = {'alerts': {}, 'fired': {}, 'subs': {}}  # alerts: id → {...}; fired: id → {at, price}; subs: адрес → подписка телефона
vapid = {'priv': None, 'pub': ''}


def log(*a):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), *a, flush=True)


def load():
    try:
        with open(os.path.join(DATA, 'alerts.json'), encoding='utf-8') as f:
            s = json.load(f)
        state['alerts'] = s.get('alerts', {})
        state['fired'] = s.get('fired', {})
        state['subs'] = s.get('subs', {})
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


def send_push(text):
    """Отправляет уведомление на все подписанные телефоны. Возвращает, сколько приняли."""
    with lock:
        subs = list(state['subs'].values())
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
                state['subs'].pop(e, None)
            save()
    return ok


def send_all(text):
    """Push + (если настроен) Телеграм. True, если хоть куда-то дошло."""
    a = send_push(text)
    b = send_telegram(text) if BOT and CHAT else False
    return bool(a) or b


def check_once(get_prices=fetch_prices, send=send_all):
    """Один проход: сработавшие оповещения отправляются и переходят в «сработавшие»."""
    with lock:
        by_market = {}
        for i, a in state['alerts'].items():
            by_market.setdefault(a['market'], set()).add(a['symbol'])
    hits = []
    for market in by_market:
        try:
            prices = get_prices(market)
        except Exception as e:  # noqa: BLE001
            log('нет цен', market, type(e).__name__)
            continue
        with lock:
            for i, a in list(state['alerts'].items()):
                if a['market'] != market:
                    continue
                p = prices.get(a['symbol'])
                if p is None:
                    continue
                if (a['dir'] == 'up' and p >= a['price']) or (a['dir'] == 'down' and p <= a['price']):
                    hits.append((i, a, p))
    for i, a, p in hits:
        arrow = 'вырос до' if a['dir'] == 'up' else 'упал до'
        text = f"🔔 {a['symbol']} ({MARKET_NAMES.get(a['market'], a['market'])}) {arrow} {fmt(a['price'])}\nСейчас: {fmt(p)}"
        ok = send(text)
        with lock:
            if i in state['alerts']:
                del state['alerts'][i]
            state['fired'][i] = {'at': int(time.time() * 1000), 'price': p, 'sent': ok}
        log('сработало', a['symbol'], a['price'], 'отправлено' if ok else 'НЕ отправлено')
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
                for i in [i for i, f in state['fired'].items() if f['at'] < cutoff]:
                    del state['fired'][i]
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
        if market not in PRICE_URLS or d not in ('up', 'down') or not (price > 0) or not symbol.isalnum() or len(symbol) > 20:
            return None
        return i, {'market': market, 'symbol': symbol, 'price': price, 'dir': d}
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

    def authed(self):
        got = self.headers.get('X-Key', '')
        return bool(KEY) and hmac.compare_digest(hashlib.sha256(got.encode()).digest(), hashlib.sha256(KEY.encode()).digest())

    def do_POST(self):
        path = self.path.split('?')[0]
        if not self.authed():
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
            n = send_push('✅ Проверка\nОповещения с терминала будут приходить сюда.')
            tg = send_telegram('✅ Проверка: оповещения с терминала будут приходить сюда.') if BOT and CHAT else False
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
                if len(state['subs']) >= 20 and ep not in state['subs']:
                    return self.reply(400, {'error': 'too many devices'})
                state['subs'][ep] = clean
                save()
            return self.reply(200, {'ok': True, 'devices': len(state['subs'])})
        if path == '/api/push/unsubscribe':
            with lock:
                state['subs'].pop(str(body.get('endpoint', '')), None)
                save()
            return self.reply(200, {'ok': True})
        if path == '/api/alerts/sync':
            incoming = {}
            for a in body.get('alerts', [])[:MAX_ALERTS]:
                c = clean_alert(a)
                if c:
                    incoming[c[0]] = c[1]
            with lock:
                # уже сработавшие не возвращаем, даже если терминал ещё считает их активными
                state['alerts'] = {i: a for i, a in incoming.items() if i not in state['fired']}
                fired = [{'id': i, **f} for i, f in state['fired'].items()]
                active = len(state['alerts'])
                save()
            return self.reply(200, {'ok': True, 'active': active, 'fired': fired, 'telegram': bool(BOT and CHAT), 'push': len(state['subs'])})
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
    if not KEY or len(KEY) < 16:
        sys.exit('ALERTD_KEY не задан или слишком короткий (нужно хотя бы 16 символов)')
    vapid['priv'], vapid['pub'] = webpush.load_or_create_vapid(os.path.join(DATA, 'vapid.json'))
    load()
    threading.Thread(target=loop, daemon=True).start()
    log(f'запущен на 127.0.0.1:{PORT}; оповещений: {len(state["alerts"])}; телефонов: {len(state["subs"])}; Телеграм: {"да" if BOT and CHAT else "нет"}')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
