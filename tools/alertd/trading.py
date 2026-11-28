"""Торговля с терминала через API бирж (Binance и Bybit, фьючерсы и спот). Работает на базе библиотеки ccxt.

Ключи лежат только на сервере: /var/lib/alertd/exchanges.json (права 600). Вводятся командой на сервере
(`alertd-user keys set <рынок>`), в браузер и на телефон не попадают. Торговля по умолчанию ВЫКЛЮЧЕНА
(`alertd-user trade on`), есть лимиты на размер ордера и плечо, режим «только просмотр».

Рынки (как в терминале): futures (Binance USDT-M), spot (Binance), bybit-futures (Bybit linear), bybit-spot.
"""
import json
import os
import threading
import time

DATA = os.environ.get('ALERTD_DATA', '/var/lib/alertd')
MARKETS = {
    'futures': ('binanceusdm', {}),
    'spot': ('binance', {'defaultType': 'spot'}),
    'bybit-futures': ('bybit', {'defaultType': 'swap'}),
    'bybit-spot': ('bybit', {'defaultType': 'spot'}),
}
DEFAULT_LIMITS = {'max_order_usd': 100.0, 'max_leverage': 5, 'enabled': False}

_cache = {}  # рынок → (ccxt-биржа, время загрузки)
_locks = {m: threading.Lock() for m in MARKETS}
_factory = None  # для тестов: подменяет создание биржи


class TradeError(Exception):
    """Понятная пользователю ошибка (текст можно показывать в терминале)."""


def log(*a):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), 'trade:', *a, flush=True)


# ---------- Настройки и ключи ----------
def cfg_path():
    return os.path.join(DATA, 'exchanges.json')


def load_cfg():
    try:
        with open(cfg_path(), encoding='utf-8') as f:
            c = json.load(f)
    except FileNotFoundError:
        c = {}
    c.setdefault('accounts', {})
    c['limits'] = {**DEFAULT_LIMITS, **c.get('limits', {})}
    return c


def save_cfg(c):
    os.makedirs(DATA, exist_ok=True)
    tmp = cfg_path() + '.tmp'
    old = os.umask(0o077)
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(c, f)
    finally:
        os.umask(old)
    os.chmod(tmp, 0o640)  # читает служба (группа alertd), больше никто
    os.replace(tmp, cfg_path())
    try:
        import shutil

        shutil.chown(cfg_path(), group='alertd')
    except Exception:  # noqa: BLE001
        pass
    _cache.clear()


def public_status():
    """Что можно показать терминалу: без ключей."""
    c = load_cfg()
    return {
        'enabled': bool(c['limits']['enabled']),
        'limits': {k: c['limits'][k] for k in ('max_order_usd', 'max_leverage')},
        'accounts': {m: {'configured': m in c['accounts'], 'testnet': bool(c['accounts'].get(m, {}).get('testnet'))} for m in MARKETS},
    }


# ---------- Подключение к бирже ----------
def get_exchange(market):
    if market not in MARKETS:
        raise TradeError('Неизвестный рынок')
    if _factory:
        return _factory(market)
    c = load_cfg()
    acc = c['accounts'].get(market)
    if not acc:
        raise TradeError('Для этого рынка не добавлен API-ключ (команда alertd-user keys set на сервере)')
    cached = _cache.get(market)
    if cached and time.time() - cached[1] < 3600:
        return cached[0]
    import ccxt

    ex_id, opts = MARKETS[market]
    ex = getattr(ccxt, ex_id)({
        'apiKey': acc['key'],
        'secret': acc['secret'],
        'enableRateLimit': True,
        'timeout': 15000,
        'options': {**opts, 'adjustForTimeDifference': True, 'warnOnFetchOpenOrdersWithoutSymbol': False},
    })
    if acc.get('testnet'):
        ex.set_sandbox_mode(True)
    ex.load_markets()
    _cache[market] = (ex, time.time())
    return ex


