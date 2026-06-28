import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Tldraw,
  DefaultMainMenu,
  DefaultMainMenuContent,
  DefaultMenuPanel,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  PeopleMenu,
  atom,
  useEditor,
  useValue,
  type Atom,
  type Editor,
  type TLComponents,
} from 'tldraw'
import 'tldraw/tldraw.css'
import { useSync } from '@tldraw/sync'
import { nanoid } from 'nanoid'
import { makeAssetStore } from './assetStore'
import { setupCameraSync, type FollowController } from './cameraSync'
import { setupPageSync } from './pageSync'
import { setupRightClickPan } from './rightClickPan'
import { ControlChannel } from './controlChannel'
import { Calculator } from './Calculator'
import { loadLesson } from './lesson/load'
import { exportBoardToPdf } from './exportPdf'

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
  const editorRef = useRef<Editor | null>(null)
  const [calcOpen, setCalcOpen] = useState(false)
  // Whether students may edit the shared calculator (host toggles; guests follow).
  const [studentsCanEdit, setStudentsCanEdit] = useState(false)
  // Latest calculator state seen on the wire, handed to a freshly opened guest panel.
  const lastCalcState = useRef<unknown>(null)
  // Latest calculator position/size seen on the wire, handed to a freshly opened guest panel.
  const lastCalcGeom = useRef<unknown>(null)
  // Lesson upload (host only): file picker ref + a transient status message.
  const lessonInputRef = useRef<HTMLInputElement>(null)
  const [lessonStatus, setLessonStatus] = useState<string | null>(null)
  // Whether the share link has been copied (then it lives in the main menu only).
  const [linkCopied, setLinkCopied] = useState(false)
  // Large-class write grants, keyed by student userId. An atom so the toggles
  // inside tldraw's people menu can read it reactively without remounting.
  const grantedAtom = useMemo(() => atom('granted-writers', new Set<string>()), [])
  // Free reign: host toggles it; guests follow. Off = locked to the tutor.
  const [freeReign, setFreeReign] = useState(false)
  const freeReignRef = useRef(freeReign)
  freeReignRef.current = freeReign
  // Guest's private scratch calculator (only while free reign is on).
  const [personalCalcOpen, setPersonalCalcOpen] = useState(false)
  // Live-toggleable follow controllers for camera + page.
  const cameraCtl = useRef<FollowController | null>(null)
  const pageCtl = useRef<FollowController | null>(null)
  // Whether this student may draw. Small classes: always. Large classes: only
  // after the tutor grants their userId. Drives the toolbar visibility + the
  // hand-tool backstop.
  const isLarge = mode === 'large'
  const [canWrite, setCanWrite] = useState(!isLarge)
  const canWriteRef = useRef(canWrite)
  canWriteRef.current = canWrite

  // Camera + page follow + right-click pan once both the editor and channel exist.
  // Initial follow respects the current free-reign state; later toggles are applied
  // live via the controllers (below) rather than tearing this down.
  useEffect(() => {
    if (!editor) return
    const follow = !freeReignRef.current
    const camera = setupCameraSync(editor, channel, isHost, follow)
    const page = setupPageSync(editor, channel, isHost, follow)
    cameraCtl.current = camera
    pageCtl.current = page
    const stopPan = isHost ? setupRightClickPan(editor) : undefined
    return () => {
      camera.stop()
      page.stop()
      stopPan?.()
      cameraCtl.current = null
      pageCtl.current = null
    }
  }, [editor, channel, isHost])

  // Apply free-reign changes to the follow controllers without re-creating them.
  useEffect(() => {
    cameraCtl.current?.setFollow(!freeReign)
    pageCtl.current?.setFollow(!freeReign)
  }, [freeReign])

  // Guest learns free-reign state (and live changes) from the tutor.
  useEffect(() => {
    if (isHost) return
    return channel.on('free-reign', (m) => setFreeReign(!!m.on))
  }, [channel, isHost])

  // While roaming, a guest gets a private calculator opened for them; closing
  // free reign tucks it away again.
  useEffect(() => {
    if (isHost) return
    setPersonalCalcOpen(freeReign)
  }, [freeReign, isHost])

  function toggleFreeReign(on: boolean) {
    setFreeReign(on)
    channel.send({ type: 'free-reign', on })
  }

  // Remind the tutor to export before they close the (ephemeral) board. Browsers
  // only allow the generic "changes you may not be saved" prompt — that nudge is
  // enough to send them back to the menu's Export.
  useEffect(() => {
    if (!isHost) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [isHost])

  // Large-class students can't draw until the tutor grants their userId.
  useEffect(() => {
    if (isHost || !isLarge) return
    return channel.on('access', (m) => {
      if (m.userId === userId) setCanWrite(!!m.allow)
    })
  }, [channel, isHost, isLarge])

  // The toolbar/page-menu are hidden for locked students (below), but tool
  // keyboard shortcuts could still switch them to a drawing tool — so we keep a
  // silent backstop that pins a locked student to the 'hand' tool. The
  // correction is deferred (setTimeout 0) so we never mutate the editor from
  // inside a store-listener callback, which corrupts tldraw's effect scheduler.
  useEffect(() => {
    if (!editor || isHost || !isLarge) return
    const pinIfLocked = () => {
      if (!canWriteRef.current && editor.getCurrentToolId() !== 'hand') editor.setCurrentTool('hand')
    }
    const defer = () => setTimeout(pinIfLocked, 0)
    defer() // lock on entry
    const unlisten = editor.store.listen(() => { if (!canWriteRef.current) defer() }, {
      scope: 'session',
      source: 'user',
    })
    return () => unlisten()
  }, [editor, isHost, isLarge])

  // On grant, hand the student a real (select) tool; on revoke, snap them back to
  // 'hand' immediately (otherwise they could still drag/select shapes even with
  // the toolbar hidden). Runs in an effect — a safe context, not a reactive flush.
  useEffect(() => {
    if (!editor || isHost || !isLarge) return
    editor.setCurrentTool(canWrite ? 'select' : 'hand')
  }, [canWrite, editor, isHost, isLarge])

  // Students follow the tutor opening/closing the calculator, track its state,
  // and follow the edit-access setting.
  useEffect(() => {
    if (isHost) return
    return channel.on('calc', (m) => {
      if (m.action === 'open') setCalcOpen(true)
      else if (m.action === 'close') setCalcOpen(false)
      else if (m.action === 'state') lastCalcState.current = m.state
      else if (m.action === 'geom') lastCalcGeom.current = m.geom
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

  // ---- Stable host actions (referenced by the custom tldraw UI components) ----
  const copyLink = useCallback(() => {
    navigator.clipboard?.writeText(`${window.location.origin}/b/${roomId}`).catch(() => {})
  }, [roomId])

  const openLessonPicker = useCallback(() => lessonInputRef.current?.click(), [])

  const exportPdf = useCallback(async () => {
    const ed = editorRef.current
    if (!ed) return
    try {
      setLessonStatus('Exporting PDF…')
      const n = await exportBoardToPdf(ed)
      setLessonStatus(`Exported ${n} page${n === 1 ? '' : 's'}`)
      setTimeout(() => setLessonStatus(null), 2500)
    } catch (err) {
      setLessonStatus(err instanceof Error ? err.message : String(err))
      setTimeout(() => setLessonStatus(null), 5000)
    }
  }, [])

  const toggleGrant = useCallback(
    (studentId: string, allow: boolean) => {
      grantedAtom.update((prev) => {
        const next = new Set(prev)
        if (allow) next.add(studentId)
        else next.delete(studentId)
        return next
      })
      channel.send({ type: 'access', userId: studentId, allow })
    },
    [channel, grantedAtom],
  )

  async function onLessonFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file later
    const ed = editorRef.current
    if (!file || !ed) return
    try {
      setLessonStatus('Reading lesson…')
      const raw = JSON.parse(await file.text())
      const result = await loadLesson(ed, roomId, raw, (done, total) =>
        setLessonStatus(`Rendering ${done}/${total}…`),
      )
      setLessonStatus(`Loaded ${result.pages} page${result.pages === 1 ? '' : 's'}`)
      setTimeout(() => setLessonStatus(null), 2500)
    } catch (err) {
      setLessonStatus(`Couldn't load: ${err instanceof Error ? err.message : String(err)}`)
      setTimeout(() => setLessonStatus(null), 5000)
    }
  }

  // ---- Custom tldraw UI pieces (stable identities so popovers don't remount) --
  // Host main menu: default items plus Copy link + Export PDF.
  const HostMainMenu = useMemo(
    () =>
      function HostMainMenu() {
        return (
          <DefaultMainMenu>
            <TldrawUiMenuGroup id="tittel">
              <TldrawUiMenuItem id="copy-student-link" label="Copy student link" readonlyOk onSelect={copyLink} />
              <TldrawUiMenuItem id="export-pdf" label="Export PDF (all pages)" readonlyOk onSelect={exportPdf} />
            </TldrawUiMenuGroup>
            <DefaultMainMenuContent />
          </DefaultMainMenu>
        )
      },
    [copyLink, exportPdf],
  )

  // Load lesson lives in the top-left, just right of the menu/page buttons. We
  // wrap the default menu panel because that top-left slot stacks vertically and
  // is pointer-events:none — so we add the button into a horizontal row beside it
  // and opt it back into pointer events (see .tittel-menu-row in styles.css).
  const HostMenuPanel = useMemo(
    () =>
      function HostMenuPanel() {
        return (
          <div className="tittel-menu-row">
            <DefaultMenuPanel />
            <button className="dock-btn tittel-load-lesson" onClick={openLessonPicker}>
              📄 Load lesson
            </button>
          </div>
        )
      },
    [openLessonPicker],
  )

  // Large-class write toggles live inside tldraw's existing people menu (top-right).
  const HostSharePanel = useMemo(
    () =>
      function HostSharePanel() {
        return (
          <div className="tlui-share-zone" draggable={false}>
            <PeopleMenu>
              <WriteAccessControls grantedAtom={grantedAtom} onToggle={toggleGrant} />
            </PeopleMenu>
          </div>
        )
      },
    [grantedAtom, toggleGrant],
  )

  // Hide editing UI from students per their state; the host gets custom pieces.
  //  - Toolbar (draw tools + image upload): students only when they may write.
  //  - PageMenu (create/switch pages): students only while roaming under free reign.
  const components = useMemo<TLComponents>(() => {
    if (isHost) {
      const c: TLComponents = { MainMenu: HostMainMenu, MenuPanel: HostMenuPanel }
      if (isLarge) c.SharePanel = HostSharePanel
      return c
    }
    const c: TLComponents = {}
    if (!canWrite) c.Toolbar = null
    if (!freeReign) c.PageMenu = null
    return c
  }, [isHost, isLarge, canWrite, freeReign, HostMainMenu, HostMenuPanel, HostSharePanel])

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
        onMount={(ed) => {
          editorRef.current = ed
          setEditor(ed)
        }}
        components={components}
        licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
      />

      {isHost && (
        <div className="tutor-dock">
          {lessonStatus && <span className="lesson-status">{lessonStatus}</span>}
          {!linkCopied && <ShareControl roomId={roomId} onCopied={() => setLinkCopied(true)} />}
          <button
            className={`dock-btn ${freeReign ? 'primary' : ''}`}
            title="Let students roam pages/zoom freely and use their own calculators"
            onClick={() => toggleFreeReign(!freeReign)}
          >
            {freeReign ? '🔓 Free reign: On' : '🔒 Free reign: Off'}
          </button>
          <button className="dock-btn" onClick={() => setCalcOpen((v) => !v)}>
            {calcOpen ? 'Hide calculator' : '🧮 Calculator'}
          </button>
          <input
            ref={lessonInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={onLessonFile}
          />
        </div>
      )}

      {/* A roaming student's own dock: just their private calculator toggle. */}
      {!isHost && freeReign && (
        <div className="tutor-dock">
          <button className="dock-btn" onClick={() => setPersonalCalcOpen((v) => !v)}>
            {personalCalcOpen ? 'Hide calculator' : '🧮 My calculator'}
          </button>
        </div>
      )}

      {/* Shared (tutor-driven) calculator: host always; students only when following. */}
      {(isHost ? calcOpen : calcOpen && !freeReign) && (
        <Calculator
          channel={channel}
          isHost={isHost}
          initialState={lastCalcState.current}
          initialGeom={lastCalcGeom.current}
          canEdit={!isHost && studentsCanEdit}
          studentsCanEdit={studentsCanEdit}
          onToggleAccess={toggleAccess}
        />
      )}

      {/* A roaming student's private, non-synced scratch calculator. */}
      {!isHost && freeReign && personalCalcOpen && (
        <Calculator channel={channel} isHost={false} personal />
      )}
    </div>
  )
}

// A "Write access" section appended to tldraw's people-menu popover (top-right),
// listing each student with a switch. The participant list comes straight from
// tldraw's live presence, and the grant set is read reactively from an atom.
function WriteAccessControls({
  grantedAtom,
  onToggle,
}: {
  grantedAtom: Atom<Set<string>>
  onToggle: (studentId: string, allow: boolean) => void
}) {
  const editor = useEditor()
  const collaborators = useValue('collaborators', () => editor.getCollaborators(), [editor])
  const granted = useValue(grantedAtom)
  const students = collaborators.filter((c) => c.userId !== userId)
  if (students.length === 0) return null

  return (
    <div className="tlui-people-menu__section write-access">
      <div className="write-access__title">Write access</div>
      {students.map((c) => {
        const can = granted.has(c.userId)
        return (
          <div className="write-access__row" key={c.userId}>
            <span className="write-access__dot" style={{ background: c.color }} />
            <span className="write-access__name">{c.userName || 'Student'}</span>
            <button
              type="button"
              role="switch"
              aria-checked={can}
              title={can ? 'Can write — click to lock' : 'Locked — click to let them write'}
              className={`calc-switch ${can ? 'on' : ''}`}
              onClick={() => onToggle(c.userId, !can)}
            >
              <span className="calc-switch-knob" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

// Share control in the dock: the link + a Copy button. Once copied it tucks away
// (the main menu keeps a "Copy student link" item for re-copying).
function ShareControl({ roomId, onCopied }: { roomId: string; onCopied: () => void }) {
  const link = `${window.location.origin}/b/${roomId}`
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(onCopied, 900)
    } catch {
      /* clipboard blocked — leave it up so they can copy manually */
    }
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
