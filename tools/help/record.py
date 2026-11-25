#!/usr/bin/env python3
"""Запись видеоинструкции: открывает терминал на подставных данных, «проходит» по функциям
по сценарию главы, озвучивает русским голосом и собирает mp4 с субтитрами.

Запуск (из папки проекта, после `npm run build`):
    python3 tools/help/record.py draw            # одна глава
    python3 tools/help/record.py all             # все главы
    python3 tools/help/record.py draw --check    # заодно «прослушать» озвучку распознаванием речи
Нужно: pip install playwright numpy sherpa-onnx==1.12.40, ffmpeg и Chrome. Голос скачивается сам.
Сценарии глав — в chapters.py, подробности — в README.md рядом.
"""
import argparse
import hashlib
import http.server
import json
import math
import os
import subprocess
import sys
import tarfile
import threading
import time
import wave
from functools import partial
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = Path(os.environ.get('HELP_CACHE', Path.home() / '.cache' / 'my-terminal-help'))
W, H = 1280, 720
sys.path.insert(0, str(HERE))
import mock  # noqa: E402


# ======================= Голос =======================
def ensure_download(name, url):
    d = CACHE / name
    if d.exists():
        return d
    CACHE.mkdir(parents=True, exist_ok=True)
    tgz = CACHE / (name + '.tar.bz2')
    print('скачиваю', url)
    subprocess.run(['curl', '-sL', '-o', str(tgz), url], check=True)
    with tarfile.open(tgz) as t:
        t.extractall(CACHE)
    tgz.unlink()
    return d


class Voice:
    def __init__(self, name='irina', speed=0.92):
        import sherpa_onnx
        self.name, self.speed = name, speed
        d = ensure_download(f'vits-piper-ru_RU-{name}-medium',
                            f'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-ru_RU-{name}-medium.tar.bz2')
        cfg = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(model=str(d / f'ru_RU-{name}-medium.onnx'), tokens=str(d / 'tokens.txt'), data_dir=str(d / 'espeak-ng-data')),
            num_threads=4, provider='cpu'))
        self.tts = sherpa_onnx.OfflineTts(cfg)
        (CACHE / 'tts').mkdir(parents=True, exist_ok=True)

    def wav(self, text):
        """Озвучивает text, возвращает (путь к wav, длительность в секундах). Готовое берётся из кэша."""
        key = hashlib.md5(f'{self.name}|{self.speed}|{text}'.encode()).hexdigest()
        path = CACHE / 'tts' / f'{key}.wav'
        if not path.exists():
            a = self.tts.generate(text, sid=0, speed=self.speed)
            s = np.clip(np.array(a.samples, dtype=np.float32), -1, 1)
            with wave.open(str(path), 'wb') as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(a.sample_rate)
                w.writeframes((s * 32767).astype(np.int16).tobytes())
        with wave.open(str(path)) as w:
            return path, w.getnframes() / w.getframerate()


class Checker:
    """Распознаёт озвучку обратно в текст и сравнивает со сказанным: так ловим плохо произнесённые слова."""
    def __init__(self):
        import sherpa_onnx
        d = ensure_download('sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19',
                            'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19.tar.bz2')
        self.rec = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(model=str(d / 'model.int8.onnx'), tokens=str(d / 'tokens.txt'), num_threads=4)

    def score(self, path, text):
        import difflib
        import re
        with wave.open(str(path)) as w:
            sr = w.getframerate()
            x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        s = self.rec.create_stream(); s.accept_waveform(sr, x); self.rec.decode_stream(s)
        hyp = s.result.text
        norm = lambda t: ' '.join(re.sub(r'[^а-яё0-9 ]', '', t.lower().replace('ё', 'е')).split())
        return difflib.SequenceMatcher(None, norm(text), norm(hyp)).ratio(), hyp


# ======================= Сцена =======================
def preset_js(state):
    return ("try{if(!localStorage.getItem('__preset')){localStorage.setItem('__preset','1');"
            "localStorage.setItem('my-terminal-help-seen','1');"
            f"localStorage.setItem('my-terminal-v2',{json.dumps(json.dumps(state))});" "}}catch(e){}")


