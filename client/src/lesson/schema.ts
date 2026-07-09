// The lesson-plan format is a deliberately GENERIC layout container — it knows
// nothing about pedagogy (no "warm-up" / "speed round" concepts). It describes
// only: ordered pages, each holding ordered content blocks, each block carrying
// its own content and the empty spacing beneath it (the workspace where live
// handwritten work lands). Any class shape — problem-heavy, slide-heavy, mixed —
// is just different content poured into the same container.
//
// `answer` is the one exception worth calling out: it says "this block accepts
// a response" — never "this block is practice" or "this block is a warm-up".
// Demo/explanation blocks simply omit it. The format still knows nothing about
// pedagogy; it only knows some blocks collect an answer and some don't.

import type { AnswerFormat, Reveal } from '../../../shared/quiz.ts'
import { DEFAULT_CHOICES } from '../../../shared/quiz.ts'

export type BlockType = 'latex' | 'text' | 'image'
export type BlockKind = 'heading' | 'body'

/**
 * Resolved answer-collection config for a block. `reveal` is always resolved
 * by parse time (block's own, else the page's, else 'never') so nothing
 * downstream needs to re-derive precedence.
 */
export interface LessonAnswer {
  format: AnswerFormat
  key: string
  accept?: string[]
  /** 'choice' only; defaults to DEFAULT_CHOICES. Ignored (and dropped) for 'grid'. */
  choices?: string[]
  reveal: Reveal
}

/** One renderable entity: a problem, a whole problem set, an explanation, or an image. */
export interface LessonBlock {
  /** 'latex'/'text' render `content` (with `$...$` / `$$...$$` math); 'image' uses `src`. */
  type: BlockType
  /** Text/LaTeX source for 'latex'/'text' blocks. May contain inline ($) and display ($$) math. */
  content?: string
  /** Image URL for 'image' blocks (e.g. a diagram or chart). */
  src?: string
  /** Purely presentational: 'heading' renders larger. Never drives any logic. */
  kind: BlockKind
  /** Empty space (px) left below this block — the workspace. Overrides the doc default. */
  spacingAfter: number
  /** Max rendered width (px) for this block. Overrides the doc default. */
  maxWidth: number
  /** Absent for anything that isn't collecting a response (headings, prose, demos). */
  answer?: LessonAnswer
}

export interface LessonPage {
  /** Free-form label shown in the page list (e.g. "Warm-up", "Problem 3"). */
  label: string
  /** Optional hint for the suggested student mode when this page is shown. Advisory only. */
  mode?: 'follow' | 'free'
  /** Page-level default for a block's answer reveal, when the block doesn't set its own. */
  reveal?: Reveal
  blocks: LessonBlock[]
}

export interface LessonDoc {
  title: string
  pages: LessonPage[]
}

export interface LessonDefaults {
  /** Default workspace gap (px) below each block. */
  spacing: number
  /** Default max rendered block width (px). */
  maxWidth: number
}

export const LESSON_DEFAULTS: LessonDefaults = {
  spacing: 320,
  maxWidth: 720,
}

export class LessonParseError extends Error {}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
/** Non-throwing: filters to non-empty strings, drops the rest. undefined if nothing survives. */
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const cleaned = v.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * Answers are compared as strings, but a grid-in answer is naturally authored as
 * a JSON number (`"key": 8`, not `"key": "8"`). Accept both, so writing a lesson
 * never depends on remembering to quote a number.
 */
function asAnswerString(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/** Like `asStringArray`, but tolerates numeric entries (see `asAnswerString`). */
function asAnswerStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const cleaned = v.map(asAnswerString).filter((s) => s.trim() !== '')
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * Parse a block's optional `answer`. Absent -> undefined (the common case: headings,
 * prose, demos never collect a response). Present but structurally broken -> throws,
 * because a silently-dropped `key` or `format` would corrupt grading for a whole class.
 * Everything else about `answer` is coerced defensively, in keeping with the rest of
 * this parser.
 */
