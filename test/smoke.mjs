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

// 3b: page relay tutor -> student (page-follow) ------------------------------
const pageMsg = nextMessage(guest)
host.send(JSON.stringify({ type: 'page', pageId: 'page:lesson-page-2' }))
const pageRelayed = await pageMsg
check(
  'student receives tutor page change',
  !!pageRelayed && JSON.parse(pageRelayed).type === 'page' && JSON.parse(pageRelayed).pageId === 'page:lesson-page-2',
)
// student cannot drive the page
let hostGotPage = false
host.once('message', () => (hostGotPage = true))
guest.send(JSON.stringify({ type: 'page', pageId: 'page:hacked' }))
await wait(200)
check('student cannot drive the page (ignored)', hostGotPage === false)

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
check(
  'late student snaps to tutor page on join',
  collected.some((m) => m.type === 'page' && m.pageId === 'page:lesson-page-2'),
)
check('late student receives calculator open on join', collected.some((m) => m.type === 'calc' && m.action === 'open'))
check(
  'late student receives calculator state on join',
  collected.some(
    (m) => m.type === 'calc' && m.action === 'state' && m.state?.expressions?.list?.[0]?.latex === 'y=2x',
  ),
)

// 5b: tutor moves/resizes the calculator; students mirror it -----------------
const geomMsg = nextMessage(guest)
const geom = { x: 100, y: 80, w: 500, h: 600 }
host.send(JSON.stringify({ type: 'calc', action: 'geom', geom }))
const gotGeom = await geomMsg
check(
  'student receives calculator geometry',
  !!gotGeom && JSON.parse(gotGeom).action === 'geom' && JSON.parse(gotGeom).geom?.w === 500,
)
// a student cannot drive the shared geometry
const beforeGeom = collected.length
guest.send(JSON.stringify({ type: 'calc', action: 'geom', geom: { x: 0, y: 0, w: 1, h: 1 } }))
await wait(150)
check(
  'student cannot drive calculator geometry (ignored)',
  !collected.slice(beforeGeom).some((m) => m.action === 'geom' && m.geom?.w === 1),
)
// a late student snaps to the last geometry on join
const geomGuest = await open(`${WS}/control/${ROOM}?role=guest`)
const geomJoin = []
geomGuest.on('message', (d) => geomJoin.push(JSON.parse(d.toString())))
await wait(300)
check(
  'late student receives calculator geometry on join',
  geomJoin.some((m) => m.type === 'calc' && m.action === 'geom' && m.geom?.h === 600),
)

// 6: global edit access toggle (all students) -------------------------------
const hostInbox = []
host.on('message', (d) => hostInbox.push(JSON.parse(d.toString())))
const accessMsg = nextMessage(guest)
host.send(JSON.stringify({ type: 'calc-access', allow: true }))
const access = await accessMsg
check('students are told editing is enabled', !!access && JSON.parse(access).type === 'calc-access' && JSON.parse(access).allow === true)

// 7: while enabled, a student's edits propagate to the tutor -----------------
const hostState = nextMessage(host)
const studentEdit = { version: 9, expressions: { list: [{ id: '2', latex: 'y=x^2' }] } }
guest.send(JSON.stringify({ type: 'calc', action: 'state', state: studentEdit }))
const got = await hostState
check(
  "tutor receives a student's calculator edit when enabled",
  !!got && JSON.parse(got).action === 'state' && JSON.parse(got).state.expressions.list[0].latex === 'y=x^2',
)

// 8: disable editing again ---------------------------------------------------
const offMsg = nextMessage(guest)
host.send(JSON.stringify({ type: 'calc-access', allow: false }))
const off = await offMsg
check('students are told editing is disabled', !!off && JSON.parse(off).allow === false)
const before = hostInbox.length
guest.send(JSON.stringify({ type: 'calc', action: 'state', state: { sneaky: true } }))
await wait(200)
const after = hostInbox.slice(before)
check(
  'student cannot edit once disabled again',
  !after.some((m) => m.type === 'calc' && m.action === 'state'),
)

