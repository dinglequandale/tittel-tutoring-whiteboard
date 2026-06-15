import { useEffect, useMemo, useRef, useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { useSync } from '@tldraw/sync'
import { nanoid } from 'nanoid'
import { makeAssetStore } from './assetStore'
import { setupCameraSync } from './cameraSync'
import { setupRightClickPan } from './rightClickPan'
import { ControlChannel } from './controlChannel'
import { Calculator } from './Calculator'

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

  const [editor, setEditor] = useState<Editor | null>(null)
  const [channel, setChannel] = useState<ControlChannel | null>(null)
  const [calcOpen, setCalcOpen] = useState(false)
  // Latest calculator state seen on the wire, handed to a freshly opened guest panel.
  const lastCalcState = useRef<unknown>(null)

  // One shared control channel (camera + calculator) for the lifetime of the board.
  useEffect(() => {
    const ch = new ControlChannel(roomId, isHost)
    setChannel(ch)
    return () => {
      ch.dispose()
      setChannel(null)
    }
  }, [roomId, isHost])

  // Camera follow + right-click pan once both the editor and channel exist.
  useEffect(() => {
    if (!editor || !channel) return
    const stopCamera = setupCameraSync(editor, channel, isHost)
    const stopPan = isHost ? setupRightClickPan(editor) : undefined
    return () => {
      stopCamera()
      stopPan?.()
    }
  }, [editor, channel, isHost])

  // Students react to the tutor opening/closing the calculator and track its state.
  useEffect(() => {
    if (!channel || isHost) return
    return channel.on('calc', (m) => {
      if (m.action === 'open') setCalcOpen(true)
      else if (m.action === 'close') setCalcOpen(false)
      else if (m.action === 'state') lastCalcState.current = m.state
    })
  }, [channel, isHost])

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

  return (
    <div className="board-root">
      <Tldraw
        store={store.store}
        onMount={setEditor}
        licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
      />
      {isHost && <ShareBar roomId={roomId} />}
      {isHost && (
        <button
          className="calc-toggle"
          onClick={() => setCalcOpen((v) => !v)}
          title="Live Desmos calculator — your students see everything you do"
        >
          {calcOpen ? 'Hide calculator' : '🧮 Calculator'}
        </button>
      )}
      {calcOpen && channel && (
        <Calculator
          channel={channel}
          isHost={isHost}
          initialState={lastCalcState.current}
          onClose={() => setCalcOpen(false)}
        />
      )}
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
