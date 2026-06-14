import { useMemo, useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { useSync } from '@tldraw/sync'
import { nanoid } from 'nanoid'
import { makeAssetStore } from './assetStore'
import { setupCameraSync } from './cameraSync'
import { setupRightClickPan } from './rightClickPan'

function connectUrl(roomId: string) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/connect/${encodeURIComponent(roomId)}`
}

// A stable per-tab id so each participant shows up as one collaborator/cursor.
const userId = (() => {
  const key = 'whiteboard-user-id'
  let v = sessionStorage.getItem(key)
  if (!v) {
    v = nanoid()
    sessionStorage.setItem(key, v)
  }
  return v
})()

export function Board({ roomId, isHost }: { roomId: string; isHost: boolean }) {
  const assets = useMemo(() => makeAssetStore(roomId), [roomId])
  const store = useSync({
    uri: connectUrl(roomId),
    assets,
    userInfo: {
      id: userId,
      name: isHost ? 'Tutor' : 'Student',
      color: isHost ? '#2563eb' : '#16a34a',
    },
  })

  if (store.status === 'loading') {
    return <div className="board-status">Connecting to the board…</div>
  }
  if (store.status === 'error') {
    return (
      <div className="board-status">
        <div>Couldn&rsquo;t connect to the board.</div>
        <div style={{ fontSize: '0.85rem' }}>{store.error.message}</div>
      </div>
    )
  }

  const handleMount = (editor: Editor) => {
    const stopCamera = setupCameraSync(editor, roomId, isHost)
    const stopPan = isHost ? setupRightClickPan(editor) : () => {}
    return () => {
      stopCamera()
      stopPan()
    }
  }

  return (
    <div className="board-root">
      <Tldraw
        store={store.store}
        onMount={handleMount}
        licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
      />
      {isHost && <ShareBar roomId={roomId} />}
    </div>
  )
}

function ShareBar({ roomId }: { roomId: string }) {
  const link = `${window.location.origin}/b/${roomId}`
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="share-bar">
      <span className="role">Tutor</span>
      <span className="link">{link}</span>
      <button onClick={copy}>{copied ? 'Copied!' : 'Copy link'}</button>
    </div>
  )
}