// 9: a late student is told the current edit-access setting on join ----------
host.send(JSON.stringify({ type: 'calc-access', allow: true }))
await wait(100)
const newGuest = await open(`${WS}/control/${ROOM}?role=guest`)
const joinMsgs = []
newGuest.on('message', (d) => joinMsgs.push(JSON.parse(d.toString())))
await wait(300)
check('late student receives current edit-access on join', joinMsgs.some((m) => m.type === 'calc-access' && m.allow === true))

// 10: class mode relay + write-access grants (large group) -------------------
{
  const m = `mode-${Math.random().toString(36).slice(2, 8)}`
  const h = await open(`${WS}/control/${m}?role=host`)
  const g = await open(`${WS}/control/${m}?role=guest`)
  await wait(100)
  // tutor declares large mode
  const modeMsg = nextMessage(g)
  h.send(JSON.stringify({ type: 'mode', mode: 'large' }))
  const gotMode = await modeMsg
  check('student receives class mode', !!gotMode && JSON.parse(gotMode).type === 'mode' && JSON.parse(gotMode).mode === 'large')
  // tutor grants a specific student write access
  const grantMsg = nextMessage(g)
  h.send(JSON.stringify({ type: 'access', userId: 'stu-1', allow: true }))
  const gotGrant = await grantMsg
  check(
    'student receives a write-access grant',
    !!gotGrant && JSON.parse(gotGrant).type === 'access' && JSON.parse(gotGrant).userId === 'stu-1' && JSON.parse(gotGrant).allow === true,
  )
  // a late joiner is told the mode + who already has write access
  const late = await open(`${WS}/control/${m}?role=guest`)
  const lateMsgs = []
  late.on('message', (d) => lateMsgs.push(JSON.parse(d.toString())))
  await wait(300)
  check('late student receives current mode on join', lateMsgs.some((x) => x.type === 'mode' && x.mode === 'large'))
  check('late student receives existing grants on join', lateMsgs.some((x) => x.type === 'access' && x.userId === 'stu-1' && x.allow === true))
  // students cannot grant access to themselves (guest->host access ignored)
  let hostGotAccess = false
  h.once('message', () => (hostGotAccess = true))
  g.send(JSON.stringify({ type: 'access', userId: 'stu-1', allow: true }))
  await wait(200)
  check('student cannot grant write access (ignored)', hostGotAccess === false)
  for (const ws of [h, g, late]) ws.close()
}

// 11: free-reign relay + late-join replay ------------------------------------
{
  const r = `free-${Math.random().toString(36).slice(2, 8)}`
  const h = await open(`${WS}/control/${r}?role=host`)
  const g = await open(`${WS}/control/${r}?role=guest`)
  await wait(100)
  const frMsgs = []
  g.on('message', (d) => frMsgs.push(JSON.parse(d.toString())))
  h.send(JSON.stringify({ type: 'free-reign', on: true }))
  await wait(150)
  check('student receives free-reign on', frMsgs.some((x) => x.type === 'free-reign' && x.on === true))
  // late joiner is told free reign is currently on
  const late = await open(`${WS}/control/${r}?role=guest`)
  const lateFr = []
  late.on('message', (d) => lateFr.push(JSON.parse(d.toString())))
  await wait(300)
  check('late student receives current free-reign on join', lateFr.some((x) => x.type === 'free-reign' && x.on === true))
  // student cannot drive free reign
  let hostGotFr = false
  h.once('message', () => (hostGotFr = true))
  g.send(JSON.stringify({ type: 'free-reign', on: false }))
  await wait(200)
  check('student cannot drive free reign (ignored)', hostGotFr === false)
  for (const ws of [h, g, late]) ws.close()
}

