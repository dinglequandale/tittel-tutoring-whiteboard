// Student-facing answer inputs, anchored beneath each answerable problem on the
// tldraw canvas. Mounted via `components.InFrontOfTheCanvas`, which tldraw
// renders as a DOM SIBLING of `.tl-canvas` (verified in the installed source,
// `@tldraw/editor/src/lib/components/default-components/DefaultCanvas.tsx`):
// it is NOT nested inside the camera-transformed `.tl-html-layer`, so nothing
// here is positioned for us. `OnTheCanvas` would be camera-transformed, but it
// paints *underneath* shapes — no good for an input that must sit in front of
// (beneath, visually) a locked problem image.
//
// To place boxes in page coordinates we replicate tldraw's own layer
// transform by hand: a 1x1px absolutely-positioned wrapper carrying
// `scale(z) translate(x, y)` for the current camera, exactly like
// `.tl-html-layer` does internally. Children are then positioned with plain
// page-space coordinates, and the wrapper's scale/translate does the rest.
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { useEditor, useValue, type Box, type TLShapeId } from 'tldraw'
import type { ControlChannel } from '../controlChannel'
import {
  DEFAULT_CHOICES,
  MAX_ANSWER_LEN,
  MAX_SEEN_BATCH,
  type QuestionMeta,
  type QuizAckMsg,
  type QuizAnswerMsg,
  type QuizRevealedMsg,
  type QuizSeenMsg,
} from '../../../shared/quiz.ts'
import './answers.css'

type AckState = { correct?: boolean }

type VisibleQuestion = {
  shapeId: TLShapeId
  q: QuestionMeta
  bounds: Box
}

function storageKey(roomId: string, qid: string): string {
  return `quiz:${roomId}:${qid}`
}

function readStored(roomId: string, qid: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(roomId, qid))
  } catch {
    return null // private-mode / storage-disabled browsers
  }
}

function writeStored(roomId: string, qid: string, value: string) {
  try {
    sessionStorage.setItem(storageKey(roomId, qid), value)
  } catch {
    /* ignore quota/private-mode errors — persistence is a nicety, not correctness */
  }
}

function clearStoredForRoom(roomId: string) {
  try {
    const prefix = storageKey(roomId, '')
    const toRemove: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(prefix)) toRemove.push(k)
    }
    toRemove.forEach((k) => sessionStorage.removeItem(k))
  } catch {
    /* ignore */
  }
}

