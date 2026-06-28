import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { nanoid } from 'nanoid'
import { getOrCreateRoom, getRoom, type ControlClient } from './rooms.ts'

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

function handleControl(ws: WebSocket, roomId: string, role: 'host' | 'guest') {
  const room = getOrCreateRoom(roomId)
  const client: ControlClient = { socket: ws, role }
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
      }
    } else if (
      msg?.type === 'calc' &&
      msg.action === 'state' &&
      room.studentsCanEdit
    ) {
      // Students' edits propagate only while editing is enabled.
      room.lastCalcState = msg.state
      broadcastToOthers(msg)
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
