import type { Editor } from 'tldraw'
import type { ControlChannel } from './controlChannel'

type Camera = { x: number; y: number; z: number }

/** A guest sync controller whose "follow the tutor" behavior can be toggled live. */
export interface FollowController {
  stop: () => void
  /** true = lock to the tutor (and snap to the latest); false = roam freely. */
  setFollow: (follow: boolean) => void
}

// Keeps every viewer's camera locked to the tutor's, over the shared control
// channel.
//  - Tutor (host): broadcasts its camera on every change.
//  - Student (guest): camera is locked and snapped to whatever the tutor sends.
//    When free reign is on the lock is released so the student can roam; turning
//    it back off re-locks and snaps to the tutor's latest camera.
export function setupCameraSync(
  editor: Editor,
  channel: ControlChannel,
  isHost: boolean,
  initialFollow = true,
): FollowController {
  const cleanups: Array<() => void> = []

  if (!isHost) {
    // ---- Guest: follow the tutor (toggleable) ----
    let following = initialFollow
    let last: Camera | null = null

    const setLocked = (locked: boolean) => {
      const opts = editor.getCameraOptions()
      editor.setCameraOptions({ ...opts, isLocked: locked })
    }
    const apply = (cam: Camera) => {
      setLocked(false)
      editor.setCamera(cam, { immediate: true })
      setLocked(true)
    }

    setLocked(following)
    // Always track the tutor's latest camera; only apply it while following.
    cleanups.push(
      channel.on('camera', (m) => {
        if (!m.camera) return
        last = m.camera
        if (following) apply(m.camera)
      }),
    )

    return {
      stop: () => cleanups.forEach((fn) => fn()),
      setFollow: (follow: boolean) => {
        if (follow === following) return
        following = follow
        if (follow) {
          if (last) apply(last) // snap back to the tutor's view
          else setLocked(true)
        } else {
          setLocked(false) // release for free roaming
        }
      },
    }
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

  // The host never "follows", so setFollow is a no-op for it.
  return { stop: () => cleanups.forEach((fn) => fn()), setFollow: () => {} }
}
