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

// 4: live calculator relay tutor -> student ---------------------------------
host.send(JSON.stringify({ type: 'calc', action: 'open' }))
const calcOpenMsg = await nextMessage(guest)
check('student receives calculator open', !!calcOpenMsg && JSON.parse(calcOpenMsg).action === 'open')
const calcState = { version: 9, expressions: { list: [{ id: '1', latex: 'y=2x' }] } }
host.send(JSON.stringify({ type: 'calc', action: 'state', state: calcState }))
const calcStateMsg = await nextMessage(guest)
check(
  'student receives live calculator state',
  !!calcStateMsg &&
    JSON.parse(calcStateMsg).action === 'state' &&
    JSON.parse(calcStateMsg).state.expressions.list[0].latex === 'y=2x',
)

// student cannot drive the calculator (guest->host calc messages are ignored)
let hostGotCalc = false
host.once('message', () => (hostGotCalc = true))
guest.send(JSON.stringify({ type: 'calc', action: 'state', state: { hacked: true } }))
await wait(200)
check('student cannot drive the calculator (ignored)', hostGotCalc === false)

// 5 (late join): a student joining now gets camera + open calculator + its state
const lateGuest = await open(`${WS}/control/${ROOM}?role=guest`)
const collected = []
lateGuest.on('message', (d) => collected.push(JSON.parse(d.toString())))
await wait(400)
check(
  'late student snaps to last camera on join',
  collected.some((m) => m.type === 'camera' && JSON.stringify(m.camera) === JSON.stringify(cam)),
)
check('late student receives calculator open on join', collected.some((m) => m.type === 'calc' && m.action === 'open'))
check(
  'late student receives calculator state on join',
  collected.some(
    (m) => m.type === 'calc' && m.action === 'state' && m.state?.expressions?.list?.[0]?.latex === 'y=2x',
  ),
)

// 6: identity + roster -------------------------------------------------------
const hostInbox = []
host.on('message', (d) => hostInbox.push(JSON.parse(d.toString())))
guest.send(JSON.stringify({ type: 'hello', userId: 'stu-1', name: 'Fox 42' }))
await wait(200)
const roster = [...hostInbox].reverse().find((m) => m.type === 'roster')
check('tutor receives roster after student hello', !!roster && roster.students.some((s) => s.id === 'stu-1' && s.name === 'Fox 42'))
check('student starts as view-only in roster', !!roster && roster.students.find((s) => s.id === 'stu-1')?.canEdit === false)

// 7: grant edit access -------------------------------------------------------
const permMsg = nextMessage(guest)
host.send(JSON.stringify({ type: 'grant', studentId: 'stu-1', canEdit: true }))
const perm = await permMsg
check('granted student is told it can edit', !!perm && JSON.parse(perm).type === 'calc-permission' && JSON.parse(perm).canEdit === true)
await wait(100)
const roster2 = [...hostInbox].reverse().find((m) => m.type === 'roster')
check('roster reflects granted student', !!roster2 && roster2.students.find((s) => s.id === 'stu-1')?.canEdit === true)

// 8: granted student's edits propagate to the tutor (bidirectional) ----------
const hostState = nextMessage(host)
const studentEdit = { version: 9, expressions: { list: [{ id: '2', latex: 'y=x^2' }] } }
guest.send(JSON.stringify({ type: 'calc', action: 'state', state: studentEdit }))
const got = await hostState
check(
  "tutor receives granted student's calculator edit",
  !!got && JSON.parse(got).action === 'state' && JSON.parse(got).state.expressions.list[0].latex === 'y=x^2',
)

// 9: revoke edit access ------------------------------------------------------
const revokeMsg = nextMessage(guest)
host.send(JSON.stringify({ type: 'grant', studentId: 'stu-1', canEdit: false }))
const revoke = await revokeMsg
check('revoked student is told it cannot edit', !!revoke && JSON.parse(revoke).canEdit === false)
// after revoke, the student's calculator edits are ignored again
const before = hostInbox.length
guest.send(JSON.stringify({ type: 'calc', action: 'state', state: { sneaky: true } }))
await wait(200)
const after = hostInbox.slice(before)
check(
  'revoked student can no longer drive the calculator',
  !after.some((m) => m.type === 'calc' && m.action === 'state'),
)

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
