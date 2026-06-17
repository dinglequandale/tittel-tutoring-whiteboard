// Headless unit test for the pure lesson pieces — schema validation/normalization
// and flow-layout position math. (Rendering/injection need a browser and are
// verified by Konrad in the two-window manual check.)
//
// Run with:  npx tsx test/lesson.mjs
import { parseLessonDoc, LessonParseError, LESSON_DEFAULTS } from '../client/src/lesson/schema.ts'
import { computeLayout, blockId, pageId } from '../client/src/lesson/layout.ts'

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
function throws(name, fn) {
  try {
    fn()
    check(name, false)
  } catch (e) {
    check(name, e instanceof LessonParseError)
  }
}

// ---- schema: rejects structurally bad input -------------------------------
throws('rejects non-object', () => parseLessonDoc(42))
throws('rejects missing pages', () => parseLessonDoc({ title: 'x' }))
throws('rejects empty pages', () => parseLessonDoc({ pages: [] }))
throws('rejects page without blocks', () => parseLessonDoc({ pages: [{ label: 'a' }] }))
throws('rejects text block without content', () =>
  parseLessonDoc({ pages: [{ blocks: [{ type: 'latex' }] }] }))
throws('rejects image block without src', () =>
  parseLessonDoc({ pages: [{ blocks: [{ type: 'image' }] }] }))

// ---- schema: normalizes + applies defaults --------------------------------
const doc = parseLessonDoc({
  title: 'Day 1',
  defaults: { spacing: 200, maxWidth: 600 },
  pages: [
    {
      label: 'Warm-up',
      mode: 'follow',
      blocks: [
        { type: 'latex', content: 'Solve $x^2=9$', kind: 'heading' },
        { type: 'text', content: 'Explain.', spacingAfter: 99 },
      ],
    },
    { blocks: [{ type: 'image', src: '/u/fig.png' }] },
  ],
})
check('keeps title', doc.title === 'Day 1')
check('two pages', doc.pages.length === 2)
check('page label preserved', doc.pages[0].label === 'Warm-up')
check('mode hint preserved', doc.pages[0].mode === 'follow')
check('per-doc default spacing applied', doc.pages[0].blocks[0].spacingAfter === 200)
check('per-block spacing overrides default', doc.pages[0].blocks[1].spacingAfter === 99)
check('default maxWidth applied', doc.pages[0].blocks[0].maxWidth === 600)
check('heading kind kept', doc.pages[0].blocks[0].kind === 'heading')
check('unknown kind falls back to body', doc.pages[0].blocks[1].kind === 'body')
check('missing label auto-filled', doc.pages[1].label === 'Page 2')

// falls back to global defaults when no defaults block given
const doc2 = parseLessonDoc({ pages: [{ blocks: [{ content: 'hi' }] }] })
check('global default spacing used', doc2.pages[0].blocks[0].spacingAfter === LESSON_DEFAULTS.spacing)
check('block type defaults to latex', doc2.pages[0].blocks[0].type === 'latex')

// ---- layout: deterministic ids + vertical flow ----------------------------
const measures = {
  '0:0': { w: 400, h: 100 },
  '0:1': { w: 300, h: 50 },
  '1:0': { w: 600, h: 400 },
}
const placed = computeLayout(doc, (pi, bi) => measures[`${pi}:${bi}`])
check('layout keeps page count', placed.length === 2)
check('deterministic page id', placed[0].id === pageId(0))
check('deterministic block id', placed[0].blocks[0].id === blockId(0, 0))
check('first block at top margin', placed[0].blocks[0].y === 80)
// second block y = topMargin(80) + firstHeight(100) + firstSpacing(200) = 380
check('second block flows below first with spacing', placed[0].blocks[1].y === 380)
check('blocks left-aligned at x=0', placed[0].blocks[0].x === 0)
check('measured size carried into placement', placed[1].blocks[0].h === 400)
// missing measure → placeholder, still well-defined
const placedMissing = computeLayout(doc2, () => undefined)
check('missing measure falls back to placeholder height', placedMissing[0].blocks[0].h === 40)

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
