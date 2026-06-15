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
  // Calculator state goes to everyone except the sender (so a granted student's
  // edits reach the tutor and the other students, without echoing back).
  const broadcastToOthers = (payload: unknown) => {
    for (const c of room.controls) {
      if (c.socket !== ws) safeSend(c.socket, payload)
    }
  }
  const sendRosterToHosts = () => {
    const byId = new Map<string, { id: string; name: string; canEdit: boolean }>()
    for (const c of room.controls) {
      if (c.role === 'guest' && c.id) {
        byId.set(c.id, { id: c.id, name: c.name || 'Student', canEdit: room.calcEditors.has(c.id) })
      }
    }
    const students = [...byId.values()]
    for (const c of room.controls) {
      if (c.role === 'host') safeSend(c.socket, { type: 'roster', students })
    }
  }

  // A student joining mid-session immediately snaps to the tutor's current
  // view — and into an already-open calculator with its current state.
  if (role === 'guest') {
    if (room.lastCamera) safeSend(ws, { type: 'camera', camera: room.lastCamera })
    if (room.calcOpen) {
      safeSend(ws, { type: 'calc', action: 'open' })
      if (room.lastCalcState) safeSend(ws, { type: 'calc', action: 'state', state: room.lastCalcState })
    }
  } else {
    // The tutor gets the current student roster on connect.
    sendRosterToHosts()
  }

  ws.on('message', (data) => {
    let msg: {
      type?: string
      action?: string
      camera?: unknown
      state?: unknown
      userId?: string
      name?: string
      studentId?: string
      canEdit?: boolean
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
        }
      } else if (msg?.type === 'grant' && msg.studentId) {
        // Tutor grants/revokes a specific student's calculator edit access.
        if (msg.canEdit) room.calcEditors.add(msg.studentId)
        else room.calcEditors.delete(msg.studentId)
        for (const c of room.controls) {
          if (c.role === 'guest' && c.id === msg.studentId) {
            safeSend(c.socket, { type: 'calc-permission', canEdit: !!msg.canEdit })
          }
        }
        sendRosterToHosts()
      }
    } else {
      // Guest messages.
      if (msg?.type === 'hello' && msg.userId) {
        client.id = msg.userId
        client.name = msg.name
        // Re-grant on reconnect if this student still holds permission.
        if (room.calcEditors.has(msg.userId)) {
          safeSend(ws, { type: 'calc-permission', canEdit: true })
        }
        sendRosterToHosts()
      } else if (
        msg?.type === 'calc' &&
        msg.action === 'state' &&
        client.id &&
        room.calcEditors.has(client.id)
      ) {
        // A granted student's edits propagate to the tutor and other students.
        room.lastCalcState = msg.state
        broadcastToOthers(msg)
      }
    }
  })

  ws.on('close', () => {
    room.controls.delete(client)
    if (role === 'guest') sendRosterToHosts()
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