class Scene:
    def __init__(self, page, voice, checker=None):
        self.page, self.voice, self.checker = page, voice, checker
        self.segs = []          # (начало, путь к wav, длительность)
        self.speech_end = 0.0
        self.pos = (W // 2, H // 2)
        self.t0 = None
        self.poster_at = None
        self.bad = []

    def sleep(self, sec):
        # не time.sleep: пока страница «спит» через Playwright, обрабатываются и запросы к подставной бирже
        self.page.wait_for_timeout(sec * 1000)

    # --- время ---
    def now(self):
        return time.time() - self.t0

    def say(self, cap, tts=None, pad=0.0):
        """Начинает озвучку: голос идёт, пока сценарий выполняет следующие действия."""
        spoken = tts or cap
        path, dur = self.voice.wav(spoken)  # уже озвучено при подготовке — берётся из кэша
        start = max(self.now(), self.speech_end) + pad  # следующая фраза — после конца предыдущей
        while self.now() < start:
            self.sleep(0.02)
        self.segs.append((self.now(), path, dur))
        self.speech_end = self.now() + dur
        self.page.evaluate('t => window.__cap && window.__cap(t)', cap)
        if self.poster_at is None:
            self.poster_at = self.now() + min(dur, 3.0)

    def wait_speech(self, pad=0.5):
        """Ждёт конца озвучки (если действия закончились раньше)."""
        while self.now() < self.speech_end + pad:
            self.sleep(0.02)

    def hold(self, sec):
        self.sleep(sec)

    # --- мышь и клавиатура ---
    def mv(self, x, y, dur=None):
        x0, y0 = self.pos
        dist = math.hypot(x - x0, y - y0)
        dur = dur if dur is not None else min(1.1, 0.25 + dist / 1500)
        n = max(3, int(dur * 28))
        for i in range(1, n + 1):
            k = i / n
            e = k * k * (3 - 2 * k)
            self.page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e)
            self.sleep(dur / n)
        self.pos = (x, y)

    def center(self, sel, nth=0):
        bb = self.page.locator(sel).nth(nth).bounding_box()
        if not bb:
            raise RuntimeError(f'не нашёл на экране: {sel}')
        return bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2

    def to(self, target, dx=0, dy=0, nth=0, dur=None):
        x, y = target if isinstance(target, tuple) else self.center(target, nth)
        self.mv(x + dx, y + dy, dur)

    def click(self, target, dx=0, dy=0, nth=0, dur=None, after=0.25):
        self.to(target, dx, dy, nth, dur)
        self.sleep(0.12)
        self.page.mouse.down(); self.sleep(0.06); self.page.mouse.up()
        self.sleep(after)

    def drag(self, p0, p1, dur=0.9, after=0.3):
        self.mv(*p0); self.sleep(0.1)
        self.page.mouse.down(); self.sleep(0.08)
        self.mv(*p1, dur=dur)
        self.page.mouse.up(); self.sleep(after)

    def drag_el(self, sel, dx=0, dy=0, dur=0.9):
        """Тянет элемент (например, край панели) на dx, dy пикселей."""
        x, y = self.center(sel)
        self.drag((x, y), (x + dx, y + dy), dur=dur)

    def wheel(self, dy, times=1, gap=0.18):
        for _ in range(times):
            self.page.mouse.wheel(0, dy); self.sleep(gap)

    def key(self, k, after=0.3):
        self.page.keyboard.press(k); self.sleep(after)

    def type(self, text, delay=0.09, after=0.3):
        for ch in text:
            self.page.keyboard.type(ch); self.sleep(delay)
        self.sleep(after)

    def eval(self, js, *a):
        return self.page.evaluate(js, *a)


class _Null:
    def __call__(self, *a, **k):
        return None

    def __getattr__(self, name):
        return _Null()


class Dry:
    """«Сухой прогон» сценария: только собирает фразы, чтобы озвучить и проверить их до начала записи."""
    def __init__(self):
        self.lines = []
        self.poster_at = None
        self.page = self  # s.page.… в сухом прогоне ничего не делает

    def say(self, cap, tts=None, pad=0.0):
        self.lines.append(tts or cap)

    def __getattr__(self, name):
        return _Null()


def prepare_speech(chapter, voice, checker):
    dry = Dry()
    chapter['run'](dry)
    bad = []
    for text in dry.lines:
        path, _ = voice.wav(text)
        if checker:
            sc, hyp = checker.score(path, text)
            if sc < 0.9:
                bad.append((round(sc, 2), text, hyp))
    return bad


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        pass


