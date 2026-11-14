// Шифрование закрытого индикатора (запускает разработчик, НЕ сайт).
//   node tools/lock.mjs <id> <исходник.js> <люди.json>
// люди.json: { "Имя": "LR-XXXX-XXXX-XXXX", ... } — хранится только у разработчика.
// Каждый запуск создаёт новый главный ключ: убрали человека из списка — его пароль перестаёт работать.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { webcrypto as crypto } from 'node:crypto'

const [id, src, peopleFile] = process.argv.slice(2)
const ITER = 200_000
const enc = new TextEncoder()
const b64 = (u) => Buffer.from(u).toString('base64')
const hex = (buf) => Buffer.from(buf).toString('hex')
const norm = (p) => String(p).trim().toUpperCase().replace(/\s+/g, '')

const code = readFileSync(src)
const people = JSON.parse(readFileSync(peopleFile, 'utf8'))
const master = crypto.getRandomValues(new Uint8Array(32))
const mk = await crypto.subtle.importKey('raw', master, 'AES-GCM', false, ['encrypt'])
const iv = crypto.getRandomValues(new Uint8Array(12))
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, mk, code))
const entries = []
for (const pass of Object.values(people).map(norm)) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey'])
  const kek = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const wiv = crypto.getRandomValues(new Uint8Array(12))
  const key = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wiv }, kek, master))
  const pid = hex(await crypto.subtle.digest('SHA-256', enc.encode(`${id}:${pass}`))).slice(0, 16)
  entries.push({ id: pid, salt: b64(salt), iv: b64(wiv), key: b64(key) })
}
entries.sort(() => Math.random() - 0.5) // порядок не выдаёт, кто есть кто
mkdirSync('public/locked', { recursive: true })
writeFileSync(`public/locked/${id}.bin`, Buffer.concat([iv, ct]))
writeFileSync(`public/locked/${id}.keys.json`, JSON.stringify({ v: 1, iter: ITER, entries }))
console.log(`${id}: зашифровано для ${entries.length} чел.`)
