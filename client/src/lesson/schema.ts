// The lesson-plan format is a deliberately GENERIC layout container — it knows
// nothing about pedagogy (no "warm-up" / "speed round" concepts). It describes
// only: ordered pages, each holding ordered content blocks, each block carrying
// its own content and the empty spacing beneath it (the workspace where live
// handwritten work lands). Any class shape — problem-heavy, slide-heavy, mixed —
// is just different content poured into the same container.

export type BlockType = 'latex' | 'text' | 'image'
export type BlockKind = 'heading' | 'body'

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
}

export interface LessonPage {
  /** Free-form label shown in the page list (e.g. "Warm-up", "Problem 3"). */
  label: string
  /** Optional hint for the suggested student mode when this page is shown. Advisory only. */
  mode?: 'follow' | 'free'
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

      return {
        type,
        kind,
        content: asString(block.content),
        src: asString(block.src),
        spacingAfter: asNumber(block.spacingAfter, defaults.spacing),
        maxWidth: asNumber(block.maxWidth, defaults.maxWidth),
      }
    })

    return { label: asString(page.label, `Page ${pi + 1}`), mode, blocks }
  })

  return { title: asString(obj.title, 'Lesson'), pages }
}
