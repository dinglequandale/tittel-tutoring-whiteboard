import { useEffect, useMemo, useRef, useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { useSync } from '@tldraw/sync'
import { nanoid } from 'nanoid'
import { makeAssetStore } from './assetStore'
import { setupCameraSync } from './cameraSync'
import { setupRightClickPan } from './rightClickPan'
import { ControlChannel } from './controlChannel'
import { Calculator, type Student } from './Calculator'

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

// A friendly per-tab student name so the tutor can tell students apart in the
// roster — it also labels the student's live cursor on the board.
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
  // Host: roster of connected students with their calculator-edit permission.
  const [students, setStudents] = useState<Student[]>([])
  // Guest: whether the tutor has granted this student calculator edit access.
  const [calcCanEdit, setCalcCanEdit] = useState(false)
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

  // Tutor: keep the live student roster (names + edit permission) up to date.
  useEffect(() => {
    if (!channel || !isHost) return
    return channel.on('roster', (m) => setStudents(m.students ?? []))
  }, [channel, isHost])

  // Student: react to the tutor opening/closing the calculator, track its state,
  // follow permission changes, and announce identity on every (re)connect.
  useEffect(() => {
    if (!channel || isHost) return
    const offs = [
      channel.on('calc', (m) => {
        if (m.action === 'open') setCalcOpen(true)
        else if (m.action === 'close') setCalcOpen(false)
        else if (m.action === 'state') lastCalcState.current = m.state
      }),
      channel.on('calc-permission', (m) => setCalcCanEdit(!!m.canEdit)),
      channel.on('open', () => channel.send({ type: 'hello', userId, name: studentName })),
    ]
    // Also announce immediately in case the socket is already open.
    channel.send({ type: 'hello', userId, name: studentName })
    return () => offs.forEach((off) => off())
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
          canEdit={calcCanEdit}
          students={students}
          onToggleGrant={(studentId, next) =>
            channel.send({ type: 'grant', studentId, canEdit: next })
          }
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
