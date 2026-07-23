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

/** One tutor-configurable field on the setup screen. GameSetup (in
 *  GameLibrary.tsx) renders these generically — a stepper or a checkbox —
 *  keyed by `key`, which becomes a property of `game-start`'s `options`. */
export type GameOptionField =
  | { key: string; label: string; kind: 'stepper'; range: OptionRange }
  | { key: string; label: string; kind: 'checkbox'; default: boolean }

export interface GameMeta {
  id: string
  title: string
  blurb: string
  /** Setup-screen fields, in display order. */
  options: GameOptionField[]
  /** Extra values merged into `game-start`'s `options` alongside whatever the
   *  tutor picked above — for values the registry fixes rather than exposing
   *  on the setup screen (e.g. Nim's maxTake). */
  fixedOptions?: Record<string, unknown>
  Component: LazyExoticComponent<ComponentType<GameComponentProps>>
}

export const GAMES: GameMeta[] = [
  {
    id: 'nim',
    title: 'The 21 Game',
    blurb:
      'One pile of tokens. Take 1–3 on your turn. Whoever takes the last token wins — unless you flip Misère, where taking the last one loses.',
    options: [
      { key: 'pile', label: 'Pile size', kind: 'stepper', range: { min: 5, max: 40, default: 21 } },
      { key: 'misere', label: 'Misère (taking the last token loses)', kind: 'checkbox', default: false },
    ],
    fixedOptions: { maxTake: 3 },
    // Its own lazy() boundary, separate from every other game's: this is what
    // keeps Nim's rules (shared/games/nim.ts, including the tutor-only hint
    // logic) and UI out of the chunk this registry itself lives in.
    Component: lazy(() => import('./nim/NimGame')),
  },
  {
    id: 'lockers',
    title: 'The Locker Problem',
    blurb:
      '100 closed lockers. Student 1 opens every one. Student 2 toggles every 2nd. Student N toggles every Nth. Which lockers end up open?',
    options: [
      { key: 'lockerCount', label: 'Number of lockers', kind: 'stepper', range: { min: 16, max: 144, default: 100 } },
    ],
    // Its own lazy() boundary too — see the comment on Nim's Component above.
    Component: lazy(() => import('./lockers/LockersGame')),
  },
  {
    id: 'pizza',
    title: 'The Pizza Cutting Problem',
    blurb:
      'A round pizza and N straight cuts. Every cut crosses every earlier one. Cut 1 → 2 pieces. Cut 2 → 4. Cut 3 → 7. How many after N?',
    options: [{ key: 'maxCuts', label: 'Number of cuts', kind: 'stepper', range: { min: 1, max: 12, default: 8 } }],
    // Its own lazy() boundary too — see the comment on Nim's Component above.
    Component: lazy(() => import('./pizza/PizzaGame')),
  },
  {
    id: 'balance',
    title: 'Balance',
    blurb:
      'Two piles of stones. On your turn take any number from ONE pile. Whoever takes the last stone wins. Can you keep the piles balanced?',
    options: [
      { key: 'a', label: 'Left pile', kind: 'stepper', range: { min: 1, max: 15, default: 5 } },
      { key: 'b', label: 'Right pile', kind: 'stepper', range: { min: 1, max: 15, default: 8 } },
      { key: 'misere', label: 'Misère (taking the last stone loses)', kind: 'checkbox', default: false },
    ],
    // Its own lazy() boundary too — see the comment on Nim's Component above.
    Component: lazy(() => import('./balance/BalanceGame')),
  },
  {
    id: 'coins',
    title: 'Coins on a Round Table',
    blurb:
      'Take turns placing coins on the table — no overlaps, none hanging off. Place the last coin to win. Is there a way the first player always wins?',
    options: [
      { key: 'freeform', label: 'Freeform — real game, place anywhere (you call “no moves left”)', kind: 'checkbox', default: true },
      { key: 'across', label: 'Coin size (coins across)', kind: 'stepper', range: { min: 4, max: 9, default: 6 } },
      { key: 'rectangle', label: 'Rectangular table (homework variant)', kind: 'checkbox', default: false },
      { key: 'centerBlocked', label: 'Block the center (lattice demo only)', kind: 'checkbox', default: false },
    ],
    // Its own lazy() boundary too — see the comment on Nim's Component above.
    Component: lazy(() => import('./coins/CoinsGame')),
  },
]

export function findGame(gameId: string): GameMeta | undefined {
  return GAMES.find((g) => g.id === gameId)
}
