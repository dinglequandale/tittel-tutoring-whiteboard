import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { nanoid } from 'nanoid'

type ClassMode = 'small' | 'large'

// Turn a free-typed class name into a clean, URL-safe room id. Returns '' when
// nothing usable is left, so the caller can fall back to a random id.
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // spaces/punctuation -> single hyphen
    .replace(/^-+|-+$/g, '') // trim stray leading/trailing hyphens
    .slice(0, 50)
}

export function Landing() {
  const navigate = useNavigate()
  const [toast, setToast] = useState<string | null>(null)
  const [mode, setMode] = useState<ClassMode>('small')
  const [customName, setCustomName] = useState('')

  async function startBoard() {
    // A named class gets a fixed, memorable URL (e.g. /b/sat-math-bootcamp) that
    // students can reuse every session; blank falls back to a throwaway id. Either
    // way the board itself stays ephemeral — nothing persists between sessions.
    const slug = slugify(customName)
    const roomId = slug || nanoid(10)
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

      <div className="custom-name">
        <label htmlFor="class-name">Fixed class URL (optional)</label>
        <div className="custom-name-row">
          <span className="custom-name-prefix">/b/</span>
          <input
            id="class-name"
            type="text"
            placeholder="sat-math-bootcamp"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && startBoard()}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <span className="custom-name-hint">
          {slugify(customName)
            ? `Students reuse this same link every session: /b/${slugify(customName)}`
            : 'Leave blank for a one-off board with a random link.'}
        </span>
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
