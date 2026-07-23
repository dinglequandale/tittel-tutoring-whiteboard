// The rules registry the server dispatches through. server/index.ts must
// contain ZERO game-specific logic: it looks up `GAME_RULES[gameId]`, rejects
// an unknown id, and calls `create` / `applyMove`. Adding a second game means
// writing a new shared/games/<name>.ts and adding one line here — no server
// edits. Keep this file (and everything it imports) dependency-free and
// DOM-free so `tsx` can load it server-side, same discipline as shared/grade.ts.
import { createNim, applyNimMove, type NimOptions, type NimMove, type NimState } from './nim.ts'
import { createLockers, applyLockersMove, type LockersOptions, type LockersMove, type LockersState } from './lockers.ts'
import { createPizza, applyPizzaMove, type PizzaOptions, type PizzaMove, type PizzaState } from './pizza.ts'
import { createBalance, applyBalanceMove, type BalanceOptions, type BalanceMove, type BalanceState } from './balance.ts'
import { createCoins, applyCoinsMove, type CoinsOptions, type CoinsMove, type CoinsState } from './coins.ts'

/** One of the exactly-two participants the tutor picked. Game-agnostic. */
export interface Player {
  userId: string
  name: string
}

export interface GameRules {
  create(options: unknown): unknown
  applyMove(
    state: unknown,
    playerIdx: 0 | 1,
    move: unknown,
  ): { ok: true; state: unknown } | { ok: false; error: string }
  /** True once the state has a winner — the server uses this to gate reset/replay, not the client. */
  isTerminal(state: unknown): boolean
}

export const GAME_RULES: Record<string, GameRules> = {
  nim: {
    create: (options) => createNim(options as NimOptions),
    applyMove: (state, playerIdx, move) => applyNimMove(state as NimState, playerIdx, move as NimMove),
    isTerminal: (state) => (state as NimState).winner !== null,
  },
  lockers: {
    create: (options) => createLockers(options as LockersOptions),
    applyMove: (state, playerIdx, move) => applyLockersMove(state as LockersState, playerIdx, move as LockersMove),
    isTerminal: (state) => (state as LockersState).done,
  },
  pizza: {
    create: (options) => createPizza(options as PizzaOptions),
    applyMove: (state, playerIdx, move) => applyPizzaMove(state as PizzaState, playerIdx, move as PizzaMove),
    isTerminal: (state) => (state as PizzaState).done,
  },
  balance: {
    create: (options) => createBalance(options as BalanceOptions),
    applyMove: (state, playerIdx, move) => applyBalanceMove(state as BalanceState, playerIdx, move as BalanceMove),
    isTerminal: (state) => (state as BalanceState).winner !== null,
  },
  coins: {
    create: (options) => createCoins(options as CoinsOptions),
    applyMove: (state, playerIdx, move) => applyCoinsMove(state as CoinsState, playerIdx, move as CoinsMove),
    isTerminal: (state) => (state as CoinsState).winner !== null,
  },
}

/**
 * Separate from GUEST_MSG_RATE (shared/quiz.ts). A live drag stream needs a
 * much higher ceiling — see games-spec.md's rate-limiting section for why
 * reusing the quiz bucket would silently shred it.
 */
export const GAME_MSG_RATE = 60

/** Exactly two players per game: the tutor picks 2 from the room; everyone else spectates. */
export const PLAYER_COUNT = 2

/** Hard cap on a `game-drag` payload's JSON size, in characters. */
export const MAX_DRAG_PAYLOAD = 1024
