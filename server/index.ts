import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { nanoid } from 'nanoid'
import { getOrCreateRoom, getRoom, type ControlClient, type Room } from './rooms.ts'
import type { QuestionKey, QuizStats, Submission } from '../shared/quiz.ts'
import { gradeAnswer } from '../shared/grade.ts'
import { MAX_ANSWER_LEN, GUEST_MSG_RATE, MAX_SEEN_BATCH, MAX_OPEN_QIDS } from '../shared/quiz.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 5858
const clientDist = path.resolve(__dirname, '../client/dist')

const app = express()

// ---------------------------------------------------------------------------
// Assets: in-memory image store, scoped per room (for pasting a problem image).
// ---------------------------------------------------------------------------
app.post('/uploads/:roomId/:id', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const room = getOrCreateRoom(req.params.roomId)
  room.assets.set(req.params.id, {
    data: req.body as Buffer,
    contentType: req.header('content-type') || 'application/octet-stream',
  })
  res.json({ ok: true })
})

app.get('/uploads/:roomId/:id', (req, res) => {
  const blob = getRoom(req.params.roomId)?.assets.get(req.params.id)
  if (!blob) {
    res.status(404).end()
    return
  }
  res.setHeader('content-type', blob.contentType)
  res.setHeader('cache-control', 'public, max-age=31536000, immutable')
  res.end(blob.data)
})

// ---------------------------------------------------------------------------
// Static client + SPA fallback (production build only; in dev Vite serves it).
// ---------------------------------------------------------------------------
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/connect') ||
      req.path.startsWith('/control') ||
      req.path.startsWith('/uploads')
    ) {
      return next()
    }
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

// ---------------------------------------------------------------------------
// WebSockets: /connect/:roomId (tldraw sync) and /control/:roomId (camera relay)
// ---------------------------------------------------------------------------
const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)

  if (parts[0] === 'connect' && parts[1]) {
    const roomId = decodeURIComponent(parts[1])
    wss.handleUpgrade(req, socket, head, (ws) => handleSync(ws, roomId, url))
  } else if (parts[0] === 'control' && parts[1]) {
    const roomId = decodeURIComponent(parts[1])
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'guest'
    wss.handleUpgrade(req, socket, head, (ws) => handleControl(ws, roomId, role))
  } else {
    socket.destroy()
  }
})

function handleSync(ws: WebSocket, roomId: string, url: URL) {
  const room = getOrCreateRoom(roomId)
  const sessionId = url.searchParams.get('sessionId') || nanoid()
  // ws sockets satisfy tldraw's WebSocketMinimal shape at runtime.
  room.socketRoom.handleSocketConnect({ sessionId, socket: ws as never })
}

/** Builds the host-facing quiz stats snapshot, one QuestionStats per key, in key insertion order. */
function quizStats(room: Room): QuizStats {
  const questions = Array.from(room.quizKey.keys()).map((qid) => {
    const subsByUser = room.quizSubs.get(qid)
    const students: Submission[] = subsByUser ? Array.from(subsByUser.values()) : []
    const answered = students.length
    const firstCorrect = students.filter((s) => s.firstCorrect).length
    const latestCorrect = students.filter((s) => s.latestCorrect).length
    let medianMs: number | null = null
    if (students.length > 0) {
      const sorted = students.map((s) => s.elapsedMs).sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      medianMs =
        sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }
    return { qid, answered, firstCorrect, latestCorrect, medianMs, students }
  })
  return { questions, revealed: room.quizRevealed }
}

/** A userId/qid is a short, non-empty string. Guests are untrusted, so cap length. */
function validQuizId(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 64
}

/** Clamps a guest-supplied display name; falls back to a generic label. */
function clampQuizName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return 'Student'
  return raw.slice(0, 64)
}

/** Simple rolling-window rate limit: at most GUEST_MSG_RATE quiz messages/sec/socket. */
function allowQuizMessage(client: ControlClient): boolean {
  const now = Date.now()
  const rate = client.quizRate
  if (now - rate.windowStart >= 1000) {
    rate.windowStart = now
    rate.count = 0
  }
  rate.count++
  return rate.count <= GUEST_MSG_RATE
}

