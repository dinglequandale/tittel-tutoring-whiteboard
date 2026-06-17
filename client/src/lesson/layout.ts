import type { LessonDoc } from './schema'

// Pure flow-layout computation: given a parsed lesson and the *measured* pixel
// size of each rendered block, decide where every block sits on its page. The
// author never specifies coordinates — blocks stack top-to-bottom, separated by
// each block's `spacingAfter` (the workspace gap). Keeping this pure (no DOM, no
// tldraw) makes it unit-testable headless; rendering/measuring lives elsewhere.

/** Measured rendered size of a block, keyed by its stable id. */
export interface BlockMeasure {
  w: number
  h: number
}

export interface PlacedBlock {
  /** Stable per-block id (deterministic: derived from page+block index). */
  id: string
  /** Index into the page's blocks (so the caller can find content/asset). */
  blockIndex: number
  x: number
  y: number
  w: number
  h: number
}

export interface PlacedPage {
  /** Stable per-page id (deterministic). */
  id: string
  label: string
  pageIndex: number
  blocks: PlacedBlock[]
}

/** Top padding before the first block on every page. */
const TOP_MARGIN = 80

export function blockId(pageIndex: number, blockIndex: number): string {
  return `lesson-${pageIndex}-${blockIndex}`
}
export function pageId(pageIndex: number): string {
  return `lesson-page-${pageIndex}`
}

/**
 * Lay out every page. `measure(pageIndex, blockIndex)` returns the rendered size
 * of that block; missing measures fall back to a small placeholder so layout is
 * still well-defined. Blocks are left-aligned at x=0 and flow down the page.
 */
export function computeLayout(
  doc: LessonDoc,
  measure: (pageIndex: number, blockIndex: number) => BlockMeasure | undefined,
): PlacedPage[] {
  return doc.pages.map((page, pi) => {
    let y = TOP_MARGIN
    const blocks: PlacedBlock[] = page.blocks.map((block, bi) => {
      const m = measure(pi, bi) ?? { w: 200, h: 40 }
      const placed: PlacedBlock = {
        id: blockId(pi, bi),
        blockIndex: bi,
        x: 0,
        y,
        w: m.w,
        h: m.h,
      }
      y += m.h + block.spacingAfter
      return placed
    })
    return { id: pageId(pi), label: page.label, pageIndex: pi, blocks }
  })
}
