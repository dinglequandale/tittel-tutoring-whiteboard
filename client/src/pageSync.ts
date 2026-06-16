import type { Editor, TLPageId } from 'tldraw'
import type { ControlChannel } from './controlChannel'

// Keeps every student on the same tldraw page as the tutor. The set of pages
// lives in the synced document (so everyone *has* them), but which page each
// person is *viewing* is per-user session state and does NOT sync — so we relay
// the tutor's current page over the control channel, exactly like the camera.
//  - Tutor (host): broadcasts its current page whenever it changes.
//  - Student (guest): snaps to whatever page the tutor sends. If that page
//    hasn't arrived over sync yet, it's remembered and applied as soon as it does.
export function setupPageSync(editor: Editor, channel: ControlChannel, isHost: boolean): () => void {
  const cleanups: Array<() => void> = []

  if (!isHost) {
    // ---- Guest: follow the tutor's page ----
    let pending: TLPageId | null = null

    const apply = (id: TLPageId) => {
      if (editor.getCurrentPageId() === id) return
      if (editor.getPage(id)) {
        editor.setCurrentPage(id)
        pending = null
      } else {
        // Page not synced in yet — apply once it appears.
        pending = id
      }
    }

    cleanups.push(
      channel.on('page', (m) => {
        if (typeof m.pageId === 'string') apply(m.pageId as TLPageId)
      }),
    )
    // Catch the page arriving via sync after we were told to switch to it.
    const unlisten = editor.store.listen(
      () => {
        if (pending && editor.getPage(pending)) apply(pending)
      },
      { scope: 'document', source: 'remote' },
    )
    cleanups.push(unlisten)
  } else {
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
    // Re-push current page when the socket (re)connects, so late joiners land right.
    cleanups.push(channel.on('open', () => broadcast(true)))
  }

  return () => cleanups.forEach((fn) => fn())
}
