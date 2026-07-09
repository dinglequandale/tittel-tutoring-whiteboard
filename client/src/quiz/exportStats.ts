// CSV export of live answer statistics, so a tutor can keep the numbers after the
// room is destroyed (rooms are in-memory and die ~30s after the last person
// leaves — see the PDF export ritual in exportPdf.ts for the same idea applied
// to the board itself).
//
// `statsToCsv` is pure and DOM-free on purpose so it can be unit-tested with
// plain node (see test/exportStats.mjs). `downloadStatsCsv` is the thin browser
// shim that actually triggers the file save.
import type { QuizStats, Submission } from '../../../shared/quiz.ts'

/** `lesson-0-3` (page 0, block 3) -> `P1·B4`. Ids are 0-based; the tutor counts
 * pages/blocks from 1. Anything not matching that shape renders as-is. */
export function formatQid(qid: string): string {
  const m = /^lesson-(\d+)-(\d+)$/.exec(qid)
  return m ? `P${Number(m[1]) + 1}·B${Number(m[2]) + 1}` : qid
}

// Leading characters that Excel/Sheets will interpret as the start of a formula
// if a cell isn't otherwise protected. A grid-in answer of `-8` or `=1+1` would
// otherwise silently turn into a formula when the CSV is opened.
const FORMULA_LEAD = /^[=+\-@\t\r]/

/**
 * Escapes a single CSV field per RFC 4180 (quote if it contains a comma,
 * double-quote, CR or LF; double any internal quotes) and neutralizes leading
 * formula characters that spreadsheet apps auto-execute (CSV injection guard).
 */
export function csvCell(value: string): string {
  let v = value
  if (FORMULA_LEAD.test(v)) v = `'${v}`
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`
  return v
}

function yesNo(b: boolean): string {
  return b ? 'yes' : 'no'
}

function secondsCell(elapsedMs: number): string {
  return (elapsedMs / 1000).toFixed(1)
}

const HEADER = ['question', 'student', 'first_answer', 'first_correct', 'latest_answer', 'latest_correct', 'seconds']

function studentRow(qLabel: string, s: Submission): string[] {
  return [
    qLabel,
    s.name,
    s.first,
    yesNo(s.firstCorrect),
    s.latest,
    yesNo(s.latestCorrect),
    secondsCell(s.elapsedMs),
  ]
}

/** One row per (question, student), in question order then student order. Pure — no DOM. */
export function statsToCsv(stats: QuizStats, _opts?: { title?: string }): string {
  const lines: string[] = [HEADER.map(csvCell).join(',')]

  for (const q of stats.questions) {
    const qLabel = formatQid(q.qid)
    if (q.students.length === 0) {
      // A question nobody answered still gets a row — otherwise it silently
      // vanishes from the export, which is exactly what a tutor most wants to see.
      lines.push([qLabel, '', '', '', '', '', ''].map(csvCell).join(','))
      continue
    }
    for (const s of q.students) {
      lines.push(studentRow(qLabel, s).map(csvCell).join(','))
    }
  }

  return lines.join('\r\n')
}

/** Triggers a browser download of `statsToCsv(stats)`. */
export function downloadStatsCsv(stats: QuizStats, filename?: string): void {
  const BOM = '﻿'
  const csv = BOM + statsToCsv(stats)
  const name = filename ?? `answers-${new Date().toISOString().slice(0, 10)}.csv`

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
