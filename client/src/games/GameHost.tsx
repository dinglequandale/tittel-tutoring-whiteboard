// The single dynamic-import() boundary for the whole game library (see
// Board.tsx: `lazy(() => import('./games/GameHost'))`). Subscribes to the
// sticky `game-state` message and owns the stage chrome: the library (host
// only, no game running), the running game's lazy Component, the LOCAL
// minimize, and the host's End-game control. Renders as a sibling of
// Timer/Calculator in `.board-root` — outside <Tldraw>, screen space, no
// editor context available (see games-spec.md's Board.tsx section).
import { Suspense, useEffect, useState } from 'react'
import type { ControlChannel } from '../controlChannel'
import type { Player } from '../../../shared/games/index.ts'
import { findGame } from './registry'
import { GameLibrary } from './GameLibrary'
import './games.css'

type RunningGame = { gameId: string; state: unknown; players: Player[] } | null

export default function GameHost({
  channel,
  isHost,
  userId,
  participants,
  onClose,
}: {
  channel: ControlChannel
  isHost: boolean
  userId: string
  participants: { userId: string; name: string; color: string }[]
  /** Host backed out of the library without starting a game (clicked Games,
   *  then decided not to). Only meaningful while no game is running — once
   *  one starts, only `game-end` (server, everyone) dismisses the stage. */
  onClose: () => void
}) {
  const [game, setGame] = useState<RunningGame>(null)
  // Local-only: never broadcast, never read by anyone else. Reset when the
  // game ends so the next one a tutor starts doesn't open pre-minimized.
  const [minimized, setMinimized] = useState(false)

  // 'game-state' is sticky (see controlChannel.ts), so a GameHost that mounts
  // after the message already arrived (a guest whose lazy chunk just finished
  // loading) still gets the current game immediately, replayed on subscribe —
  // matching Timer.tsx's late-join discipline.
  useEffect(() => channel.on('game-state', (m) => setGame((m.game as RunningGame) ?? null)), [channel])

  useEffect(() => {
    if (!game) setMinimized(false)
  }, [game])

  // GameHost only mounts for a guest when a game is actually active (Board's
  // `gameActive` gate) — a guest has no dock button to set `gamesOpen`. This
  // guard is defensive, not load-bearing: if it's ever wrong, fail closed
  // (render nothing) rather than leak a library UI a guest shouldn't see.
  if (!isHost && !game) return null

  if (game && minimized) {
    return (
      <button className="games-mini-chip" onClick={() => setMinimized(false)}>
        🎲 Game running — restore
      </button>
    )
  }

  // An unrecognized gameId (e.g. a future rollback removed a game from the
  // registry while a room still references it) fails closed — no crash, no
  // stage — rather than rendering a lazy Component that doesn't exist.
  const meta = game ? findGame(game.gameId) : null
  if (game && !meta) return null

  return (
    <div className="games-backdrop">
      <div className="games-stage">
        <div className="games-stage-header">
          <span className="games-stage-title">{meta ? meta.title : 'Game library'}</span>
          <div className="games-stage-actions">
            {game && (
              <button className="dock-btn" onClick={() => setMinimized(true)}>
                ⬓ Minimize
              </button>
            )}
            {game && isHost && (
              <button className="dock-btn" onClick={() => channel.send({ type: 'game-end' })}>
                ✕ End game
              </button>
            )}
            {!game && (
              <button className="dock-btn" onClick={onClose}>
                ✕ Close
              </button>
            )}
          </div>
        </div>
        <div className="games-stage-body">
          {game && meta ? (
            <Suspense fallback={null}>
              <meta.Component
                channel={channel}
                isHost={isHost}
                userId={userId}
                state={game.state}
                players={game.players}
              />
            </Suspense>
          ) : (
            <GameLibrary channel={channel} participants={participants} />
          )}
        </div>
      </div>
    </div>
  )
}
