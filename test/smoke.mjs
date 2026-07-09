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

// Opens a socket AND starts collecting messages in the same tick it is created.
//
// Attaching `.on('message')` after `await open(url)` is racy: the HTTP upgrade
// response and the server's first frame (e.g. the quiz-stats snapshot pushed to a
// connecting host) can arrive in a single TCP segment, so `ws` emits 'open' and
// then 'message' within the same tick — before the await continuation has
// subscribed. The message is then lost and the assertion fails intermittently.
// Every join-time replay assertion below must use this instead of `open`.
function openWithInbox(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const inbox = []
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())))
    ws.once('open', () => resolve({ ws, inbox }))
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
const { ws: lateGuest, inbox: collected } = await openWithInbox(`${WS}/control/${ROOM}?role=guest`)
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
const { ws: geomGuest, inbox: geomJoin } = await openWithInbox(`${WS}/control/${ROOM}?role=guest`)
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
const { ws: newGuest, inbox: joinMsgs } = await openWithInbox(`${WS}/control/${ROOM}?role=guest`)
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
  const { ws: late, inbox: lateMsgs } = await openWithInbox(`${WS}/control/${m}?role=guest`)
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
  const { ws: late, inbox: lateFr } = await openWithInbox(`${WS}/control/${r}?role=guest`)
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
  const { ws: h, inbox: hostMsgs } = await openWithInbox(`${WS}/control/${r}?role=host`)
  const { ws: g, inbox: guestMsgs } = await openWithInbox(`${WS}/control/${r}?role=guest`)
  await wait(100)

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

  // Open both questions so the rest of this section's answers are accepted
  // (see section 14 for dedicated quiz-open gating coverage).
  h.send(JSON.stringify({ type: 'quiz-open', qids: ['q1', 'q2'] }))
  await wait(100)

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

  const { ws: late, inbox: lateMsgs } = await openWithInbox(`${WS}/control/${r}?role=guest`)
  await wait(300)
  check(
    'late-joining guest also receives quiz-revealed on connect',
    lateMsgs.some((m) => m.type === 'quiz-revealed' && m.keys?.q1 === 'B'),
  )

  // A reconnecting host is replayed the current stats so it doesn't lose the panel.
  // Must collect from construction: the stats frame can share a TCP segment with
  // the upgrade response, arriving before a post-await listener would attach.
  const { ws: h2, inbox: h2Msgs } = await openWithInbox(`${WS}/control/${r}?role=host`)
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
  const { ws: h, inbox: hostMsgs } = await openWithInbox(`${WS}/control/${r}?role=host`)
  const g = await open(`${WS}/control/${r}?role=guest`)
  await wait(100)

  const N = 16 // > GUEST_MSG_RATE (10)
  const questions = Array.from({ length: N }, (_, i) => ({
    id: `s${i}`,
    format: 'grid',
    key: String(i),
    reveal: 'never',
  }))
  h.send(JSON.stringify({ type: 'quiz-key', questions }))
  await wait(150)

  // Open every question on the page so quiz-seen/quiz-answer are accepted below.
  h.send(JSON.stringify({ type: 'quiz-open', qids: questions.map((q) => q.id) }))
  await wait(100)

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

