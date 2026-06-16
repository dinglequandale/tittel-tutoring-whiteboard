import { useEffect, useMemo, useRef, useState } from 'react'
import { Tldraw, useValue, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { useSync } from '@tldraw/sync'
import { nanoid } from 'nanoid'
import { makeAssetStore } from './assetStore'
import { setupCameraSync } from './cameraSync'
import { setupPageSync } from './pageSync'
import { setupRightClickPan } from './rightClickPan'
import { ControlChannel } from './controlChannel'
import { Calculator } from './Calculator'
import { loadLesson } from './lesson/load'

type ClassMode = 'small' | 'large'

function connectUrl(roomId: string) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/connect/${encodeURIComponent(roomId)}`
}

// A stable per-tab id so each participant shows up as one collaborator/cursor,
// and so write-access grants can target a specific student.
const userId = (() => {
  const key = 'whiteboard-user-id'
  let v = sessionStorage.getItem(key)
  if (!v) {
    v = nanoid()
    sessionStorage.setItem(key, v)
  }
  return v
})()

// A friendly per-tab name so students' cursors are easy to tell apart in small
// classes (large classes prompt for a real name instead — see the name gate).
const ANIMALS = [
  'Fox', 'Owl', 'Bee', 'Otter', 'Hawk', 'Lynx', 'Wolf', 'Crane', 'Newt', 'Toad',
  'Mole', 'Wren', 'Seal', 'Ibis', 'Lark', 'Puma', 'Stag', 'Vole', 'Finch', 'Heron',
]
const animalName = (() => {
  const key = 'whiteboard-animal'
  let v = sessionStorage.getItem(key)
  if (!v) {
    v = `${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]} ${Math.floor(10 + Math.random() * 90)}`
    sessionStorage.setItem(key, v)
  }
  return v
})()

const NAME_KEY = 'whiteboard-name'

// ---------------------------------------------------------------------------
// Board gate: owns the control channel, resolves the class mode (host knows it
// from its URL; a student learns it from the server), and — in a large class —
// makes a student name themselves before the canvas mounts.
// ---------------------------------------------------------------------------
export function Board({
  roomId,
  isHost,
  hostMode,
}: {
  roomId: string
  isHost: boolean
  hostMode: ClassMode
}) {
  const [channel, setChannel] = useState<ControlChannel | null>(null)
  // Host knows its mode immediately; a guest waits for the server to tell it.
  const [mode, setMode] = useState<ClassMode | null>(isHost ? hostMode : null)
  const [name, setName] = useState<string | null>(() => sessionStorage.getItem(NAME_KEY))

  // One shared control channel for the lifetime of the board.
  useEffect(() => {
    const ch = new ControlChannel(roomId, isHost)
    setChannel(ch)
    return () => {
      ch.dispose()
      setChannel(null)
    }
  }, [roomId, isHost])

  // Host announces its class mode to the server on every (re)connect.
  useEffect(() => {
    if (!channel || !isHost) return
    const announce = () => channel.send({ type: 'mode', mode: hostMode })
    announce()
    return channel.on('open', announce)
  }, [channel, isHost, hostMode])

  // Guest learns (and follows live changes to) the class mode.
  useEffect(() => {
    if (!channel || isHost) return
    return channel.on('mode', (m) => {
      if (m.mode === 'small' || m.mode === 'large') setMode(m.mode)
    })
  }, [channel, isHost])

  if (!channel || mode === null) {
    return <div className="board-status">Connecting to the board…</div>
  }

  // Large-class students name themselves so the tutor can identify them.
  if (!isHost && mode === 'large' && !name) {
    return (
      <NameGate
        onSubmit={(n) => {
          sessionStorage.setItem(NAME_KEY, n)
          setName(n)
        }}
      />
    )
  }

  const displayName = isHost ? 'Tutor' : mode === 'large' ? name! : animalName

  return (
    <BoardCanvas
      roomId={roomId}
      isHost={isHost}
      mode={mode}
      channel={channel}
      displayName={displayName}
    />
  )
}

function NameGate({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [value, setValue] = useState('')
  const trimmed = value.trim()
  return (
    <div className="name-gate">
      <form
        className="name-gate-card"
        onSubmit={(e) => {
          e.preventDefault()
          if (trimmed) onSubmit(trimmed)
        }}
      >
        <h2>Join the class</h2>
        <p>Enter your name so your tutor can see who&rsquo;s here.</p>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Your name"
          maxLength={40}
        />
        <button type="submit" className="start-btn" disabled={!trimmed}>
          Enter the board
        </button>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The actual synced canvas, mounted only once mode + name are settled.
// ---------------------------------------------------------------------------
function BoardCanvas({
  roomId,
  isHost,
  mode,
  channel,
  displayName,
}: {
  roomId: string
  isHost: boolean
  mode: ClassMode
  channel: ControlChannel
  displayName: string
}) {
  const assets = useMemo(() => makeAssetStore(roomId), [roomId])
  const store = useSync({
    uri: connectUrl(roomId),
    assets,
    userInfo: {
      id: userId,
      name: displayName,
      color: isHost ? '#2563eb' : '#16a34a',
    },
  })

  const [editor, setEditor] = useState<Editor | null>(null)
  const [calcOpen, setCalcOpen] = useState(false)
  // Whether students may edit the shared calculator (host toggles; guests follow).
  const [studentsCanEdit, setStudentsCanEdit] = useState(false)
  // Latest calculator state seen on the wire, handed to a freshly opened guest panel.
  const lastCalcState = useRef<unknown>(null)
  // Lesson upload (host only): file picker ref + a transient status message.
  const lessonInputRef = useRef<HTMLInputElement>(null)
  const [lessonStatus, setLessonStatus] = useState<string | null>(null)
  // Large-class write grants the tutor has handed out, keyed by student userId.
  const [granted, setGranted] = useState<Set<string>>(() => new Set())

  // Camera + page follow + right-click pan once both the editor and channel exist.
  useEffect(() => {
    if (!editor) return
    const stopCamera = setupCameraSync(editor, channel, isHost)
    const stopPage = setupPageSync(editor, channel, isHost)
    const stopPan = isHost ? setupRightClickPan(editor) : undefined
    return () => {
      stopCamera()
      stopPage()
      stopPan?.()
    }
  }, [editor, channel, isHost])

  // Large-class students start read-only and unlock only when the tutor grants
  // them write access (matched on their own userId). Trust-based, client-side.
  useEffect(() => {
    if (!editor || isHost || mode !== 'large') return
    editor.updateInstanceState({ isReadonly: true })
    const off = channel.on('access', (m) => {
      if (m.userId === userId) editor.updateInstanceState({ isReadonly: !m.allow })
    })
    return () => {
      off()
      editor.updateInstanceState({ isReadonly: false })
    }
  }, [editor, isHost, mode, channel])

  // Students follow the tutor opening/closing the calculator, track its state,
  // and follow the edit-access setting.
  useEffect(() => {
    if (isHost) return
    return channel.on('calc', (m) => {
      if (m.action === 'open') setCalcOpen(true)
      else if (m.action === 'close') setCalcOpen(false)
      else if (m.action === 'state') lastCalcState.current = m.state
    })
  }, [channel, isHost])

  useEffect(() => {
    if (isHost) return
    return channel.on('calc-access', (m) => setStudentsCanEdit(!!m.allow))
  }, [channel, isHost])

  function toggleAccess(allow: boolean) {
    setStudentsCanEdit(allow)
    channel.send({ type: 'calc-access', allow })
  }

  function toggleGrant(studentId: string, allow: boolean) {
    setGranted((prev) => {
      const next = new Set(prev)
      if (allow) next.add(studentId)
      else next.delete(studentId)
      return next
    })
    channel.send({ type: 'access', userId: studentId, allow })
  }

  async function onLessonFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file later
    if (!file || !editor) return
    try {
      setLessonStatus('Reading lesson…')
      const raw = JSON.parse(await file.text())
      const result = await loadLesson(editor, roomId, raw, (done, total) =>
        setLessonStatus(`Rendering ${done}/${total}…`),
      )
      setLessonStatus(`Loaded ${result.pages} page${result.pages === 1 ? '' : 's'}`)
      setTimeout(() => setLessonStatus(null), 2500)
    } catch (err) {
      setLessonStatus(`Couldn't load: ${err instanceof Error ? err.message : String(err)}`)
      setTimeout(() => setLessonStatus(null), 5000)
    }
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

      {isHost && mode === 'large' && editor && (
        <Roster editor={editor} granted={granted} onToggle={toggleGrant} />
      )}

      {isHost && (
        <div className="tutor-dock">
          {lessonStatus && <span className="lesson-status">{lessonStatus}</span>}
          <ShareControl roomId={roomId} />
          <input
            ref={lessonInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={onLessonFile}
          />
          <button className="dock-btn" onClick={() => lessonInputRef.current?.click()}>
            📄 Load lesson
          </button>
          <button className="dock-btn" onClick={() => setCalcOpen((v) => !v)}>
            {calcOpen ? 'Hide calculator' : '🧮 Calculator'}
          </button>
        </div>
      )}

      {calcOpen && (
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

// Top-right roster (large classes): who's on the board, with a per-student switch
// to grant/revoke write access. The participant list comes straight from tldraw's
// live presence, so no extra roster broadcast is needed.
function Roster({
  editor,
  granted,
  onToggle,
}: {
  editor: Editor
  granted: Set<string>
  onToggle: (studentId: string, allow: boolean) => void
}) {
  const collaborators = useValue('collaborators', () => editor.getCollaborators(), [editor])
  const students = collaborators.filter((c) => c.userId !== userId)

  return (
    <div className="roster-panel">
      <div className="roster-title">On the board · {students.length}</div>
      {students.length === 0 && <div className="roster-empty">No students yet</div>}
      {students.map((c) => {
        const canWrite = granted.has(c.userId)
        return (
          <div className="roster-row" key={c.userId}>
            <span className="roster-dot" style={{ background: c.color }} />
            <span className="roster-name">{c.userName || 'Student'}</span>
            <button
              type="button"
              role="switch"
              aria-checked={canWrite}
              title={canWrite ? 'Can write — click to lock' : 'Locked — click to let them write'}
              className={`calc-switch ${canWrite ? 'on' : ''}`}
              onClick={() => onToggle(c.userId, !canWrite)}
            >
              <span className="calc-switch-knob" />
            </button>
          </div>
        )
      })}
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
