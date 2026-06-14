// Headless integration test for the custom server pieces:
//   1. asset upload/serve round-trip (per-room, in-memory)
//   2. tutor->student camera relay over the /control channel
//   3. late-joining student immediately receives the tutor's last camera
//   4. /connect sync socket accepts the upgrade and stays open (handleSocketConnect wiring)
//   5. unknown ws paths are rejected
import WebSocket from 'ws'

const BASE = process.env.BASE || 'http://localhost:5858'
const WS = BASE.replace(/^http/, 'ws')
const ROOM = `test-${Math.random().toString(36).slice(2, 8)}`

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}
function nextMessage(ws, timeout = 3000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeout)
    ws.once('message', (d) => {
      clearTimeout(t)
      resolve(d.toString())
    })
  })
}

// 1 + 2: assets ---------------------------------------------------------------
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const up = await fetch(`${BASE}/uploads/${ROOM}/asset1`, {
  method: 'POST',
  headers: { 'content-type': 'image/png' },
  body: PNG,
})
check('asset upload returns ok', up.ok)
const down = await fetch(`${BASE}/uploads/${ROOM}/asset1`)
const bytes = Buffer.from(await down.arrayBuffer())
check('asset download content-type is image/png', down.headers.get('content-type') === 'image/png')
check('asset round-trips byte-for-byte', bytes.equals(PNG))
const missing = await fetch(`${BASE}/uploads/${ROOM}/nope`)
check('missing asset returns 404', missing.status === 404)

// 3: camera relay tutor -> student -------------------------------------------
const host = await open(`${WS}/control/${ROOM}?role=host`)
const guest = await open(`${WS}/control/${ROOM}?role=guest`)
await wait(100)
const cam = { x: 12, y: -34, z: 1.5 }
host.send(JSON.stringify({ type: 'camera', camera: cam }))
const relayed = await nextMessage(guest)
check('student receives tutor camera', !!relayed && JSON.stringify(JSON.parse(relayed).camera) === JSON.stringify(cam))

// student cannot drive the camera (guest->host messages are ignored)
let hostGotMsg = false
host.once('message', () => (hostGotMsg = true))
guest.send(JSON.stringify({ type: 'camera', camera: { x: 999, y: 999, z: 9 } }))
await wait(200)
check('student cannot drive the camera (ignored)', hostGotMsg === false)

// 4 (late join): a student joining now gets the last camera immediately
const lateGuest = await open(`${WS}/control/${ROOM}?role=guest`)
const lateMsg = await nextMessage(lateGuest)
check('late student snaps to last camera on join', !!lateMsg && JSON.stringify(JSON.parse(lateMsg).camera) === JSON.stringify(cam))

// 5: /connect sync socket accepts upgrade and stays open ----------------------
const sync = await open(`${WS}/connect/${ROOM}?sessionId=sess-1`)
await wait(1500)
check('sync socket stays open (handleSocketConnect wired)', sync.readyState === WebSocket.OPEN)

// 6: unknown ws path is rejected ---------------------------------------------
let rejected = false
await new Promise((resolve) => {
  const bad = new WebSocket(`${WS}/bogus/path`)
  bad.once('error', () => {
    rejected = true
    resolve()
  })
  bad.once('open', () => {
    bad.close()
    resolve()
  })
})
check('unknown ws path is rejected', rejected)

for (const ws of [host, guest, lateGuest, sync]) ws.close()
await wait(100)

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
