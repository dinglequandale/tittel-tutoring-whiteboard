import type { Editor } from 'tldraw'
import type { ControlChannel } from './controlChannel'

type Camera = { x: number; y: number; z: number }

// Keeps every viewer's camera locked to the tutor's, over the shared control
// channel.
//  - Tutor (host): broadcasts its camera on every change.
//  - Student (guest): camera is locked and snapped to whatever the tutor sends,
//    so the student literally cannot drift away from what the tutor is showing.
export function setupCameraSync(editor: Editor, channel: ControlChannel, isHost: boolean): () => void {
  const cleanups: Array<() => void> = []

  if (!isHost) {
    // ---- Guest: lock the camera and follow the tutor ----
    const lock = () => {
      const opts = editor.getCameraOptions()
      editor.setCameraOptions({ ...opts, isLocked: true })
    }
    const apply = (cam: Camera) => {
      // setCamera is ignored while the camera is locked, so unlock for the set.
      const opts = editor.getCameraOptions()
      editor.setCameraOptions({ ...opts, isLocked: false })
      editor.setCamera(cam, { immediate: true })
      editor.setCameraOptions({ ...opts, isLocked: true })
    }
    lock()
    cleanups.push(channel.on('camera', (m) => m.camera && apply(m.camera)))
  } else {
    // ---- Host: broadcast camera changes (throttled) ----
    let last: Camera | null = null
    let lastSent = 0
    const broadcast = (force: boolean) => {
      const c = editor.getCamera()
      const changed = !last || last.x !== c.x || last.y !== c.y || last.z !== c.z
      const now = performance.now()
      if ((force || changed) && (force || now - lastSent >= 50)) {
        last = { x: c.x, y: c.y, z: c.z }
        lastSent = now
        channel.send({ type: 'camera', camera: last })
      }
    }
    const onTick = () => broadcast(false)
    editor.on('tick', onTick)
    cleanups.push(() => editor.off('tick', onTick))
    // Re-push the current camera whenever the socket (re)connects, so a student
    // who joins later immediately jumps to the tutor's current view.
    cleanups.push(channel.on('open', () => broadcast(true)))
  }

  return () => cleanups.forEach((fn) => fn())
}