def resolve(ex, market, symbol):
    """Символ терминала (BTCUSDT) → символ ccxt (BTC/USDT:USDT или BTC/USDT)."""
    futures = market in ('futures', 'bybit-futures')
    for m in ex.markets_by_id.get(symbol, []):
        if m.get('active') is False:
            continue
        if futures and m.get('swap') and m.get('linear'):
            return m['symbol']
        if not futures and m.get('spot'):
            return m['symbol']
    raise TradeError(f'Монета {symbol} не найдена на этом рынке')


def err_text(e):
    """Короткий текст ошибки биржи без лишнего (и без возможных секретов)."""
    s = str(e)
    for pre in ('binanceusdm ', 'binance ', 'bybit '):
        if s.startswith(pre):
            s = s[len(pre):]
    return s[:300]


# ---------- Права ключа ----------
def permissions(ex, market):
    """Проверка опасных прав ключа: {'withdraw': True/False/None, 'ip_restricted': True/False/None}."""
    out = {'withdraw': None, 'ip_restricted': None}
    try:
        if market in ('futures', 'spot'):
            r = ex.sapiGetAccountApiRestrictions()
            out['withdraw'] = str(r.get('enableWithdrawals')).lower() == 'true'
            out['ip_restricted'] = str(r.get('ipRestrict')).lower() == 'true'
        else:
            r = ex.privateGetV5UserQueryApi()
            res = r.get('result', {})
            out['withdraw'] = 'withdraw' in json.dumps(res.get('permissions', {})).lower()
            out['ip_restricted'] = bool(res.get('ips')) and res.get('ips') != ['*']
    except Exception as e:  # noqa: BLE001
        log('не удалось проверить права ключа', market, type(e).__name__)
    return out


# ---------- Чтение ----------
def account(market):
    """Баланс, открытые позиции и ордера (только чтение)."""
    with _locks[market]:
        ex = get_exchange(market)
        futures = market in ('futures', 'bybit-futures')
        bal = ex.fetch_balance()
        usdt = bal.get('USDT', {}) or {}
        out = {'market': market, 'usdt': {'total': usdt.get('total'), 'free': usdt.get('free')}, 'positions': [], 'orders': []}
        if futures:
            for p in ex.fetch_positions():
                size = abs(float(p.get('contracts') or 0))
                if size <= 0:
                    continue
                out['positions'].append({
                    'symbol': p['info'].get('symbol') or p['symbol'],
                    'side': p.get('side'),
                    'size': size,
                    'entry': p.get('entryPrice'),
                    'mark': p.get('markPrice'),
                    'pnl': p.get('unrealizedPnl'),
                    'leverage': p.get('leverage'),
                    'liq': p.get('liquidationPrice'),
                })
        else:
            out['assets'] = {k: v for k, v in (bal.get('total') or {}).items() if v}
        for trig in (False, True) if market == 'futures' else (False,):
            try:
                for o in ex.fetch_open_orders(None, None, None, {'trigger': True} if trig else {}):
                    out['orders'].append(_order(o, algo=trig))
            except Exception as e:  # noqa: BLE001
                log('не удалось получить ордера', market, type(e).__name__, err_text(e)[:150])
        if market == 'bybit-futures':
            pass  # условные ордера Bybit возвращаются в общем списке
        return out


def _order(o, algo=False):
    return {
        'id': o.get('id'),
        'symbol': (o.get('info') or {}).get('symbol') or o.get('symbol'),
        'side': o.get('side'),
        'type': o.get('type'),
        'price': o.get('price'),
        'trigger': o.get('triggerPrice') or o.get('stopPrice'),
        'qty': o.get('amount'),
        'reduce': bool(o.get('reduceOnly')),
        'status': o.get('status'),
        'algo': algo,
    }


# ---------- Ордера ----------
def _check_enabled(market):
    c = load_cfg()
    if not c['limits']['enabled']:
        raise TradeError('Торговля выключена на сервере (включается командой alertd-user trade on)')
    if market not in c['accounts'] and not _factory:
        raise TradeError('Для этого рынка не добавлен API-ключ')
    return c['limits']