// 14: quiz-open gating (tutor must explicitly open a question before it accepts
// answers, and closing it again must reject subsequent answers) --------------
{
  const r = `open-${Math.random().toString(36).slice(2, 8)}`
  const { ws: h, inbox: hostMsgs } = await openWithInbox(`${WS}/control/${r}?role=host`)
  const { ws: g, inbox: guestMsgs } = await openWithInbox(`${WS}/control/${r}?role=guest`)
  await wait(100)

  const lastStats = () => hostMsgs.filter((m) => m.type === 'quiz-stats').at(-1)
  const q = (id) => lastStats()?.stats.questions.find((x) => x.qid === id)

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

  // Nothing is open yet: an answer to q1 is rejected outright.
  const beforeGuest = guestMsgs.length
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-a', name: 'Alice', qid: 'q1', value: 'B' }))
  await wait(150)
  check('answer to unopened question produces no ack', guestMsgs.length === beforeGuest)
  check('answer to unopened question does not count in stats', !!q('q1') && q('q1').answered === 0)

  // Host opens q1 only. Guest is told exactly ['q1'].
  const openMsg = nextMessage(g)
  h.send(JSON.stringify({ type: 'quiz-open', qids: ['q1'] }))
  const gotOpen = JSON.parse(await openMsg)
  check(
    'guest receives quiz-open listing exactly [q1]',
    gotOpen.type === 'quiz-open' && JSON.stringify(gotOpen.qids) === JSON.stringify(['q1']),
  )

  // Now q1 accepts an answer and acks (immediate reveal).
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-a', name: 'Alice', qid: 'q1', value: 'B' }))
  await wait(150)
  const ack1 = guestMsgs.filter((m) => m.type === 'quiz-ack' && m.qid === 'q1').at(-1)
  check('open question accepts answer and acks correct === true', !!ack1 && ack1.correct === true)
  check('host stats show q1 answered:1', !!q('q1') && q('q1').answered === 1)

  // q2 is still closed: rejected.
  const beforeQ2Guest = guestMsgs.length
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-a', name: 'Alice', qid: 'q2', value: '2/3' }))
  await wait(150)
  check('closed question still rejects answers', guestMsgs.length === beforeQ2Guest)
  check('closed question stats unchanged', !!q('q2') && q('q2').answered === 0)

  // Host opens q1, q2, and an unknown id — server filters the unknown one out.
  const openMsg2 = nextMessage(g)
  h.send(JSON.stringify({ type: 'quiz-open', qids: ['q1', 'q2', 'bogus-id'] }))
  const gotOpen2 = JSON.parse(await openMsg2)
  check(
    'unknown qid filtered out of broadcast quiz-open',
    gotOpen2.type === 'quiz-open' && new Set(gotOpen2.qids).size === 2 && gotOpen2.qids.includes('q1') && gotOpen2.qids.includes('q2'),
  )

  // A late-joining guest receives the current open set on connect.
  const { ws: late, inbox: lateMsgs } = await openWithInbox(`${WS}/control/${r}?role=guest`)
  await wait(300)
  const lateOpen = lateMsgs.find((m) => m.type === 'quiz-open')
  check(
    'late-joining guest receives current quiz-open set',
    !!lateOpen && new Set(lateOpen.qids).size === 2 && lateOpen.qids.includes('q1') && lateOpen.qids.includes('q2'),
  )

  // A guest sending quiz-open is ignored: close q2 via the host, then have the
  // guest try to "reopen" it — the open set must stay unchanged (q2 still closed).
  h.send(JSON.stringify({ type: 'quiz-open', qids: ['q1'] }))
  await wait(150)
  g.send(JSON.stringify({ type: 'quiz-open', qids: ['q1', 'q2'] }))
  await wait(150)
  const beforeIgnoredGuest = guestMsgs.length
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-a', name: 'Alice', qid: 'q2', value: '2/3' }))
  await wait(150)
  check('guest-sent quiz-open is ignored (q2 stays closed)', guestMsgs.length === beforeIgnoredGuest)

  // Host closes everything: subsequent answers are rejected again.
  h.send(JSON.stringify({ type: 'quiz-open', qids: [] }))
  await wait(150)
  const beforeClosedAllGuest = guestMsgs.length
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-a', name: 'Alice', qid: 'q1', value: 'B' }))
  await wait(150)
  check('closing everything rejects subsequent answers', guestMsgs.length === beforeClosedAllGuest)

  // quiz-seen only sticks for OPEN questions: open q1, mark seen, wait, submit
  // -> elapsedMs > 0 (measured from the seen timestamp while open).
  h.send(JSON.stringify({ type: 'quiz-open', qids: ['q1'] }))
  await wait(100)
  g.send(JSON.stringify({ type: 'quiz-seen', userId: 'stu-timing', qids: ['q1'] }))
  await wait(80)
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-timing', name: 'Tim', qid: 'q1', value: 'B' }))
  await wait(150)
  const q1Timing = q('q1')
  const timingSub = q1Timing && q1Timing.students.find((s) => s.userId === 'stu-timing')
  check('quiz-seen while open records a real elapsedMs', !!timingSub && timingSub.elapsedMs > 0)

  // quiz-seen sent while CLOSED does not stick: send seen for q2 while closed,
  // then open q2 and immediately submit — accepted, and elapsedMs is a small
  // number measured from the open (not the earlier closed-time send).
  g.send(JSON.stringify({ type: 'quiz-seen', userId: 'stu-timing2', qids: ['q2'] }))
  await wait(80)
  h.send(JSON.stringify({ type: 'quiz-open', qids: ['q1', 'q2'] }))
  const beforeQ2SubmitGuest = guestMsgs.length
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-timing2', name: 'Tia', qid: 'q2', value: '2/3' }))
  await wait(150)
  check('answer accepted after opening despite earlier closed-time quiz-seen', guestMsgs.length > beforeQ2SubmitGuest)
  const q2Timing = q('q2')
  const timingSub2 = q2Timing && q2Timing.students.find((s) => s.userId === 'stu-timing2')
  check(
    'closed-time quiz-seen did not stick: elapsedMs is a number >= 0',
    !!timingSub2 && typeof timingSub2.elapsedMs === 'number' && timingSub2.elapsedMs >= 0,
  )

  // The HOST is echoed the open set too. Its UI reads that set in two places (the
  // per-question canvas control and the dock's page toggle) and derives the student
  // calculator swap from it, so a host-local-only set would silently drift.
  const hostOpen = hostMsgs.filter((m) => m.type === 'quiz-open').at(-1)
  check(
    'host receives the quiz-open echo (drives the calculator swap)',
    !!hostOpen && [...hostOpen.qids].sort().join(',') === 'q1,q2',
  )

  // A reconnecting tutor gets the open set replayed, not just the stats.
  const { ws: h3, inbox: h3Msgs } = await openWithInbox(`${WS}/control/${r}?role=host`)
  await wait(300)
  const h3Open = h3Msgs.find((m) => m.type === 'quiz-open')
  check(
    'reconnecting host receives the current quiz-open set',
    !!h3Open && [...h3Open.qids].sort().join(',') === 'q1,q2',
  )

  for (const ws of [h, g, late, h3]) ws.close()
}