// 12: quiz answer collection (host-only stats, key never leaks to guests) ----
{
  const MAX_ANSWER_LEN = 32
  const r = `quiz-${Math.random().toString(36).slice(2, 8)}`
  const h = await open(`${WS}/control/${r}?role=host`)
  const g = await open(`${WS}/control/${r}?role=guest`)
  await wait(100)

  const hostMsgs = []
  h.on('message', (d) => hostMsgs.push(JSON.parse(d.toString())))
  const guestMsgs = []
  g.on('message', (d) => guestMsgs.push(JSON.parse(d.toString())))
  const lastStats = () => hostMsgs.filter((m) => m.type === 'quiz-stats').at(-1)

  // Host uploads a key: one immediate-reveal MC question, one never-reveal grid-in.
  h.send(
    JSON.stringify({
      type: 'quiz-key',
      questions: [
        { id: 'q1', format: 'choice', key: 'B', reveal: 'immediate' },
        { id: 'q2', format: 'grid', key: '2/3', reveal: 'never' },
      ],
    }),
  )
  await wait(150)
  const statsAfterKey = lastStats()
  check(
    'host receives quiz-stats after quiz-key, both questions answered:0',
    !!statsAfterKey &&
      statsAfterKey.stats.questions.length === 2 &&
      statsAfterKey.stats.questions.every((q) => q.answered === 0),
  )

  // Guest sees q1, waits, then answers correctly. Reveal is immediate -> ack carries correct.
  g.send(JSON.stringify({ type: 'quiz-seen', userId: 'stu-a', qids: ['q1', 'q2'] }))
  await wait(50)
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-a', name: 'Alice', qid: 'q1', value: 'B' }))
  await wait(150)
  const ack1 = guestMsgs.filter((m) => m.type === 'quiz-ack' && m.qid === 'q1').at(-1)
  check('guest receives quiz-ack for q1 with correct === true (immediate reveal)', !!ack1 && ack1.correct === true)
  const statsAfterQ1 = lastStats()
  const q1StatsFirst = statsAfterQ1 && statsAfterQ1.stats.questions.find((q) => q.qid === 'q1')
  check(
    'host stats show q1 answered:1, firstCorrect:1, medianMs a number >= 0',
    !!q1StatsFirst &&
      q1StatsFirst.answered === 1 &&
      q1StatsFirst.firstCorrect === 1 &&
      typeof q1StatsFirst.medianMs === 'number' &&
      q1StatsFirst.medianMs >= 0,
  )

  // Guest answers q2 with the rounded repeating decimal. Reveal is 'never' -> no correct field.
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-a', name: 'Alice', qid: 'q2', value: '.6667' }))
  await wait(150)
  const ack2 = guestMsgs.filter((m) => m.type === 'quiz-ack' && m.qid === 'q2').at(-1)
  check('guest receives quiz-ack for q2 with no correct property (reveal never)', !!ack2 && !('correct' in ack2))
  const q2Stats = lastStats().stats.questions.find((q) => q.qid === 'q2')
  check('host stats show q2 firstCorrect:1 despite never-reveal', !!q2Stats && q2Stats.firstCorrect === 1)

  // Same student resubmits q1 with a wrong answer: only latest/latestCorrect move.
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-a', name: 'Alice', qid: 'q1', value: 'C' }))
  await wait(150)
  const q1StatsResubmit = lastStats().stats.questions.find((q) => q.qid === 'q1')
  check(
    'resubmission: answered stays 1, firstCorrect unchanged, latestCorrect flips, elapsedMs (medianMs) unchanged',
    !!q1StatsResubmit &&
      q1StatsResubmit.answered === 1 &&
      q1StatsResubmit.firstCorrect === 1 &&
      q1StatsResubmit.latestCorrect === 0 &&
      q1StatsResubmit.medianMs === q1StatsFirst.medianMs,
  )

  // A guest cannot install a key or trigger reveal — those live only in the host branch.
  const beforeFakeCount = hostMsgs.length
  g.send(
    JSON.stringify({ type: 'quiz-key', questions: [{ id: 'evil', format: 'choice', key: 'A', reveal: 'immediate' }] }),
  )
  g.send(JSON.stringify({ type: 'quiz-reveal' }))
  await wait(150)
  check('guest quiz-key/quiz-reveal produce no host stats push', hostMsgs.length === beforeFakeCount)
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-x', name: 'X', qid: 'evil', value: 'A' }))
  await wait(150)
  check(
    'guest-supplied key was never installed (answer to it is ignored)',
    !guestMsgs.some((m) => m.type === 'quiz-ack' && m.qid === 'evil'),
  )

  // An overlong answer is rejected outright (no ack, no stats change).
  const beforeLongHost = hostMsgs.length
  const beforeLongGuest = guestMsgs.length
  g.send(
    JSON.stringify({ type: 'quiz-answer', userId: 'stu-b', name: 'Bob', qid: 'q1', value: 'X'.repeat(MAX_ANSWER_LEN + 1) }),
  )
  await wait(150)
  check('overlong answer produces no ack', guestMsgs.length === beforeLongGuest)
  check('overlong answer produces no stats push', hostMsgs.length === beforeLongHost)

  // An answer for an unknown qid is ignored outright.
  const beforeUnknownHost = hostMsgs.length
  const beforeUnknownGuest = guestMsgs.length
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-c', name: 'Cara', qid: 'nope', value: 'A' }))
  await wait(150)
  check('unknown-qid answer produces no ack', guestMsgs.length === beforeUnknownGuest)
  check('unknown-qid answer produces no stats push', hostMsgs.length === beforeUnknownHost)

  // Host reveals: guest gets the answer keys; a late joiner gets them too.
  h.send(JSON.stringify({ type: 'quiz-reveal' }))
  await wait(150)
  const revealed = guestMsgs.filter((m) => m.type === 'quiz-revealed').at(-1)
  check('guest receives quiz-revealed with keys.q1 === "B"', !!revealed && revealed.keys.q1 === 'B')

  const late = await open(`${WS}/control/${r}?role=guest`)
  const lateMsgs = []
  late.on('message', (d) => lateMsgs.push(JSON.parse(d.toString())))
  await wait(300)
  check(
    'late-joining guest also receives quiz-revealed on connect',
    lateMsgs.some((m) => m.type === 'quiz-revealed' && m.keys?.q1 === 'B'),
  )

  // A reconnecting host is replayed the current stats so it doesn't lose the panel.
  const h2 = await open(`${WS}/control/${r}?role=host`)
  const h2Msgs = []
  h2.on('message', (d) => h2Msgs.push(JSON.parse(d.toString())))
  await wait(300)
  check('reconnecting host receives quiz-stats on connect', h2Msgs.some((m) => m.type === 'quiz-stats'))

  // A guest must never receive quiz-stats — it contains every student's answers.
  check(
    'guest never receives quiz-stats',
    ![...guestMsgs, ...lateMsgs].some((m) => m.type === 'quiz-stats'),
  )

  for (const ws of [h, g, late, h2]) ws.close()
}