def place_order(p):
    """p: market, symbol, side (buy/sell), type (market/limit), qty, price, sl, tp, leverage, reduce, confirm."""
    market = p.get('market')
    if market not in MARKETS:
        raise TradeError('Неизвестный рынок')
    if p.get('confirm') is not True:
        raise TradeError('Нужно подтверждение')
    lim = _check_enabled(market)
    side = p.get('side')
    typ = p.get('type', 'market')
    if side not in ('buy', 'sell') or typ not in ('market', 'limit'):
        raise TradeError('Неверные параметры ордера')
    try:
        qty = float(p.get('qty'))
        price = float(p['price']) if p.get('price') not in (None, '') else None
        sl = float(p['sl']) if p.get('sl') not in (None, '', 0) else None
        tp = float(p['tp']) if p.get('tp') not in (None, '', 0) else None
        lev = int(p['leverage']) if p.get('leverage') not in (None, '') else None
    except (TypeError, ValueError):
        raise TradeError('Неверные числа в ордере') from None
    reduce = bool(p.get('reduce'))
    futures = market in ('futures', 'bybit-futures')
    if qty <= 0:
        raise TradeError('Количество должно быть больше нуля')
    if typ == 'limit' and not price:
        raise TradeError('Для лимитного ордера нужна цена')
    if (sl or tp) and not futures:
        raise TradeError('Стоп и тейк для спота пока не поддерживаются')
    if (sl or tp) and typ == 'limit' and market != 'bybit-futures':
        raise TradeError('Стоп и тейк можно прикрепить только к рыночному ордеру (на Binance)')
    if reduce and (sl or tp):
        raise TradeError('Стоп и тейк нельзя ставить вместе с «только закрытие»')
    if lev is not None and (not futures or lev < 1 or lev > lim['max_leverage']):
        raise TradeError(f"Плечо должно быть от 1 до {lim['max_leverage']} (лимит на сервере)")
    with _locks[market]:
        ex = get_exchange(market)
        sym = resolve(ex, market, p.get('symbol'))
        ref = price or float(ex.fetch_ticker(sym)['last'])
        qty = float(ex.amount_to_precision(sym, qty))
        mk = ex.market(sym)
        lo = ((mk.get('limits') or {}).get('amount') or {}).get('min')
        if qty <= 0 or (lo and qty < lo):
            raise TradeError(f'Слишком маленький объём (минимум {lo})')
        notional = qty * ref * (mk.get('contractSize') or 1)
        cost_min = ((mk.get('limits') or {}).get('cost') or {}).get('min')
        if cost_min and notional < cost_min:
            raise TradeError(f'Сумма ордера {notional:.2f} меньше минимальной {cost_min}')
        if not reduce and notional > lim['max_order_usd'] * 1.001:
            raise TradeError(f"Сумма ордера {notional:.2f} $ больше лимита {lim['max_order_usd']:.0f} $ (alertd-user trade limits)")
        # стоп и тейк должны стоять с правильной стороны от цены
        if sl and ((side == 'buy' and sl >= ref) or (side == 'sell' and sl <= ref)):
            raise TradeError('Стоп стоит не с той стороны от цены')
        if tp and ((side == 'buy' and tp <= ref) or (side == 'sell' and tp >= ref)):
            raise TradeError('Тейк стоит не с той стороны от цены')
        res = {'ok': True, 'warnings': []}
        try:
            if futures and p.get('symbol') and lev:
                try:
                    ex.set_leverage(lev, sym)
                except Exception as e:  # noqa: BLE001
                    if 'not modified' not in str(e).lower() and 'no need' not in str(e).lower():
                        raise TradeError('Не удалось поставить плечо: ' + err_text(e)) from None
            params = {}
            if reduce:
                params['reduceOnly'] = True
            if market == 'bybit-futures':
                if sl:
                    params['stopLoss'] = {'triggerPrice': float(ex.price_to_precision(sym, sl))}
                if tp:
                    params['takeProfit'] = {'triggerPrice': float(ex.price_to_precision(sym, tp))}
            order = ex.create_order(sym, typ, side, qty, float(ex.price_to_precision(sym, price)) if price else None, params)
        except TradeError:
            raise
        except Exception as e:  # noqa: BLE001
            log('ордер отклонён', market, p.get('symbol'), side, type(e).__name__)
            raise TradeError('Биржа отклонила ордер: ' + err_text(e)) from None
        log('ордер', market, p.get('symbol'), side, typ, qty, 'id', order.get('id'))
        res['order'] = _order(order)
        res['order']['avg'] = order.get('average')
        res['order']['filled'] = order.get('filled')
        # на Binance стоп и тейк — отдельные условные ордера «только закрытие»
        if market == 'futures' and (sl or tp):
            opp = 'sell' if side == 'buy' else 'buy'
            for name, trig, key in (('stop', sl, 'stopLossPrice'), ('take', tp, 'takeProfitPrice')):
                if not trig:
                    continue
                try:
                    o = ex.create_order(sym, 'market', opp, qty, None, {key: float(ex.price_to_precision(sym, trig)), 'reduceOnly': True})
                    res[name] = _order(o, algo=True)
                    log('условный ордер', name, p.get('symbol'), trig)
                except Exception as e:  # noqa: BLE001
                    res['warnings'].append(f"{'Стоп' if name == 'stop' else 'Тейк'} не поставился: {err_text(e)}")
                    log('условный ордер не поставился', name, type(e).__name__)
                    if name == 'stop':  # позиция без защиты — закрываем сразу
                        try:
                            ex.create_order(sym, 'market', opp, qty, None, {'reduceOnly': True})
                            res['warnings'].append('Позиция закрыта, потому что стоп поставить не удалось')
                            res['ok'] = False
                        except Exception as e2:  # noqa: BLE001
                            res['warnings'].append('СТОП НЕ ПОСТАВЛЕН И ПОЗИЦИЮ ЗАКРЫТЬ НЕ УДАЛОСЬ — закройте вручную: ' + err_text(e2))
                            res['ok'] = False
                        break
        return res


