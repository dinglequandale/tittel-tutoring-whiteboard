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
throws('rejects answer with bad format', () =>
  parseLessonDoc({
    pages: [{ blocks: [{ content: 'x', answer: { format: 'essay', key: 'a' } }] }],
  }))
throws('rejects answer with empty key', () =>
  parseLessonDoc({
    pages: [{ blocks: [{ content: 'x', answer: { format: 'grid', key: '' } }] }],
  }))
throws('rejects answer with missing key', () =>
  parseLessonDoc({
    pages: [{ blocks: [{ content: 'x', answer: { format: 'grid' } }] }],
  }))

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

// ---- schema: `answer` (absent case, defaults, reveal precedence) ----------
check('block with no answer parses to undefined', doc2.pages[0].blocks[0].answer === undefined)

const docAnswer = parseLessonDoc({
  pages: [
    {
      reveal: 'never',
      blocks: [
        // block reveal beats page reveal
        { content: 'q1', answer: { format: 'choice', key: 'B', reveal: 'immediate' } },
      ],
    },
    {
      reveal: 'immediate',
      blocks: [
        // page reveal applies when block omits its own
        { content: 'q2', answer: { format: 'grid', key: '42' } },
      ],
    },
    {
      blocks: [
        // both absent -> 'never'
        { content: 'q3', answer: { format: 'grid', key: '7' } },
      ],
    },
    {
      blocks: [
        // grid ignores supplied choices
        { content: 'q4', answer: { format: 'grid', key: '1/2', choices: ['A', 'B'] } },
        // accept: [] normalizes to undefined
        { content: 'q5', answer: { format: 'grid', key: '3', accept: [] } },
        // a grid-in answer authored as a JSON number, not a quoted string
        { content: 'q6', answer: { format: 'grid', key: 8 } },
        // ...and numeric entries inside accept[]
        { content: 'q7', answer: { format: 'grid', key: 0.5, accept: [0.5, '1/2'] } },
      ],
    },
  ],
})
check(
  'format:choice with no choices defaults to A-D',
  JSON.stringify(docAnswer.pages[0].blocks[0].answer.choices) === JSON.stringify(['A', 'B', 'C', 'D']),
)
check('format:grid with choices supplied stores undefined', docAnswer.pages[3].blocks[0].answer.choices === undefined)
check('block reveal beats page reveal', docAnswer.pages[0].blocks[0].answer.reveal === 'immediate')
check('page reveal applies when block omits it', docAnswer.pages[1].blocks[0].answer.reveal === 'immediate')
check('both absent falls back to never', docAnswer.pages[2].blocks[0].answer.reveal === 'never')
check('accept: [] normalizes to undefined', docAnswer.pages[3].blocks[1].answer.accept === undefined)
check('numeric key is coerced to a string', docAnswer.pages[3].blocks[2].answer.key === '8')
check(
  'numeric accept[] entries are coerced, not dropped',
  JSON.stringify(docAnswer.pages[3].blocks[3].answer.accept) === JSON.stringify(['0.5', '1/2']),
)
check('numeric key of 0.5 survives as "0.5"', docAnswer.pages[3].blocks[3].answer.key === '0.5')

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
