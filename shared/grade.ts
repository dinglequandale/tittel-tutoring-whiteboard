// Pure, dependency-free, DOM-free answer grading. Imported by BOTH client/
// (for optimistic/instant feedback) and server/ (for the authoritative grade
// that actually determines `firstCorrect`/`latestCorrect`). Keep this file
// free of any browser or Node-only APIs so it can be loaded by Vite and by
// `tsx` unchanged.
import type { QuestionKey } from './quiz.ts'

const UNICODE_MINUS_OR_DASH = /[−–]/g

/**
 * Normalizes a raw student (or key) answer string for comparison:
 * trims, strips all internal whitespace, converts Unicode minus (U+2212)
 * and en-dash (U+2013) to ASCII '-', strips a single leading '+', and
 * strips surrounding parentheses (so "(A)" -> "A"). Does NOT lowercase —
 * callers decide whether the comparison should be case-sensitive.
 */
export function normalizeAnswer(raw: string): string {
  let s = raw.trim()
  s = s.replace(/\s+/g, '')
  s = s.replace(UNICODE_MINUS_OR_DASH, '-')
  if (s.startsWith('+')) s = s.slice(1)
  if (s.length >= 2 && s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1)
  return s
}

/** Matches a plain decimal: `8`, `-3.5`, `.5`, with an optional leading '-'. */
const DECIMAL_RE = /^-?\d*\.?\d+$/

/**
 * Parses a grid-in numeric value: either a plain decimal or a simple
 * `a/b` fraction (each side a decimal with an optional leading '-').
 * Returns null when unparseable, including on division by zero and on
 * empty input — deliberately checked first, since `Number('')` is 0 in
 * JS and would otherwise silently grade a blank answer as correct.
 */
function parseGridNumber(s: string): number | null {
  if (s === '') return null
  const fraction = s.match(/^(-?\d*\.?\d+)\/(-?\d*\.?\d+)$/)
  if (fraction) {
    if (!DECIMAL_RE.test(fraction[1]) || !DECIMAL_RE.test(fraction[2])) return null
    const num = Number(fraction[1])
    const den = Number(fraction[2])
    if (den === 0) return null
    return num / den
  }
  if (!DECIMAL_RE.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Grades a student's answer against the host-held key.
 *
 * - 'choice': normalize both sides and compare case-insensitively. Does
 *   NOT validate against `key.choices` — enforcing which letters are
 *   selectable is the UI's job, not the grader's.
 * - 'grid': normalize both sides. Correct if they match verbatim
 *   (case-insensitively) against the key or any `key.accept` entry, OR if
 *   both sides parse as numbers (plain decimal or `a/b` fraction) that
 *   agree within a 0.1% relative tolerance.
 *
 *   The 1e-3 relative tolerance exists to accept the SAT's grid-in
 *   convention where a repeating decimal may be entered truncated or
 *   rounded to ~4 significant digits — for key `2/3` (0.6666...), both
 *   `.6666` and `.6667` should pass — while still rejecting coarser
 *   roundings like `.67`.
 */
export function gradeAnswer(value: string, key: QuestionKey): boolean {
  const v = normalizeAnswer(value)
  const k = normalizeAnswer(key.key)

  if (key.format === 'choice') {
    return v.toLowerCase() === k.toLowerCase()
  }

  // 'grid'
  if (v.toLowerCase() === k.toLowerCase()) return true
  if (key.accept) {
    for (const literal of key.accept) {
      if (v.toLowerCase() === normalizeAnswer(literal).toLowerCase()) return true
    }
  }

  const vn = parseGridNumber(v)
  const kn = parseGridNumber(k)
  if (vn === null || kn === null) return false
  return Math.abs(vn - kn) <= 1e-3 * Math.max(1, Math.abs(kn))
}