function handleControl(ws: WebSocket, roomId: string, role: 'host' | 'guest') {
  const room = getOrCreateRoom(roomId)
  const client: ControlClient = { socket: ws, role, quizRate: { windowStart: Date.now(), count: 0 } }
  room.controls.add(client)

  const broadcastToGuests = (payload: unknown) => {
    for (const c of room.controls) {
      if (c.role === 'guest') safeSend(c.socket, payload)
    }
  }
  // Calculator state goes to everyone except the sender, so a student's edits
  // (when editing is enabled) reach the tutor and other students without echo.
  const broadcastToOthers = (payload: unknown) => {
    for (const c of room.controls) {
      if (c.socket !== ws) safeSend(c.socket, payload)
    }
  }
  // Quiz stats (contains every student's answers) must never reach a guest.
  const sendToHosts = (payload: unknown) => {
    for (const c of room.controls) {
      if (c.role === 'host') safeSend(c.socket, payload)
    }
  }
  const pushQuizStats = () => sendToHosts({ type: 'quiz-stats', stats: quizStats(room) })

  // A student joining mid-session immediately snaps to the tutor's current
  // view, the open calculator + its state, and the current edit-access setting.
  if (role === 'guest') {
    safeSend(ws, { type: 'mode', mode: room.mode })
    for (const userId of room.writers) safeSend(ws, { type: 'access', userId, allow: true })
    if (room.lastCamera) safeSend(ws, { type: 'camera', camera: room.lastCamera })
    if (room.lastPage) safeSend(ws, { type: 'page', pageId: room.lastPage })
    safeSend(ws, { type: 'calc-access', allow: room.studentsCanEdit })
    safeSend(ws, { type: 'free-reign', on: room.freeReign })
    if (room.calcOpen) {
      safeSend(ws, { type: 'calc', action: 'open' })
      if (room.lastCalcState) safeSend(ws, { type: 'calc', action: 'state', state: room.lastCalcState })
      if (room.lastCalcGeom) safeSend(ws, { type: 'calc', action: 'geom', geom: room.lastCalcGeom })
    }
    if (room.timerVisible) {
      safeSend(ws, { type: 'timer', action: 'show' })
      if (room.lastTimerState) safeSend(ws, { type: 'timer', action: 'state', ...room.lastTimerState })
      if (room.lastTimerPos) safeSend(ws, { type: 'timer', action: 'geom', geom: room.lastTimerPos })
    }
    if (room.quizRevealed) {
      const keys: Record<string, string> = {}
      for (const [qid, key] of room.quizKey) keys[qid] = key.key
      safeSend(ws, { type: 'quiz-revealed', keys })
    }
    safeSend(ws, { type: 'quiz-open', qids: [...room.quizOpen] })
  } else {
    // A tutor reconnecting mid-class shouldn't lose the stats panel, nor forget
    // which questions they had opened (that set also drives the calculator swap).
    safeSend(ws, { type: 'quiz-stats', stats: quizStats(room) })
    safeSend(ws, { type: 'quiz-open', qids: [...room.quizOpen] })
  }

  ws.on('message', (data) => {
    let msg: {
      type?: string
      action?: string
      camera?: unknown
      state?: unknown
      geom?: unknown
      allow?: boolean
      on?: boolean
      pageId?: string
      mode?: string
      userId?: string
      remainingMs?: number
      sentAt?: number
      running?: boolean
      questions?: unknown
      qid?: string
      qids?: unknown
      value?: string
      name?: string
    }
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }

    if (role === 'host') {
      if (msg?.type === 'camera' && msg.camera) {
        room.lastCamera = msg.camera
        broadcastToGuests({ type: 'camera', camera: msg.camera })
      } else if (msg?.type === 'page' && typeof msg.pageId === 'string') {
        room.lastPage = msg.pageId
        broadcastToGuests({ type: 'page', pageId: msg.pageId })
      } else if (msg?.type === 'mode' && (msg.mode === 'small' || msg.mode === 'large')) {
        room.mode = msg.mode
        // Leaving large mode clears any grants so nothing lingers.
        if (msg.mode === 'small') room.writers.clear()
        broadcastToGuests({ type: 'mode', mode: room.mode })
      } else if (msg?.type === 'access' && typeof msg.userId === 'string') {
        // Tutor grants/revokes a single student's board write access (large mode).
        if (msg.allow) room.writers.add(msg.userId)
        else room.writers.delete(msg.userId)
        broadcastToGuests({ type: 'access', userId: msg.userId, allow: !!msg.allow })
      } else if (msg?.type === 'free-reign') {
        room.freeReign = !!msg.on
        broadcastToGuests({ type: 'free-reign', on: room.freeReign })
      } else if (msg?.type === 'calc') {
        if (msg.action === 'open') {
          room.calcOpen = true
          broadcastToGuests(msg)
        } else if (msg.action === 'close') {
          room.calcOpen = false
          broadcastToGuests(msg)
        } else if (msg.action === 'state') {
          room.lastCalcState = msg.state
          broadcastToOthers(msg)
        } else if (msg.action === 'geom' && msg.geom) {
          // Tutor moved/resized the shared calculator; mirror it to students.
          room.lastCalcGeom = msg.geom
          broadcastToGuests({ type: 'calc', action: 'geom', geom: msg.geom })
        }
      } else if (msg?.type === 'calc-access') {
        // Tutor flips whether all students may edit the shared calculator.
        room.studentsCanEdit = !!msg.allow
        broadcastToGuests({ type: 'calc-access', allow: room.studentsCanEdit })
      } else if (msg?.type === 'timer') {
        if (msg.action === 'show') {
          room.timerVisible = true
          broadcastToGuests({ type: 'timer', action: 'show' })
        } else if (msg.action === 'hide') {
          room.timerVisible = false
          broadcastToGuests({ type: 'timer', action: 'hide' })
        } else if (msg.action === 'state' && typeof msg.remainingMs === 'number') {
          room.lastTimerState = { remainingMs: msg.remainingMs, sentAt: msg.sentAt as number, running: !!msg.running }
          broadcastToGuests({ type: 'timer', action: 'state', ...room.lastTimerState })
        } else if (msg.action === 'geom' && msg.geom) {
          room.lastTimerPos = msg.geom as { x: number; y: number }
          broadcastToGuests({ type: 'timer', action: 'geom', geom: room.lastTimerPos })
        }
      } else if (msg?.type === 'quiz-key' && Array.isArray(msg.questions)) {
        // Tutor (re-)uploaded the answer key for the current lesson. Rebuild the
        // key set, but only drop seen/submission state for qids that no longer
        // exist — surviving qids keep the class's work across a host refresh.
        const nextKey = new Map<string, QuestionKey>()
        for (const q of msg.questions as QuestionKey[]) {
          if (q && typeof q.id === 'string') nextKey.set(q.id, q)
        }
        room.quizKey = nextKey
        for (const qid of Array.from(room.quizSeen.keys())) {
          if (!nextKey.has(qid)) room.quizSeen.delete(qid)
        }
        for (const qid of Array.from(room.quizSubs.keys())) {
          if (!nextKey.has(qid)) room.quizSubs.delete(qid)
        }
        for (const qid of Array.from(room.quizOpen)) {
          if (!nextKey.has(qid)) room.quizOpen.delete(qid)
        }
        for (const qid of Array.from(room.quizOpenedAt.keys())) {
          if (!nextKey.has(qid)) room.quizOpenedAt.delete(qid)
        }
        pushQuizStats()
      } else if (msg?.type === 'quiz-reveal') {
        room.quizRevealed = true
        const keys: Record<string, string> = {}
        for (const [qid, key] of room.quizKey) keys[qid] = key.key
        broadcastToGuests({ type: 'quiz-revealed', keys })
        pushQuizStats()
      } else if (msg?.type === 'quiz-reset') {
        room.quizSeen.clear()
        room.quizSubs.clear()
        room.quizRevealed = false
        // A reset is a re-run: restamp openedAt for every qid still open, so a
        // fresh answer is timed from "now", not from the original open. Clients
        // also clear their local `seenRef` on quiz-reset, so they'll re-report
        // quiz-seen and this fallback baseline typically gets superseded anyway.
        const now = Date.now()
        for (const qid of room.quizOpen) room.quizOpenedAt.set(qid, now)
        // quiz-reset clears submissions so a question can be re-run; it does NOT
        // touch quizOpen — that would silently close questions the tutor still
        // has open.
        pushQuizStats()
        broadcastToGuests({ type: 'quiz-reset' })
      } else if (msg?.type === 'quiz-open' && Array.isArray(msg.qids)) {
        // Tutor gates which questions currently accept answers. Replace the set
        // wholesale, dropping unknown ids and capping the batch, then broadcast
        // the SERVER's filtered set (not the client's raw input) so everyone
        // — including the tutor's own other tabs — agrees on what's open.
        const nextOpen = new Set<string>()
        for (const qid of (msg.qids as unknown[]).slice(0, MAX_OPEN_QIDS)) {
          if (typeof qid === 'string' && room.quizKey.has(qid)) nextOpen.add(qid)
        }
        // Compute the closed->open transition BEFORE overwriting `quizOpen`. A
        // qid newly opened is a fresh run: stamp `quizOpenedAt` and drop any
        // stale `quizSeen` so timing restarts cleanly instead of measuring from
        // a previous run. A qid that stays open is left alone (don't restart an
        // in-progress timer just because the whole set was re-sent). A qid that
        // is no longer open has its `quizOpenedAt` cleared.
        const now = Date.now()
        for (const qid of nextOpen) {
          if (!room.quizOpen.has(qid)) {
            room.quizOpenedAt.set(qid, now)
            room.quizSeen.delete(qid)
          }
        }
        for (const qid of room.quizOpen) {
          if (!nextOpen.has(qid)) room.quizOpenedAt.delete(qid)
        }
        room.quizOpen = nextOpen
        // Echoed to hosts as well as guests. The tutor's UI reads the open set from
        // the wire in two places — the per-question control on the canvas and the
        // dock's whole-page toggle — and those must not drift apart. The server's
        // set is the single source of truth for both roles.
        const openMsg = { type: 'quiz-open', qids: [...room.quizOpen] }
        broadcastToGuests(openMsg)
        sendToHosts(openMsg)
      }
    } else if (
      msg?.type === 'calc' &&
      msg.action === 'state' &&
      room.studentsCanEdit
    ) {
      // Students' edits propagate only while editing is enabled.
      room.lastCalcState = msg.state
      broadcastToOthers(msg)
    } else if (msg?.type === 'quiz-seen') {
      if (!allowQuizMessage(client)) return
      const { userId, qids } = msg
      if (!validQuizId(userId) || !Array.isArray(qids)) return
      const now = Date.now()
      // One batched message per page render (see MAX_SEEN_BATCH): a page can hold
      // more questions than the per-second rate limit allows as separate messages.
      for (const qid of qids.slice(0, MAX_SEEN_BATCH)) {
        // Only record seenAt for OPEN questions: elapsed time should measure from
        // when the tutor opened the question, not from whenever the client happened
        // to render it (which for a gated question could be long before it opens).
        if (!validQuizId(qid) || !room.quizKey.has(qid) || !room.quizOpen.has(qid)) continue
        let seenMap = room.quizSeen.get(qid)
        if (!seenMap) {
          seenMap = new Map()
          room.quizSeen.set(qid, seenMap)
        }
        // Idempotent: only the first-ever "seen" for this (qid, userId) sticks.
        if (!seenMap.has(userId)) seenMap.set(userId, now)
      }
    } else if (msg?.type === 'quiz-answer') {
      if (!allowQuizMessage(client)) return
      const { qid, userId } = msg
      if (!validQuizId(qid) || !validQuizId(userId)) return
      const key = room.quizKey.get(qid)
      if (!key) return
      // A student must not be able to answer a question the tutor hasn't opened,
      // even by hand-crafting a websocket frame.
      if (!room.quizOpen.has(qid)) return
      if (typeof msg.value !== 'string' || msg.value.length > MAX_ANSWER_LEN) return
      const name = clampQuizName(msg.name)
      const correct = gradeAnswer(msg.value, key)
      // Baseline for elapsedMs, preferring the most trustworthy source available:
      // (1) the student's own reported seenAt is fairest — a late joiner is timed
      //     from when THEY saw the question, not from when the tutor opened it;
      // (2) if that client message was ever dropped or rate-limited, degrade to
      //     the server's own quizOpenedAt ("time since the tutor said go");
      // (3) only if neither exists (shouldn't happen once quiz-open sets it),
      //     fall back to now — rather than silently collapsing elapsed to zero.
      const seenAt = room.quizSeen.get(qid)?.get(userId) ?? room.quizOpenedAt.get(qid) ?? Date.now()

      let subsMap = room.quizSubs.get(qid)
      if (!subsMap) {
        subsMap = new Map()
        room.quizSubs.set(qid, subsMap)
      }
      const existing = subsMap.get(userId)
      if (!existing) {
        subsMap.set(userId, {
          userId,
          name,
          first: msg.value,
          firstCorrect: correct,
          latest: msg.value,
          latestCorrect: correct,
          elapsedMs: Math.max(0, Date.now() - seenAt),
        })
      } else {
        // Resubmission: only `latest`/`latestCorrect`/`name` move.
        existing.name = name
        existing.latest = msg.value
        existing.latestCorrect = correct
      }

      const ack: { type: 'quiz-ack'; qid: string; correct?: boolean } = { type: 'quiz-ack', qid }
      if (key.reveal === 'immediate' || room.quizRevealed) ack.correct = correct
      safeSend(ws, ack)
      pushQuizStats()
    }
  })

  ws.on('close', () => {
    room.controls.delete(client)
  })
  ws.on('error', () => {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  })
}

function safeSend(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

server.listen(PORT, () => {
  console.log(`Whiteboard server listening on http://localhost:${PORT}`)
})
