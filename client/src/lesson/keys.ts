// The key/meta split, enforced in code: a `LessonAnswer` (parsed from the raw
// lesson JSON) carries the answer key. That key must NEVER reach a synced
// tldraw shape — `meta` is synced to every student and readable in devtools.
// So this file derives two disjoint views of the same `LessonDoc`:
//   - `questionMetaFor`      -> goes into shape `meta.q`, synced to students.
//     Identity + input format only. No `key`, no `accept`, no `reveal`.
//   - `questionKeysFromDoc`  -> stays host-side, uploaded to the server over
//     the control channel (by the caller, not here). Carries the answer.
// Pure, DOM-free and tldraw-free so it's headlessly testable.

import type { QuestionKey, QuestionMeta } from '../../../shared/quiz.ts'
import type { LessonBlock, LessonDoc } from './schema'
import { blockId } from './layout'

/** The synced, student-visible descriptor for an answerable block. Never carries the key. */
export function questionMetaFor(block: LessonBlock, pi: number, bi: number): QuestionMeta | undefined {
  if (!block.answer) return undefined
  const { format, choices } = block.answer
  return {
    id: blockId(pi, bi),
    format,
    choices: format === 'choice' ? choices : undefined,
  }
}

/** The host-only answer keys for a whole document, in page/block order. */
export function questionKeysFromDoc(doc: LessonDoc): QuestionKey[] {
  const keys: QuestionKey[] = []
  doc.pages.forEach((page, pi) => {
    page.blocks.forEach((block, bi) => {
      const { answer } = block
      if (!answer) return
      keys.push({
        id: blockId(pi, bi),
        format: answer.format,
        key: answer.key,
        accept: answer.accept,
        choices: answer.choices,
        reveal: answer.reveal,
      })
    })
  })
  return keys
}
