import type { Editor } from 'tldraw'

type Camera = { x: number; y: number; z: number }

function controlUrl(roomId: string, role: 'host' | 'guest') {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/control/${encodeURIComponent(roomId)}?role=${role}`
}

// Keeps every viewer's camera locked to the tutor's.
//  - Tutor (host): broadcasts its camera on every change over the control socket.
//  - Student (guest): camera is locked and snapped to whatever the tutor sends,
//    so the student literally cannot drift away from what the tutor is showing.
export function setupCameraSync(editor: Editor, roomId: string, isHost: boolean): () => void {
  const role: 'host' | 'guest' = isHost ? 'host' : 'guest'
  let socket: WebSocket | null = null
  let disposed = false
  let onSocketOpen: (() => void) | null = null
  const cleanups: Array<() => void> = []

  // ---- Guest: lock the camera and follow the tutor ----
  function applyGuestCamera(cam: Camera) {
    // setCamera is ignored while the camera is locked, so unlock for the set.
    const opts = editor.getCameraOptions()
    editor.setCameraOptions({ ...opts, isLocked: false })
    editor.setCamera(cam, { immediate: true })
    editor.setCameraOptions({ ...opts, isLocked: true })
  }

  if (!isHost) {
    const opts = editor.getCameraOptions()
    editor.setCameraOptions({ ...opts, isLocked: true })
  }

  // ---- Host: broadcast camera changes ----
  if (isHost) {
    let last: Camera | null = null
    let lastSent = 0
    const broadcast = (force: boolean) => {
      const c = editor.getCamera()
      const changed = !last || last.x !== c.x || last.y !== c.y || last.z !== c.z
      const now = performance.now()
      if ((force || changed) && (force || now - lastSent >= 50)) {
        last = { x: c.x, y: c.y, z: c.z }
        lastSent = now
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'camera', camera: last }))
        }
      }
    }
    const onTick = () => broadcast(false)
    editor.on('tick', onTick)
    cleanups.push(() => editor.off('tick', onTick))
    // Push the current camera as soon as the (re)connected socket opens, so a
    // student who joins later immediately jumps to the tutor's current view.
    onSocketOpen = () => broadcast(true)
  }

  function connect() {
    if (disposed) return
    socket = new WebSocket(controlUrl(roomId, role))
    socket.onopen = () => onSocketOpen?.()
    socket.onmessage = (ev) => {
      if (isHost) return
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
        if (msg && msg.type === 'camera' && msg.camera) applyGuestCamera(msg.camera)
      } catch {
        /* ignore malformed frames */
      }
    }
    socket.onclose = () => {
      socket = null
      if (!disposed) setTimeout(connect, 1000) // resilient auto-reconnect
    }
    socket.onerror = () => socket?.close()
  }

  connect()

  return () => {
    disposed = true
    socket?.close()
    cleanups.forEach((fn) => fn())
  }
}
