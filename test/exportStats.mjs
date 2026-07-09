// Headless unit test for the pure CSV-export core (statsToCsv/csvCell/formatQid).
// downloadStatsCsv needs a DOM (Blob/URL/<a>) so it is exercised manually in a
// real browser instead — see the report for what that means.
//
// Run with:  npx tsx test/exportStats.mjs
import { statsToCsv, csvCell, formatQid } from '../client/src/quiz/exportStats.ts'

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

function submission(overrides = {}) {
  return {
    userId: 'u1',
    name: 'Ada',
    first: 'B',
    firstCorrect: true,
    latest: 'B',
    latestCorrect: true,
    elapsedMs: 1000,
    ...overrides,
  }
}

// ---- formatQid --------------------------------------------------------------
check('formatQid renders lesson-0-3 as P1·B4', formatQid('lesson-0-3') === 'P1·B4')
check('formatQid passes through a non-matching id unchanged', formatQid('weird-id') === 'weird-id')

// ---- header row + line endings ----------------------------------------------
const HEADER = 'question,student,first_answer,first_correct,latest_answer,latest_correct,seconds'

const oneQ = {
  revealed: false,
  questions: [
    {
      qid: 'lesson-0-0',
      answered: 1,
      firstCorrect: 1,
      latestCorrect: 1,
      medianMs: 1000,
      students: [submission()],
    },
  ],
}
const csv1 = statsToCsv(oneQ)
const lines1 = csv1.split('\r\n')
check('header row is exactly right', lines1[0] === HEADER)
check(
  'rows are \\r\\n-separated (no bare \\n present)',
  csv1.split('\r\n').every((line) => !line.includes('\n')),
)
check('single question/student produces header + 1 row', lines1.length === 2)

// ---- two students on one question -> two rows, in student order -------------
const twoStudents = {
  revealed: false,
  questions: [
    {
      qid: 'lesson-1-2',
      answered: 2,
      firstCorrect: 1,
      latestCorrect: 2,
      medianMs: 500,
      students: [
        submission({ userId: 'u1', name: 'Ada', first: 'A', firstCorrect: false, latest: 'B', latestCorrect: true }),
        submission({ userId: 'u2', name: 'Bo', first: 'B', firstCorrect: true, latest: 'B', latestCorrect: true }),
      ],
    },
  ],
}
const csv2 = statsToCsv(twoStudents)
const lines2 = csv2.split('\r\n')
check('two students yields two rows', lines2.length === 3)
check('rows are in student order (Ada then Bo)', lines2[1].startsWith('P2·B3,Ada,') && lines2[2].startsWith('P2·B3,Bo,'))

// ---- zero-submission question -> exactly one row, empty cells ---------------
const zeroSub = {
  revealed: false,
  questions: [
    { qid: 'lesson-2-0', answered: 0, firstCorrect: 0, latestCorrect: 0, medianMs: null, students: [] },
  ],
}
const csv3 = statsToCsv(zeroSub)
const lines3 = csv3.split('\r\n')
check('zero-submission question yields exactly one row', lines3.length === 2)
check('zero-submission row has empty student/answer/seconds cells', lines3[1] === 'P3·B1,,,,,,')

// ---- CSV escaping -------------------------------------------------------------
check('comma in a name is quoted', csvCell('Smith, John') === '"Smith, John"')
check('quotes in a value are doubled', csvCell('He said "hi"') === '"He said ""hi"""')

// ---- CSV injection guard ------------------------------------------------------
check("answer '-8' is prefixed with a single quote", csvCell('-8') === "'-8")
check("answer '=1+1' is prefixed with a single quote", csvCell('=1+1') === "'=1+1")

// exercise the guard end-to-end through statsToCsv, not just csvCell directly
const injectionStats = {
  revealed: false,
  questions: [
    {
      qid: 'lesson-3-0',
      answered: 1,
      firstCorrect: 0,
      latestCorrect: 0,
      medianMs: 100,
      students: [
        submission({ userId: 'u3', name: 'Smith, John', first: '-8', firstCorrect: false, latest: '=1+1', latestCorrect: false, elapsedMs: 8400 }),
      ],
    },
  ],
}
const csv4 = statsToCsv(injectionStats)
const row4 = csv4.split('\r\n')[1]
check(
  'full row: quoted name + guarded first/latest answers',
  row4 === 'P4·B1,"Smith, John",\'-8,no,\'=1+1,no,8.4',
)

// ---- first_correct / latest_correct render as yes/no --------------------------
const yesNoStats = {
  revealed: false,
  questions: [
    {
      qid: 'lesson-0-0',
      answered: 1,
      firstCorrect: 1,
      latestCorrect: 0,
      medianMs: 100,
      students: [submission({ firstCorrect: true, latestCorrect: false })],
    },
  ],
}
const yesNoRow = statsToCsv(yesNoStats).split('\r\n')[1]
check('first_correct/latest_correct render as yes/no', yesNoRow.includes(',yes,') && yesNoRow.endsWith(',no,1.0'))

// ---- seconds rounding -----------------------------------------------------
check('elapsedMs 8400 renders seconds as 8.4', row4.endsWith(',8.4'))

// ---- no BOM in statsToCsv output -------------------------------------------
check('statsToCsv output has no leading BOM', csv1.charCodeAt(0) !== 0xfeff)

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
