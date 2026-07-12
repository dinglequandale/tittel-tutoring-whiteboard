// The card grid (host only) shown inside GameHost's stage when no game is
// running, plus the setup screen: pick exactly two players from the room and
// set options, then send `game-start`. Local state only — nothing here is
// synced until "Start game" is pressed.
import { useState } from 'react'
import type { ControlChannel } from '../controlChannel'
import { GAMES, type GameMeta } from './registry'

type Participant = { userId: string; name: string; color: string }

export function GameLibrary({
  channel,
  participants,
}: {
  channel: ControlChannel
  participants: Participant[]
}) {
  const [selected, setSelected] = useState<GameMeta | null>(null)

  if (!selected) {
    return (
      <div className="game-library">
        <p className="game-library-hint">Pick a game, then choose exactly two players.</p>
        <div className="game-card-grid">
          {GAMES.map((g) => (
            <button key={g.id} className="game-card" onClick={() => setSelected(g)}>
              <span className="game-card-title">{g.title}</span>
              <span className="game-card-blurb">{g.blurb}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <GameSetup game={selected} participants={participants} channel={channel} onBack={() => setSelected(null)} />
  )
}

function GameSetup({
  game,
  participants,
  channel,
  onBack,
}: {
  game: GameMeta
  participants: Participant[]
  channel: ControlChannel
  onBack: () => void
}) {
  // Picked userIds in pick order — order matters, it becomes seat 0/1 (whose
  // turn is first) in the `game-start` message.
  const [pickedIds, setPickedIds] = useState<string[]>([])
  // One entry per game.options field, keyed by field.key. Seeded from each
  // field's own default so a new game needs no setup-screen code of its own.
  const [values, setValues] = useState<Record<string, number | boolean>>(() => {
    const init: Record<string, number | boolean> = {}
    for (const f of game.options) init[f.key] = f.kind === 'stepper' ? f.range.default : f.default
    return init
  })

  function togglePlayer(userId: string) {
    setPickedIds((prev) => {
      if (prev.includes(userId)) return prev.filter((id) => id !== userId)
      if (prev.length >= 2) return prev // full — deselect one before picking another
      return [...prev, userId]
    })
  }

  const canStart = pickedIds.length === 2

  function start() {
    if (!canStart) return
    const players = pickedIds.map((id) => ({
      userId: id,
      name: participants.find((p) => p.userId === id)?.name ?? 'Player',
    }))
    channel.send({
      type: 'game-start',
      gameId: game.id,
      players,
      options: { ...game.fixedOptions, ...values },
    })
  }

  return (
    <div className="game-setup">
      <button className="game-setup-back" onClick={onBack}>
        ← Back to library
      </button>
      <h3 className="game-setup-title">{game.title}</h3>

      <div className="game-setup-section">
        <div className="game-setup-label">Players (pick exactly 2)</div>
        {participants.length === 0 ? (
          <p className="game-setup-empty">No one&rsquo;s in the room yet.</p>
        ) : (
          <div className="game-player-list">
            {participants.map((p) => {
              const seat = pickedIds.indexOf(p.userId)
              const picked = seat !== -1
              return (
                <button
                  key={p.userId}
                  type="button"
                  className={`game-player-chip${picked ? ' picked' : ''}`}
                  onClick={() => togglePlayer(p.userId)}
                >
                  <span className="game-player-dot" style={{ background: p.color }} />
                  {p.name}
                  {picked && <span className="game-player-seat">P{seat + 1}</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {game.options.map((f) =>
        f.kind === 'stepper' ? (
          <div className="game-setup-section" key={f.key}>
            <div className="game-setup-label">{f.label}</div>
            <div className="game-stepper">
              <button
                type="button"
                disabled={(values[f.key] as number) <= f.range.min}
                onClick={() =>
                  setValues((v) => ({ ...v, [f.key]: Math.max(f.range.min, (v[f.key] as number) - 1) }))
                }
              >
                −
              </button>
              <span className="game-stepper-value">{values[f.key]}</span>
              <button
                type="button"
                disabled={(values[f.key] as number) >= f.range.max}
                onClick={() =>
                  setValues((v) => ({ ...v, [f.key]: Math.min(f.range.max, (v[f.key] as number) + 1) }))
                }
              >
                +
              </button>
            </div>
          </div>
        ) : (
          <div className="game-setup-section" key={f.key}>
            <label className="game-setup-checkbox">
              <input
                type="checkbox"
                checked={values[f.key] as boolean}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))}
              />
              {f.label}
            </label>
          </div>
        ),
      )}

      <button className="dock-btn primary game-setup-start" disabled={!canStart} onClick={start}>
        ▶ Start game
      </button>
    </div>
  )
}
