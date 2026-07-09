// Headless unit test for the pure answer-grading logic in shared/grade.ts.
//
// Run with:  npx tsx test/grade.mjs
import { normalizeAnswer, gradeAnswer } from '../shared/grade.ts'

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

function choiceKey(key, extra = {}) {
  return { id: 'q', format: 'choice', key, reveal: 'never', ...extra }
}
function gridKey(key, extra = {}) {
  return { id: 'q', format: 'grid', key, reveal: 'never', ...extra }
}

// ---- normalizeAnswer --------------------------------------------------
check('normalize trims and strips internal whitespace', normalizeAnswer('  1 / 2 ') === '1/2')
check('normalize converts unicode minus', normalizeAnswer('−3') === '-3')
check('normalize converts en-dash', normalizeAnswer('–3') === '-3')
check('normalize strips leading +', normalizeAnswer('+8') === '8')
check('normalize strips surrounding parens', normalizeAnswer('(A)') === 'A')
check('normalize leaves plain value alone', normalizeAnswer('8') === '8')
check('normalize does not lowercase', normalizeAnswer('AbC') === 'AbC')

// ---- choice -------------------------------------------------------------
check("choice: 'b' vs key 'B' -> true", gradeAnswer('b', choiceKey('B')) === true)
check("choice: '(C)' vs key 'C' -> true", gradeAnswer('(C)', choiceKey('C')) === true)
check("choice: 'A' vs key 'B' -> false", gradeAnswer('A', choiceKey('B')) === false)

// ---- grid: exact / equivalent literals -----------------------------------
check("grid: '8' vs key '8'", gradeAnswer('8', gridKey('8')) === true)
check("grid: '8.0' vs key '8'", gradeAnswer('8.0', gridKey('8')) === true)
check("grid: '+8' vs key '8'", gradeAnswer('+8', gridKey('8')) === true)
check("grid: '-3' vs key '-3'", gradeAnswer('-3', gridKey('-3')) === true)

// ---- grid: fractions ------------------------------------------------------
check("grid: '1/2' vs key '0.5' -> true", gradeAnswer('1/2', gridKey('0.5')) === true)
check("grid: '.5' vs key '1/2' -> true", gradeAnswer('.5', gridKey('1/2')) === true)
check("grid: '4/6' vs key '2/3' -> true", gradeAnswer('4/6', gridKey('2/3')) === true)

// ---- grid: SAT repeating-decimal convention (0.1% relative tolerance) -----
check("grid: '.6666' vs key '2/3' -> true", gradeAnswer('.6666', gridKey('2/3')) === true)
check("grid: '0.6667' vs key '2/3' -> true", gradeAnswer('0.6667', gridKey('2/3')) === true)
check("grid: '2/3' vs key '2/3' -> true", gradeAnswer('2/3', gridKey('2/3')) === true)
check("grid: '.67' vs key '2/3' -> false (too coarse)", gradeAnswer('.67', gridKey('2/3')) === false)
check("grid: '.6' vs key '2/3' -> false (too coarse)", gradeAnswer('.6', gridKey('2/3')) === false)

// ---- grid: accept[] escape hatch -------------------------------------------
check(
  "grid: 'x=4' vs key '4' with accept ['x=4'] -> true",
  gradeAnswer('x=4', gridKey('4', { accept: ['x=4'] })) === true,
)

// ---- grid: rejections -------------------------------------------------------
check("grid: '' vs key '8' -> false (Number('')===0 trap)", gradeAnswer('', gridKey('8')) === false)
check("grid: ' ' vs key '8' -> false", gradeAnswer(' ', gridKey('8')) === false)
check("grid: 'abc' vs key '8' -> false", gradeAnswer('abc', gridKey('8')) === false)
check("grid: '1/0' vs key '8' -> false (division by zero)", gradeAnswer('1/0', gridKey('8')) === false)
check("grid: '9' vs key '8' -> false", gradeAnswer('9', gridKey('8')) === false)

// ---- grid: unicode minus ----------------------------------------------------
check("grid: unicode minus '−3' vs key '-3' -> true", gradeAnswer('−3', gridKey('-3')) === true)

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