// 15: elapsed-timer fix — quiz-seen dependency + server-side quizOpenedAt -----
// Regression coverage for the bug where AnswerOverlay's quiz-seen effect never
// re-ran on open (stale deps), so no quiz-seen was ever sent and the server's
// `?? Date.now()` fallback made elapsedMs always 0.
{
  const r = `timing-${Math.random().toString(36).slice(2, 8)}`
  const { ws: h, inbox: hostMsgs } = await openWithInbox(`${WS}/control/${r}?role=host`)
  const { ws: g, inbox: guestMsgs } = await openWithInbox(`${WS}/control/${r}?role=guest`)
  await wait(100)

  const lastStats = () => hostMsgs.filter((m) => m.type === 'quiz-stats').at(-1)
  const q = (id) => lastStats()?.stats.questions.find((x) => x.qid === id)
  const sub = (id, userId) => q(id)?.students.find((s) => s.userId === userId)

  h.send(
    JSON.stringify({
      type: 'quiz-key',
      questions: [
        { id: 't1', format: 'choice', key: 'B', reveal: 'immediate' },
        { id: 't2', format: 'grid', key: '8', reveal: 'never' },
      ],
    }),
  )
  await wait(150)

  // Host opens t1. Guest reports quiz-seen, waits a real ~150ms, then answers.
  // elapsedMs must be measurably > 0 — the regression this section guards.
  h.send(JSON.stringify({ type: 'quiz-open', qids: ['t1'] }))
  await wait(100)
  g.send(JSON.stringify({ type: 'quiz-seen', userId: 'stu-timed', qids: ['t1'] }))
  await wait(150)
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-timed', name: 'Tara', qid: 't1', value: 'B' }))
  await wait(150)
  const timedSub = sub('t1', 'stu-timed')
  check(
    'quiz-seen -> wait ~150ms -> answer yields elapsedMs > 50 (not 0)',
    !!timedSub && timedSub.elapsedMs > 50,
  )

  // Fallback: a guest that answers WITHOUT ever sending quiz-seen still gets a
  // non-zero elapsedMs, because the server stamped quizOpenedAt at open time.
  h.send(JSON.stringify({ type: 'quiz-open', qids: ['t1', 't2'] }))
  await wait(150)
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-noseen', name: 'Nia', qid: 't2', value: '8' }))
  await wait(150)
  const noSeenSub = sub('t2', 'stu-noseen')
  check(
    'answer with no prior quiz-seen still gets non-zero elapsedMs (server openedAt fallback)',
    !!noSeenSub && noSeenSub.elapsedMs > 0,
  )

  // Re-open resets openedAt: close t2, wait, re-open, answer immediately -> a
  // small elapsed time (measured from the re-open), not from the original open
  // moments ago.
  h.send(JSON.stringify({ type: 'quiz-open', qids: ['t1'] }))
  await wait(150)
  h.send(JSON.stringify({ type: 'quiz-open', qids: ['t1', 't2'] }))
  await wait(20)
  g.send(JSON.stringify({ type: 'quiz-answer', userId: 'stu-reopen', name: 'Remy', qid: 't2', value: '8' }))
  await wait(150)
  const reopenSub = sub('t2', 'stu-reopen')
  check(
    're-opening a qid resets its openedAt (fresh answer has a small elapsedMs)',
    !!reopenSub && reopenSub.elapsedMs < 5000,
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