def cancel(p):
    market = p.get('market')
    lim = _check_enabled(market)  # noqa: F841
    with _locks[market]:
        ex = get_exchange(market)
        sym = resolve(ex, market, p.get('symbol'))
        try:
            if p.get('all'):
                ex.cancel_all_orders(sym)
                if market == 'futures':
                    try:
                        ex.cancel_all_orders(sym, {'trigger': True})
                    except Exception:  # noqa: BLE001
                        pass
            else:
                ex.cancel_order(str(p.get('id')), sym, {'trigger': True} if p.get('algo') else {})
        except Exception as e:  # noqa: BLE001
            raise TradeError('Не удалось отменить: ' + err_text(e)) from None
        log('отмена', market, p.get('symbol'), 'все' if p.get('all') else p.get('id'))
        return {'ok': True}


def close_position(p):
    """Закрыть позицию по рынку (только уменьшение) и снять оставшиеся ордера по монете."""
    market = p.get('market')
    if market not in ('futures', 'bybit-futures'):
        raise TradeError('Закрытие позиции — только для фьючерсов')
    if p.get('confirm') is not True:
        raise TradeError('Нужно подтверждение')
    _check_enabled(market)
    with _locks[market]:
        ex = get_exchange(market)
        sym = resolve(ex, market, p.get('symbol'))
        pos = [x for x in ex.fetch_positions([sym]) if abs(float(x.get('contracts') or 0)) > 0]
        if not pos:
            raise TradeError('Открытой позиции по этой монете нет')
        x = pos[0]
        side = 'sell' if x.get('side') == 'long' else 'buy'
        try:
            ex.create_order(sym, 'market', side, abs(float(x['contracts'])), None, {'reduceOnly': True})
        except Exception as e:  # noqa: BLE001
            raise TradeError('Биржа отклонила закрытие: ' + err_text(e)) from None
        log('закрыта позиция', market, p.get('symbol'))
    try:
        cancel({'market': market, 'symbol': p.get('symbol'), 'all': True})
    except TradeError:
        pass
    return {'ok': True}
