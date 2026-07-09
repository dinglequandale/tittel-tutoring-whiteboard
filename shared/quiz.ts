// Shared contract for the answer-collection ("quiz") feature, imported by BOTH
// client/ and server/. Keep it dependency-free and DOM-free so `tsx` can load it
// on the server and Vite can bundle it into the client.
//
// The single most important invariant in this file: an answer KEY never travels
// to a student. The host uploads keys to the server over the control channel;
// the server grades. What lands in the synced tldraw document (`QuestionMeta`)
// carries only a question's identity and input format — never its answer.

/** How a question is answered. 'choice' = multiple choice; 'grid' = SAT grid-in. */
export type AnswerFormat = 'choice' | 'grid'

/**
 * Whether a student learns if they were right.
 * - 'immediate': the server acks correctness on submit (warm-ups, practice).
 * - 'never': the server never acks correctness, so nothing is readable from the
 *   network. Only the tutor's explicit "Reveal answers" opens it up.
 */
export type Reveal = 'immediate' | 'never'

/** Host-only. Holds the answer. Sent host -> server, and NEVER server -> guest. */
export interface QuestionKey {
  id: string
  format: AnswerFormat
  /** The canonical correct answer ('B', or '8', or '1/2'). */
  key: string
  /** Extra literal spellings accepted verbatim, beyond numeric equivalence. */
  accept?: string[]
  /** For 'choice': the selectable letters. Defaults to ['A','B','C','D']. */
  choices?: string[]
  reveal: Reveal
}

/**
 * Written into a lesson shape's `meta.q`. This IS synced to every student, so it
 * deliberately omits `key`, `accept`, and `reveal`.
 */
export interface QuestionMeta {
  id: string
  format: AnswerFormat
  choices?: string[]
}

export const DEFAULT_CHOICES = ['A', 'B', 'C', 'D']

// --- Server-held submission state -------------------------------------------

export interface Submission {
  userId: string
  name: string
  /** The student's first-ever answer to this question, and whether it was right. */
  first: string
  firstCorrect: boolean
  /** Their most recent answer (may equal `first`), and whether it is right. */
  latest: string
  latestCorrect: boolean
  /** ms between the client first rendering the question and the first submit. */
  elapsedMs: number
}

/** Per-question aggregate + the per-student drill-in. Sent to the HOST only. */
export interface QuestionStats {
  qid: string
  /** Distinct students who have submitted at least once. */
  answered: number
  /** Of those, how many were right on their first attempt / on their latest. */
  firstCorrect: number
  latestCorrect: number
  /** Median first-submit elapsed time across answerers; null when none. */
  medianMs: number | null
  students: Submission[]
}

export interface QuizStats {
  questions: QuestionStats[]
  /** True once the tutor has pressed "Reveal answers" for this room. */
  revealed: boolean
}

// --- Control-channel message shapes -----------------------------------------
// host -> server
export interface QuizKeyMsg { type: 'quiz-key'; questions: QuestionKey[] }
export interface QuizRevealMsg { type: 'quiz-reveal' }
export interface QuizResetMsg { type: 'quiz-reset' }

/**
 * The set of questions currently accepting answers. Sent host -> server as the
 * COMPLETE new set (idempotent, trivially replayable), and relayed verbatim to
 * guests. A question not in this set shows no input and rejects submissions.
 */
export interface QuizOpenMsg { type: 'quiz-open'; qids: string[] }
/** Cap on `QuizOpenMsg.qids`, so one frame can't make the server allocate freely. */
export const MAX_OPEN_QIDS = 500

// guest -> server
/**
 * Sent once when a student's client renders a page, listing every question that
 * became visible. It is a BATCH rather than one message per question on purpose:
 * a lesson page can hold well over `GUEST_MSG_RATE` problems, and per-question
 * messages would trip the rate limiter on mount, leaving those questions with no
 * `seenAt` and silently reporting an elapsed time of zero.
 */
export interface QuizSeenMsg { type: 'quiz-seen'; userId: string; qids: string[] }

/** Cap on `QuizSeenMsg.qids`, so one frame can't make the server allocate freely. */
export const MAX_SEEN_BATCH = 200
export interface QuizAnswerMsg {
  type: 'quiz-answer'
  userId: string
  name: string
  qid: string
  value: string
}

// server -> host
export interface QuizStatsMsg { type: 'quiz-stats'; stats: QuizStats }

// server -> guest
/** `correct` is present ONLY when the question is 'immediate' or already revealed. */
export interface QuizAckMsg { type: 'quiz-ack'; qid: string; correct?: boolean }
/** Broadcast when the tutor reveals; maps question id -> canonical answer. */
export interface QuizRevealedMsg { type: 'quiz-revealed'; keys: Record<string, string> }

/** Hard caps applied server-side; rooms are public-by-URL so guests are untrusted. */
export const MAX_ANSWER_LEN = 32
/** Max guest quiz messages accepted per socket per second. */
export const GUEST_MSG_RATE = 10
