// Game library metadata: what the tutor picks from in GameLibrary, and where
// each game's UI code lives. Deliberately data-only, and one `lazy()` PER
// game — a tenth game registered here must not pull an existing game's
// Component into anyone else's chunk. This file itself is only ever reached
// through GameHost.tsx, which Board.tsx loads behind a single dynamic
// import() — see games-spec.md's "Zero cost when unused" and
// test/build-split.mjs, which asserts Nim's rules/UI split into their own
// chunk rather than bloating either the entry bundle or this registry's.
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { ControlChannel } from '../controlChannel'
import type { Player } from '../../../shared/games/index.ts'

/** Props every game's top-level component receives from GameHost. `state` is
 *  opaque here on purpose — each game casts it back to its own shape (e.g.
 *  NimGame casts to NimState) rather than this shared type importing every
 *  game's rules module, which would defeat the whole point of per-game
 *  chunks. */
export interface GameComponentProps {
  channel: ControlChannel
  isHost: boolean
  userId: string
  state: unknown
  players: Player[]
}

/** A numeric setup option's legal range plus its default, e.g. Nim's pile size. */
export interface OptionRange {
  min: number
  max: number
  default: number
}

export interface GameMeta {
  id: string
  title: string
  blurb: string
  pile: OptionRange
  misereDefault: boolean
  /** Not tutor-configurable in Phase 2's setup screen (games-spec.md only
   *  calls for a pile stepper + misère toggle) — kept here so `game-start`'s
   *  options are fully determined by the registry, not hand-assembled at the
   *  call site. */
  maxTakeDefault: number
  Component: LazyExoticComponent<ComponentType<GameComponentProps>>
}

export const GAMES: GameMeta[] = [
  {
    id: 'nim',
    title: 'The 21 Game',
    blurb:
      'One pile of tokens. Take 1–3 on your turn. Whoever takes the last token wins — unless you flip Misère, where taking the last one loses.',
    pile: { min: 5, max: 40, default: 21 },
    misereDefault: false,
    maxTakeDefault: 3,
    // Its own lazy() boundary, separate from every other game's: this is what
    // keeps Nim's rules (shared/games/nim.ts, including the tutor-only hint
    // logic) and UI out of the chunk this registry itself lives in.
    Component: lazy(() => import('./nim/NimGame')),
  },
]

export function findGame(gameId: string): GameMeta | undefined {
  return GAMES.find((g) => g.id === gameId)
}
