import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { nanoid } from 'nanoid'

type ClassMode = 'small' | 'large'

export function Landing() {
  const navigate = useNavigate()
  const [toast, setToast] = useState<string | null>(null)
  const [mode, setMode] = useState<ClassMode>('small')

  async function startBoard() {
    const roomId = nanoid(10)
    const shareLink = `${window.location.origin}/b/${roomId}`
    // Best-effort copy of the clean (student) link before we navigate.
    try {
      await navigator.clipboard.writeText(shareLink)
      setToast('Link copied — send it to your students')
    } catch {
      setToast('Board created — copy the link from the bar up top')
    }
    // The tutor goes to the #host variant so their pan/zoom drives every view.
    // The mode rides in the fragment, so it never leaks into the shared link.
    const fragment = mode === 'large' ? '#host-large' : '#host'
    navigate(`/b/${roomId}${fragment}`)
  }

  return (
    <div className="landing">
      <h1>Tittel Tutoring Whiteboard</h1>
      <p>
        Spin up a shared whiteboard in one click. Send the link to your students — no sign-up,
        no install. When everyone leaves, the board disappears.
      </p>

      <div className="mode-picker">
        <ModeOption
          selected={mode === 'small'}
          onSelect={() => setMode('small')}
          title="Individual / small group"
          desc="Everyone can draw freely. Quick and open."
        />
        <ModeOption
          selected={mode === 'large'}
          onSelect={() => setMode('large')}
          title="Large group"
          desc="Students enter a name; you control who can write."
        />
      </div>

      <button className="start-btn" onClick={startBoard}>
        Start a new board
      </button>
      <p className="hint">
        You drive the view: when you pan or zoom, your students&rsquo; screens follow yours.
      </p>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function ModeOption({
  selected,
  onSelect,
  title,
  desc,
}: {
  selected: boolean
  onSelect: () => void
  title: string
  desc: string
}) {
  return (
    <button
      type="button"
      className={`mode-option ${selected ? 'selected' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="mode-option-title">{title}</span>
      <span className="mode-option-desc">{desc}</span>
    </button>
  )
}