function parseAnswer(
  raw: unknown,
  pageReveal: Reveal | undefined,
  pi: number,
  bi: number,
): LessonAnswer | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') {
    throw new LessonParseError(`Block ${bi + 1} on page ${pi + 1} has an invalid "answer".`)
  }
  const a = raw as Record<string, unknown>

  if (a.format !== 'choice' && a.format !== 'grid') {
    throw new LessonParseError(
      `Block ${bi + 1} on page ${pi + 1} answer needs "format" to be "choice" or "grid".`,
    )
  }
  const format = a.format

  const key = asAnswerString(a.key).trim()
  if (!key) {
    throw new LessonParseError(`Block ${bi + 1} on page ${pi + 1} answer needs a non-empty "key".`)
  }

  const accept = asAnswerStringArray(a.accept)

  // Only meaningful for 'choice'; 'grid' never carries choices, whatever was passed in.
  const choices = format === 'choice' ? (asStringArray(a.choices) ?? [...DEFAULT_CHOICES]) : undefined

  const blockReveal = a.reveal === 'immediate' || a.reveal === 'never' ? a.reveal : undefined
  const reveal: Reveal = blockReveal ?? pageReveal ?? 'never'

  return { format, key, accept, choices, reveal }
}

/**
 * Validate + normalize an untrusted parsed-JSON value into a LessonDoc, filling
 * defaults from the document's own `defaults` block (themselves falling back to
 * LESSON_DEFAULTS). Throws LessonParseError with a human-readable reason on
 * anything structurally wrong, so the tutor gets a clear message on a bad file.
 */
export function parseLessonDoc(raw: unknown): LessonDoc {
  if (!raw || typeof raw !== 'object') {
    throw new LessonParseError('Lesson file must be a JSON object.')
  }
  const obj = raw as Record<string, unknown>

  const defaultsRaw = (obj.defaults ?? {}) as Record<string, unknown>
  const defaults: LessonDefaults = {
    spacing: asNumber(defaultsRaw.spacing, LESSON_DEFAULTS.spacing),
    maxWidth: asNumber(defaultsRaw.maxWidth, LESSON_DEFAULTS.maxWidth),
  }

  if (!Array.isArray(obj.pages) || obj.pages.length === 0) {
    throw new LessonParseError('Lesson file needs a non-empty "pages" array.')
  }

  const pages: LessonPage[] = obj.pages.map((p, pi) => {
    if (!p || typeof p !== 'object') {
      throw new LessonParseError(`Page ${pi + 1} must be an object.`)
    }
    const page = p as Record<string, unknown>
    if (!Array.isArray(page.blocks)) {
      throw new LessonParseError(`Page ${pi + 1} needs a "blocks" array.`)
    }
    const mode = page.mode === 'free' || page.mode === 'follow' ? page.mode : undefined
    const pageReveal = page.reveal === 'immediate' || page.reveal === 'never' ? page.reveal : undefined

    const blocks: LessonBlock[] = page.blocks.map((b, bi) => {
      if (!b || typeof b !== 'object') {
        throw new LessonParseError(`Block ${bi + 1} on page ${pi + 1} must be an object.`)
      }
      const block = b as Record<string, unknown>
      const type: BlockType =
        block.type === 'image' || block.type === 'text' ? block.type : 'latex'
      const kind: BlockKind = block.kind === 'heading' ? 'heading' : 'body'

      if (type === 'image') {
        if (!asString(block.src)) {
          throw new LessonParseError(`Image block ${bi + 1} on page ${pi + 1} needs a "src".`)
        }
      } else if (!asString(block.content)) {
        throw new LessonParseError(`Block ${bi + 1} on page ${pi + 1} needs "content".`)
      }

      const answer = parseAnswer(block.answer, pageReveal, pi, bi)

      return {
        type,
        kind,
        content: asString(block.content),
        src: asString(block.src),
        spacingAfter: asNumber(block.spacingAfter, defaults.spacing),
        maxWidth: asNumber(block.maxWidth, defaults.maxWidth),
        answer,
      }
    })

    return { label: asString(page.label, `Page ${pi + 1}`), mode, reveal: pageReveal, blocks }
  })

  return { title: asString(obj.title, 'Lesson'), pages }
}
