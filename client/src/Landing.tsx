import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { nanoid } from 'nanoid'

export function Landing() {
  const navigate = useNavigate()
  const [toast, setToast] = useState<string | null>(null)

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
    navigate(`/b/${roomId}#host`)
  }

  return (
    <div className="landing">
      <h1>Tittel Tutoring Whiteboard</h1>
      <p>
        Spin up a shared whiteboard in one click. Send the link to your students — no sign-up,
        no install. When everyone leaves, the board disappears.
      </p>
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
