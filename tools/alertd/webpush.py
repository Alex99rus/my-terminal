"""Web Push (RFC 8030/8291/8292) на одной библиотеке `cryptography` — без pywebpush.

Что делает: шифрует сообщение под подписку телефона и отправляет его на сервер push-службы
(Google/Apple/Mozilla), подписав запрос своим VAPID-ключом.
"""
import base64
import json
import os
import struct
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def b64e(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def b64d(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def _pub_bytes(pub):
    return pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def load_or_create_vapid(path):
    """Ключи сервера: создаются один раз и лежат в файле. Возвращает (закрытый ключ, открытый ключ в base64url)."""
    try:
        with open(path, encoding='utf-8') as f:
            raw = b64d(json.load(f)['private'])
        priv = ec.derive_private_key(int.from_bytes(raw, 'big'), ec.SECP256R1())
    except FileNotFoundError:
        priv = ec.generate_private_key(ec.SECP256R1())
        os.makedirs(os.path.dirname(path), exist_ok=True)
        old = os.umask(0o077)
        try:
            with open(path, 'w', encoding='utf-8') as f:
                json.dump({'private': b64e(priv.private_numbers().private_value.to_bytes(32, 'big'))}, f)
        finally:
            os.umask(old)
    return priv, b64e(_pub_bytes(priv.public_key()))


def vapid_auth(endpoint, priv, pub_b64, subject):
    u = urllib.parse.urlparse(endpoint)
    head = b64e(json.dumps({'typ': 'JWT', 'alg': 'ES256'}, separators=(',', ':')).encode())
    claims = b64e(json.dumps({'aud': f'{u.scheme}://{u.netloc}', 'exp': int(time.time()) + 12 * 3600, 'sub': subject}, separators=(',', ':')).encode())
    signing = f'{head}.{claims}'.encode()
    r, s = decode_dss_signature(priv.sign(signing, ec.ECDSA(hashes.SHA256())))
    sig = r.to_bytes(32, 'big') + s.to_bytes(32, 'big')
    return f'vapid t={signing.decode()}.{b64e(sig)}, k={pub_b64}'


def _hkdf(salt, ikm, info, n):
    return HKDF(algorithm=hashes.SHA256(), length=n, salt=salt, info=info).derive(ikm)


def encrypt(payload, p256dh_b64, auth_b64):
    """Шифрование сообщения для подписки (aes128gcm, RFC 8291)."""
    ua_pub = b64d(p256dh_b64)
    auth = b64d(auth_b64)
    eph = ec.generate_private_key(ec.SECP256R1())
    as_pub = _pub_bytes(eph.public_key())
    shared = eph.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub))
    prk = _hkdf(auth, shared, b'WebPush: info\x00' + ua_pub + as_pub, 32)
    salt = os.urandom(16)
    cek = _hkdf(salt, prk, b'Content-Encoding: aes128gcm\x00', 16)
    nonce = _hkdf(salt, prk, b'Content-Encoding: nonce\x00', 12)
    ct = AESGCM(cek).encrypt(nonce, payload + b'\x02', None)
    return salt + struct.pack('>IB', 4096, len(as_pub)) + as_pub + ct


def send(sub, payload, priv, pub_b64, subject, timeout=15):
    """Отправляет одно сообщение. Возвращает код ответа (201 — принято; 404/410 — подписка умерла; 0 — нет связи)."""
    endpoint = sub['endpoint']
    body = encrypt(payload, sub['keys']['p256dh'], sub['keys']['auth'])
    req = urllib.request.Request(
        endpoint,
        data=body,
        method='POST',
        headers={
            'Authorization': vapid_auth(endpoint, priv, pub_b64, subject),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            'TTL': '86400',
            'Urgency': 'high',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:  # noqa: BLE001
        return 0