export function makeAnswerOverlay(opts: {
  channel: ControlChannel
  roomId: string
  userId: string
  displayName: string
}): ComponentType {
  const { channel, roomId, userId, displayName } = opts

  return function AnswerOverlay() {
    const editor = useEditor()

    // Camera, read reactively so the wrapper's transform tracks pan/zoom exactly
    // the way tldraw's own `.tl-html-layer` does.
    const camera = useValue('quiz-overlay camera', () => editor.getCamera(), [editor])

    // Every answerable shape on the current page, with its page-space bounds.
    // `getShapePageBounds` is used (rather than reading shape.x/y directly)
    // because it accounts for the shape's full page transform and is robust to
    // parenting/rotation quirks.
    const questions = useValue<VisibleQuestion[]>(
      'quiz-overlay questions',
      () => {
        const out: VisibleQuestion[] = []
        for (const shape of editor.getCurrentPageShapes()) {
          const q = (shape.meta as { q?: QuestionMeta }).q
          if (!q) continue
          const bounds = editor.getShapePageBounds(shape.id)
          if (!bounds) continue
          out.push({ shapeId: shape.id, q, bounds })
        }
        // Stable order so the list doesn't reshuffle visually between renders.
        out.sort((a, b) => a.q.id.localeCompare(b.q.id))
        return out
      },
      [editor]
    )

    // Current/submitted value per question id. A question not yet present here
    // falls back to sessionStorage (see `valueFor`) — that's how a submitted
    // answer survives a mid-class refresh without an explicit restore effect.
    const [values, setValues] = useState<Record<string, string>>({})
    // Presence of a key means "this qid has been acked at least once this
    // session"; `correct` is only set when the server actually revealed it.
    const [acks, setAcks] = useState<Record<string, AckState>>({})
    const [revealedKeys, setRevealedKeys] = useState<Record<string, string>>({})

    // Which question ids we've already told the server we've "seen" this
    // session — never re-send, and always batch rather than one-per-question.
    const seenRef = useRef<Set<string>>(new Set())

    function valueFor(qid: string): string {
      if (qid in values) return values[qid]
      return readStored(roomId, qid) ?? ''
    }

    function setDraft(qid: string, val: string) {
      setValues((prev) => ({ ...prev, [qid]: val }))
    }

    function submit(qid: string, raw: string) {
      const value = raw.trim().slice(0, MAX_ANSWER_LEN)
      if (!value) return // never send empty answers
      setValues((prev) => ({ ...prev, [qid]: value }))
      writeStored(roomId, qid, value)
      const msg: QuizAnswerMsg = { type: 'quiz-answer', userId, name: displayName, qid, value }
      channel.send(msg)
    }

    // Batch-report newly visible questions once per page landing.
    useEffect(() => {
      const fresh = questions.map((v) => v.q.id).filter((id) => !seenRef.current.has(id))
      if (fresh.length === 0) return
      // Only mark the ids we actually send. Marking the truncated tail as "seen"
      // would strand it: never sent, never retried, and so recorded server-side
      // with no seenAt — which silently reports an elapsed time of zero.
      const qids = fresh.slice(0, MAX_SEEN_BATCH)
      qids.forEach((id) => seenRef.current.add(id))
      const msg: QuizSeenMsg = { type: 'quiz-seen', userId, qids }
      channel.send(msg)
    }, [questions])

    // Per-question correctness feedback. `correct` is absent unless the
    // question is immediate-feedback or already revealed — never infer it.
    useEffect(() => {
      return channel.on('quiz-ack', (msg: QuizAckMsg) => {
        setAcks((prev) => ({
          ...prev,
          [msg.qid]: 'correct' in msg ? { correct: msg.correct } : {},
        }))
      })
    }, [])

    // Tutor-triggered reveal: maps qid -> canonical answer, shown beside the box.
    useEffect(() => {
      return channel.on('quiz-revealed', (msg: QuizRevealedMsg) => {
        setRevealedKeys(msg.keys)
      })
    }, [])

    // Tutor-triggered reset: wipe local answer state and this room's persisted
    // answers, and let previously-seen questions be re-reported as "seen".
    useEffect(() => {
      return channel.on('quiz-reset', () => {
        setValues({})
        setAcks({})
        setRevealedKeys({})
        seenRef.current = new Set()
        clearStoredForRoom(roomId)
      })
    }, [])

    // The outer wrapper replicates tldraw's own camera transform, so its
    // children (in raw page-space coordinates) land in the right screen spot.
    const wrapperStyle: CSSProperties = {
      position: 'absolute',
      top: 0,
      left: 0,
      width: 1,
      height: 1,
      pointerEvents: 'none',
      transform: `scale(${camera.z}) translate(${camera.x}px, ${camera.y}px)`,
    }

    // tldraw owns pointer/keyboard events on the canvas via listeners on
    // ancestor DOM nodes (a container-level `keydown` listener, gesture/wheel
    // handlers, etc.). Because `InFrontOfTheCanvas` lives inside that same
    // ancestor chain, native events fired here would otherwise bubble straight
    // into tldraw's shortcut handling (deleting shapes, panning, zooming) —
    // exactly the failure mode `Calculator.tsx`'s shield/pointer-capture
    // pattern exists to avoid on the floating panel side. Since React's
    // `stopPropagation()` calls the underlying native `stopPropagation()`, it
    // halts real DOM bubbling before it reaches those ancestor listeners.
    const shield = {
      onPointerDown: (e: ReactPointerEvent) => e.stopPropagation(),
      onPointerMove: (e: ReactPointerEvent) => e.stopPropagation(),
      onPointerUp: (e: ReactPointerEvent) => e.stopPropagation(),
      onWheel: (e: ReactWheelEvent) => e.stopPropagation(),
      onKeyDown: (e: ReactKeyboardEvent) => e.stopPropagation(),
    }

    return (
      <div className="qa-layer" style={wrapperStyle}>
        {questions.map(({ shapeId, q, bounds }) => {
          const value = valueFor(q.id)
          const ack = acks[q.id]
          const revealed = revealedKeys[q.id]
          const answered = ack !== undefined
          const known = ack !== undefined && 'correct' in ack

          const boxStyle: CSSProperties = {
            left: bounds.x,
            top: bounds.y + bounds.h + 16,
            width: Math.min(bounds.w, 720),
          }

          return (
            <div key={shapeId} className="qa-box" style={boxStyle} {...shield}>
              <div className="qa-row">
                {q.format === 'choice' ? (
                  <div className="qa-choices">
                    {(q.choices ?? DEFAULT_CHOICES).map((letter) => {
                      const selected = value === letter
                      const cls = ['qa-choice']
                      if (selected) cls.push('qa-selected')
                      if (selected && known) cls.push(ack!.correct ? 'qa-correct' : 'qa-incorrect')
                      return (
                        <button
                          key={letter}
                          type="button"
                          className={cls.join(' ')}
                          onClick={() => submit(q.id, letter)}
                        >
                          {letter}
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div className="qa-grid-row">
                    <input
                      className="qa-input"
                      type="text"
                      inputMode="text"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={MAX_ANSWER_LEN}
                      placeholder="Answer"
                      value={value}
                      onChange={(e) => setDraft(q.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submit(q.id, value)
                      }}
                    />
                    <button
                      type="button"
                      className="qa-submit-btn"
                      onClick={() => submit(q.id, value)}
                    >
                      Submit
                    </button>
                  </div>
                )}
                {answered && (
                  <span
                    className={`qa-status${known ? (ack!.correct ? ' qa-correct' : ' qa-incorrect') : ' qa-neutral'}`}
                  >
                    {known ? (ack!.correct ? '✓' : '✗') : 'Answered'}
                  </span>
                )}
              </div>
              {revealed !== undefined && (
                <div className="qa-revealed-row">
                  Correct answer: <strong>{revealed}</strong>
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }
}
