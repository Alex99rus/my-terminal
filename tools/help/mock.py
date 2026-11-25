"""Подставная «биржа» для записи видеоинструкции.

Терминал открывается без интернета: история свечей, список монет и живые цены
берутся отсюда. Данные случайные, но похожи на настоящие (волатильность, объёмы,
движение за сутки). Для каждой монеты одна минутная история, из неё собираются
свечи любого интервала, поэтому график 1ч и график 1Д согласованы между собой.
"""
import hashlib
import json
import re
import time
from urllib.parse import parse_qs, urlparse

import numpy as np

# монета: (цена сейчас, изменение за сутки %, оборот за сутки в $, суточная волатильность)
COINS = {
    'BTCUSDT': (65354.30, -1.34, 9.8e9, 0.022),
    'ETHUSDT': (1829.92, 3.00, 5.1e9, 0.030),
    'SOLUSDT': (71.8336, -0.73, 1.6e9, 0.040),
    'BNBUSDT': (588.3629, 4.82, 8.2e8, 0.028),
    'XRPUSDT': (0.947456, -1.44, 1.3e9, 0.040),
    'DOGEUSDT': (0.059622, 2.04, 6.4e8, 0.050),
    'ADAUSDT': (0.4120, 1.10, 3.1e8, 0.040),
    'AVAXUSDT': (24.80, -2.30, 2.9e8, 0.045),
    'LINKUSDT': (13.60, 0.60, 2.6e8, 0.042),
    'DOTUSDT': (4.20, -0.90, 1.2e8, 0.042),
    'LTCUSDT': (71.50, 1.90, 2.2e8, 0.034),
    'TRXUSDT': (0.1620, 0.30, 2.0e8, 0.024),
    'TONUSDT': (2.90, -3.10, 1.5e8, 0.045),
    'NEARUSDT': (3.10, 6.40, 2.4e8, 0.050),
    'ATOMUSDT': (4.40, -1.20, 7.0e7, 0.042),
    'UNIUSDT': (6.80, 2.70, 9.0e7, 0.045),
    'APTUSDT': (6.20, -4.20, 8.0e7, 0.050),
    'ARBUSDT': (0.5200, 1.50, 1.4e8, 0.050),
    'OPUSDT': (1.10, -0.40, 1.1e8, 0.050),
    'SUIUSDT': (1.90, 8.30, 4.2e8, 0.055),
    'INJUSDT': (14.20, 3.90, 1.3e8, 0.055),
    'PEPEUSDT': (0.0000072, 5.10, 3.5e8, 0.065),
    'SHIBUSDT': (0.0000089, -1.80, 1.0e8, 0.050),
    'WIFUSDT': (1.35, -6.20, 2.1e8, 0.070),
    'FILUSDT': (3.30, 0.80, 6.0e7, 0.045),
    'AAVEUSDT': (98.50, 2.20, 1.5e8, 0.042),
}
MINUTES = 1_500_000  # около 1040 дней истории
INTERVALS = {'1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200,
             '4h': 14400, '6h': 21600, '8h': 28800, '12h': 43200, '1d': 86400, '1w': 604800}