// 13: a page with more questions than the guest rate limit --------------------
// Regression: `quiz-seen` is batched precisely so a page like the Homework Review
// (16 problems, all rendering at once) can't trip the per-second limiter and lose
// the seenAt timestamps, which would silently report elapsedMs: 0 for the tail.
{
  const r = `seen-${Math.random().toString(36).slice(2, 8)}`
  const h = await open(`${WS}/control/${r}?role=host`)
  const g = await open(`${WS}/control/${r}?role=guest`)
  await wait(100)
  const hostMsgs = []
  h.on('message', (d) => hostMsgs.push(JSON.parse(d.toString())))

  const N = 16 // > GUEST_MSG_RATE (10)
  const questions = Array.from({ length: N }, (_, i) => ({
    id: `s${i}`,
    format: 'grid',
    key: String(i),
    reveal: 'never',
  }))
  h.send(JSON.stringify({ type: 'quiz-key', questions }))
  await wait(150)

  // One batched message covering the whole page, as a real client would send.
  g.send(JSON.stringify({ type: 'quiz-seen', userId: 'stu-z', qids: questions.map((q) => q.id) }))
  await wait(120)

  // Answer the LAST question — the one a per-question sender would have dropped.
  const lastId = `s${N - 1}`
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-z', name: 'Zoe', qid: lastId, value: String(N - 1) }))
  await wait(200)

  const stats = hostMsgs.filter((m) => m.type === 'quiz-stats').at(-1)
  const lastQ = stats && stats.stats.questions.find((q) => q.qid === lastId)
  check(`all ${N} questions present in stats`, !!stats && stats.stats.questions.length === N)
  check('last question on an oversized page was graded correct', !!lastQ && lastQ.firstCorrect === 1)
  check(
    'last question retained its seenAt (elapsedMs > 0, not a dropped quiz-seen)',
    !!lastQ && lastQ.students[0].elapsedMs > 0,
  )
  for (const ws of [h, g]) ws.close()
}

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
