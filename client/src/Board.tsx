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

// A friendly per-tab name so students' cursors are easy to tell apart.
const ANIMALS = [
  'Fox', 'Owl', 'Bee', 'Otter', 'Hawk', 'Lynx', 'Wolf', 'Crane', 'Newt', 'Toad',
  'Mole', 'Wren', 'Seal', 'Ibis', 'Lark', 'Puma', 'Stag', 'Vole', 'Finch', 'Heron',
]
const studentName = (() => {
  const key = 'whiteboard-name'
  let v = sessionStorage.getItem(key)
  if (!v) {
    v = `${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]} ${Math.floor(10 + Math.random() * 90)}`
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
      name: isHost ? 'Tutor' : studentName,
      color: isHost ? '#2563eb' : '#16a34a',
    },
  })

  const [editor, setEditor] = useState<Editor | null>(null)
  const [channel, setChannel] = useState<ControlChannel | null>(null)
  const [calcOpen, setCalcOpen] = useState(false)
  // Whether students may edit the shared calculator (host toggles; guests follow).
  const [studentsCanEdit, setStudentsCanEdit] = useState(false)
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

  // Students follow the tutor opening/closing the calculator, track its state,
  // and follow the edit-access setting.
  useEffect(() => {
    if (!channel || isHost) return
    return channel.on('calc', (m) => {
      if (m.action === 'open') setCalcOpen(true)
      else if (m.action === 'close') setCalcOpen(false)
      else if (m.action === 'state') lastCalcState.current = m.state
    })
  }, [channel, isHost])

  useEffect(() => {
    if (!channel || isHost) return
    return channel.on('calc-access', (m) => setStudentsCanEdit(!!m.allow))
  }, [channel, isHost])

  function toggleAccess(allow: boolean) {
    setStudentsCanEdit(allow)
    channel?.send({ type: 'calc-access', allow })
  }

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

      {isHost && (
        <div className="tutor-dock">
          <ShareControl roomId={roomId} />
          <button className="dock-btn" onClick={() => setCalcOpen((v) => !v)}>
            {calcOpen ? 'Hide calculator' : '🧮 Calculator'}
          </button>
        </div>
      )}

      {calcOpen && channel && (
        <Calculator
          channel={channel}
          isHost={isHost}
          initialState={lastCalcState.current}
          canEdit={!isHost && studentsCanEdit}
          studentsCanEdit={studentsCanEdit}
          onToggleAccess={toggleAccess}
        />
      )}
    </div>
  )
}

// Compact share control: shows the link with a Copy button, then collapses to a
// small chip once copied so it stays out of the way. Click the chip to reopen.
function ShareControl({ roomId }: { roomId: string }) {
  const link = `${window.location.origin}/b/${roomId}`
  const [expanded, setExpanded] = useState(true)
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      setExpanded(false)
    } catch {
      /* clipboard blocked — leave expanded so they can copy manually */
    }
  }

  if (!expanded) {
    return (
      <button className="dock-btn" onClick={() => setExpanded(true)} title={link}>
        🔗 Link
      </button>
    )
  }

  return (
    <div className="share-control">
      <span className="share-link">{link}</span>
      <button className="dock-btn primary" onClick={copy}>
        {copied ? 'Copied!' : 'Copy link'}
      </button>
    </div>
  )
}