class Market:
    def __init__(self, now=None):
        self.t_end = int((now or time.time()) // 60 * 60)  # конец истории — текущая минута
        self.cache = {}
        self.agg = {}

    # ---------- история одной монеты ----------
    def series(self, sym):
        if sym in self.cache:
            return self.cache[sym]
        last, chg, qv, vday = COINS.get(sym, (10.0, 0.5, 5e7, 0.045))
        rng = np.random.default_rng(int(hashlib.md5(sym.encode()).hexdigest()[:8], 16))
        n = MINUTES
        sig = vday / np.sqrt(1440)
        reg = np.repeat(np.exp(rng.normal(0, 0.35, n // 240 + 1)), 240)[:n]  # то спокойно, то бурно
        r = rng.standard_normal(n) * sig * reg
        drift = np.convolve(rng.normal(0, 0.8 * vday, n // 1440 + 1), np.ones(5) / 5, 'same')  # недельные тренды
        r += np.repeat(drift, 1440)[:n] / 1440
        # последние сутки двигаем так, чтобы изменение за сутки совпало с заданным
        want = np.log1p(chg / 100)
        r[-1440:] += (want - r[-1440:].sum()) / 1440
        logp = np.cumsum(r)
        close = last * np.exp(logp - logp[-1])
        opn = np.concatenate(([close[0]], close[:-1]))
        hi = np.maximum(opn, close) * (1 + np.abs(rng.standard_normal(n)) * sig * 0.5)
        lo = np.minimum(opn, close) * (1 - np.abs(rng.standard_normal(n)) * sig * 0.5)
        minute = (np.arange(n) % 1440) / 1440
        season = 1 + 0.6 * np.sin(2 * np.pi * (minute - 0.3))
        vol = (qv / 1440 / last) * season * np.exp(rng.normal(0, 0.45, n)) * (1 + 2.5 * np.abs(r) / sig / 3)
        t = (self.t_end - (n - 1) * 60) + 60 * np.arange(n, dtype=np.int64)
        s = dict(t=t, o=opn, h=hi, l=lo, c=close, v=vol, last=last, chg=chg, qv=qv)
        self.cache[sym] = s
        return s

    # ---------- свечи нужного интервала ----------
    def candles(self, sym, interval, limit=1000, end_ms=None):
        sec = INTERVALS.get(interval, 3600)
        key = (sym, interval)
        if key not in self.agg:
            s = self.series(sym)
            t = s['t']
            off = 345600 if interval == '1w' else 0  # неделя биржи начинается в понедельник
            starts = np.flatnonzero((t - off) % sec == 0)
            ends = np.append(starts[1:] - 1, len(t) - 1)
            o = s['o'][starts]
            c = s['c'][ends]
            h = np.maximum.reduceat(s['h'], starts)
            l = np.minimum.reduceat(s['l'], starts)
            v = np.add.reduceat(s['v'], starts)
            self.agg[key] = (t[starts], o, h, l, c, v)
        opens, o, h, l, c, v = self.agg[key]
        hi_i = len(opens) if end_ms is None else int(np.searchsorted(opens * 1000, end_ms, side='right'))
        lo_i = max(0, hi_i - limit)
        fmt = lambda x: f'{x:.10g}'
        rows = []
        for i in range(lo_i, hi_i):
            rows.append([int(opens[i]) * 1000, fmt(o[i]), fmt(h[i]), fmt(l[i]), fmt(c[i]), fmt(v[i]),
                         int(opens[i] + sec) * 1000 - 1, fmt(v[i] * c[i]), 100, '0', '0', '0'])
        return rows

    def tickers(self):
        out = []
        for sym, (last, chg, qv, _) in COINS.items():
            op = last / (1 + chg / 100)
            out.append(dict(symbol=sym, lastPrice=f'{last:.10g}', openPrice=f'{op:.10g}',
                            highPrice=f'{max(last, op) * 1.012:.10g}', lowPrice=f'{min(last, op) * 0.985:.10g}',
                            priceChangePercent=f'{chg:.3f}', quoteVolume=f'{qv:.1f}', volume=f'{qv / last:.2f}', count=250000))
        return out

    # ---------- ответы на запросы терминала ----------
    def handle(self, url):
        u = urlparse(url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path.endswith('/klines'):
            end = int(q['endTime']) if 'endTime' in q else None
            return self.candles(q['symbol'], q.get('interval', '1h'), int(q.get('limit', 1000)), end)
        if u.path.endswith('/ticker/24hr'):
            lst = self.tickers()
            if 'symbol' in q:
                return next((t for t in lst if t['symbol'] == q['symbol']), lst[0])
            return lst
        return {}


def install(context, market):
    """Перехватывает запросы терминала к бирже и отвечает подставными данными."""
    def handler(route):
        try:
            body = json.dumps(market.handle(route.request.url))
            route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'}, body=body)
        except Exception as e:  # noqa: BLE001
            print('mock error', route.request.url, e)
            route.abort()
    context.route(re.compile(r'https://(fapi\.binance\.com|data-api\.binance\.vision|api\.binance\.com)/.*'), handler)
    # остальные внешние запросы (Bybit, Мосбиржа, обновления) не нужны — тихо отклоняем
    context.route(re.compile(r'https://(api\.bybit\.com|iss\.moex\.com)/.*'), lambda r: r.fulfill(status=200, content_type='application/json', body='{}'))