def serve(directory):
    handler = partial(QuietHandler, directory=str(directory))
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def mux(video, scene, trim, out_mp4, out_jpg):
    total = scene.now() + 1.0
    sr = 22050
    audio = np.zeros(int(total * sr) + sr, dtype=np.float32)
    for start, path, dur in scene.segs:
        with wave.open(str(path)) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
            if w.getframerate() != sr:
                x = np.interp(np.linspace(0, len(x), int(len(x) * sr / w.getframerate())), np.arange(len(x)), x)
        i = int(start * sr)
        audio[i:i + len(x)] += x
    wav = Path(str(out_mp4) + '.audio.wav')
    with wave.open(str(wav), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{trim:.3f}', '-i', str(video), '-i', str(wav), '-map', '0:v', '-map', '1:a',
                    '-t', f'{total:.2f}', '-vf', 'fps=25', '-c:v', 'libx264', '-preset', 'medium', '-crf', '27', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-ac', '1', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
                    '-movflags', '+faststart', str(out_mp4)], check=True)
    wav.unlink()
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{scene.poster_at or 3:.2f}', '-i', str(out_mp4), '-frames:v', '1',
                    '-vf', 'scale=320:180', '-q:v', '5', str(out_jpg)], check=True)
    return total


def record(cid, chapter, voice, checker, out_dir, base_url, headless=True):
    from playwright.sync_api import sync_playwright
    bad = prepare_speech(chapter, voice, checker)
    market = mock.Market()
    market.series('BTCUSDT')  # заранее, чтобы запись не ждала
    tmp = Path('/tmp') / f'help-rec-{cid}-{os.getpid()}'
    tmp.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), headless=headless, args=['--no-sandbox'])
        ctx = browser.new_context(viewport={'width': W, 'height': H}, record_video_dir=str(tmp), record_video_size={'width': W, 'height': H},
                                  locale='ru-RU', timezone_id='Europe/Moscow')
        mock.install(ctx, market)
        ctx.add_init_script(path=str(HERE / 'inject.js'))
        state = {'market': 'futures', 'layout': '1', 'panes': [{'symbol': 'BTCUSDT', 'interval': '1h'}], 'lastSymbol': {'futures': 'BTCUSDT'}}
        state.update(chapter.get('state', {}))
        ctx.add_init_script(script=preset_js(state))
        page = ctx.new_page()
        t_page = time.time()
        page.goto(base_url)
        page.wait_for_selector('#grid canvas', timeout=20000)
        page.wait_for_timeout(1800)
        scene = Scene(page, voice, checker)
        scene.t0 = time.time() + 0.8      # 0,8 с тишины в начале
        trim = scene.t0 - t_page
        page.wait_for_timeout(800)
        chapter['run'](scene)
        scene.wait_speech(0.6)
        video = page.video
        ctx.close()
        vpath = video.path()
        browser.close()
    out_mp4, out_jpg = out_dir / f'{cid}.mp4', out_dir / f'{cid}.jpg'
    total = mux(vpath, scene, trim, out_mp4, out_jpg)
    for f in tmp.glob('*'):
        f.unlink()
    tmp.rmdir()
    return total, bad


def fmt_len(sec):
    sec = int(round(sec))
    return f'{sec // 60}:{sec % 60:02d}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('chapters', nargs='+', help='id главы (overview, symbol, layout, draw, ind, alerts, paper, list, snap, phone) или all')
    ap.add_argument('--voice', default='irina', choices=['irina', 'ruslan', 'denis', 'dmitri'])
    ap.add_argument('--speed', type=float, default=0.92, help='скорость речи: меньше — медленнее')
    ap.add_argument('--check', action='store_true', help='проверить озвучку распознаванием речи')
    ap.add_argument('--out', default=str(ROOT / 'public' / 'help'))
    ap.add_argument('--dist', default=str(ROOT / 'dist'))
    ap.add_argument('--show', action='store_true', help='показывать окно браузера')
    a = ap.parse_args()
    import chapters
    ids = [c for c in chapters.ORDER] if a.chapters == ['all'] else a.chapters
    voice = Voice(a.voice, a.speed)
    checker = Checker() if a.check else None
    srv = serve(a.dist)
    base = f'http://127.0.0.1:{srv.server_address[1]}/'
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    lens = {}
    for cid in ids:
        t = time.time()
        total, bad = record(cid, chapters.CHAPTERS[cid], voice, checker, out, base, headless=not a.show)
        lens[cid] = fmt_len(total)
        print(f'{cid}: {fmt_len(total)} ({time.time() - t:.0f} с на запись)')
        for sc, spoken, hyp in bad:
            print(f'   ⚠ плохо слышно ({sc}): «{spoken}» → распознано «{hyp}»')
    print(json.dumps(lens, ensure_ascii=False))


if __name__ == '__main__':
    main()
