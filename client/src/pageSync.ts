import type { Editor, TLPageId } from 'tldraw'
import type { ControlChannel } from './controlChannel'
import type { FollowController } from './cameraSync'

// Keeps every student on the same tldraw page as the tutor. The set of pages
// lives in the synced document (so everyone *has* them), but which page each
// person is *viewing* is per-user session state and does NOT sync — so we relay
// the tutor's current page over the control channel, exactly like the camera.
//  - Tutor (host): broadcasts its current page whenever it changes.
//  - Student (guest): snaps to whatever page the tutor sends. With free reign on,
//    following is released so the student can browse pages on their own; turning
//    it back off snaps them to the tutor's current page. If a target page hasn't
//    arrived over sync yet, it's remembered and applied as soon as it does.
export function setupPageSync(
  editor: Editor,
  channel: ControlChannel,
  isHost: boolean,
  initialFollow = true,
): FollowController {
  const cleanups: Array<() => void> = []

  if (!isHost) {
    // ---- Guest: follow the tutor's page (toggleable) ----
    let following = initialFollow
    let last: TLPageId | null = null // latest page the tutor announced
    let pending: TLPageId | null = null // wanted page not yet synced in

    const apply = (id: TLPageId) => {
      if (editor.getCurrentPageId() === id) {
        pending = null
        return
      }
      if (editor.getPage(id)) {
        editor.setCurrentPage(id)
        pending = null
      } else {
        pending = id // page not synced in yet — apply once it appears
      }
    }

    cleanups.push(
      channel.on('page', (m) => {
        if (typeof m.pageId !== 'string') return
        last = m.pageId as TLPageId
        if (following) apply(last)
      }),
    )
    // Catch a target page arriving via sync after we were told to switch to it.
    const unlisten = editor.store.listen(
      () => {
        if (following && pending && editor.getPage(pending)) apply(pending)
      },
      { scope: 'document', source: 'remote' },
    )
    cleanups.push(unlisten)

    // While following, a student can't wander to another page: snap any
    // self-initiated page change back to the tutor's page. (Free reign releases
    // this by flipping `following` off.)
    const unlistenNav = editor.store.listen(
      () => {
        if (!following || !last) return
        if (editor.getCurrentPageId() !== last && editor.getPage(last)) {
          editor.setCurrentPage(last)
        }
      },
      { scope: 'session', source: 'user' },
    )
    cleanups.push(unlistenNav)

    return {
      stop: () => cleanups.forEach((fn) => fn()),
      setFollow: (follow: boolean) => {
        if (follow === following) return
        following = follow
        if (follow && last) apply(last) // snap back to the tutor's page
        else if (!follow) pending = null // stop chasing while roaming
      },
    }
  }

  // ---- Host: broadcast page changes ----
  let last: TLPageId | null = null
  const broadcast = (force: boolean) => {
    const id = editor.getCurrentPageId()
    if (force || id !== last) {
      last = id
      channel.send({ type: 'page', pageId: id })
    }
  }
  const onTick = () => broadcast(false)
  editor.on('tick', onTick)
  cleanups.push(() => editor.off('tick', onTick))
  cleanups.push(channel.on('open', () => broadcast(true)))

  return { stop: () => cleanups.forEach((fn) => fn()), setFollow: () => {} }
}
