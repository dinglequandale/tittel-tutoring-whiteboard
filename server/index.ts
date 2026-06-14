import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer, WebSocket } from 'ws'
import { nanoid } from 'nanoid'
import { getOrCreateRoom, getRoom } from './rooms.ts'

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
  const client = { socket: ws, role }
  room.controls.add(client)

  // A student joining mid-session immediately snaps to the tutor's current view.
  if (role === 'guest' && room.lastCamera) {
    safeSend(ws, { type: 'camera', camera: room.lastCamera })
  }

  ws.on('message', (data) => {
    if (role !== 'host') return // only the tutor drives the camera
    let msg: { type?: string; camera?: unknown }
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (msg?.type === 'camera' && msg.camera) {
      room.lastCamera = msg.camera
      for (const c of room.controls) {
        if (c.role === 'guest') safeSend(c.socket, { type: 'camera', camera: msg.camera })
      }
    }
  })

  ws.on('close', () => room.controls.delete(client))
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
