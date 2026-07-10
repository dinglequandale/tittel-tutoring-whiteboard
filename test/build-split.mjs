// Build-time assertion that the game library is truly lazy (games-spec.md's
// "Zero cost when unused" requirement). Run AFTER `npm run build`:
//   node test/build-split.mjs
//
// Entry-chunk detection: a browser only ever executes the entry chunk that
// client/dist/index.html points at via <script type="module" src="...">. We
// read that filename straight out of the built index.html (the same way a
// browser resolves it) rather than guessing "the biggest chunk" or pattern-
// matching Vite's hashed filenames.
//
// Marker choice — NOT identifier names: the spec's first draft of this test
// checked for the literal strings 'optimalNimMove' and 'NimGame'. Verified
// against a real `npm run build` output, that doesn't work — this project's
// production build minifies with esbuild, which renames every top-level
// function/identifier (optimalNimMove -> `T`, the NimGame component -> `y`,
// etc.) in EVERY chunk, entry or not. Checking for those identifiers would
// make check (b) below fail unconditionally, even on a correctly-split
// build (confirmed: neither string appears anywhere in client/dist/assets
// after a real build). Minification does NOT rename string literals, so we
// instead key on markers that are string literals in the source, guaranteed
// byte-for-byte stable across minification:
//   - 'No winning move' — the exact text NimGame.tsx renders when
//     `optimalNimMove` returns null (the tutor-only hint chip). This is the
//     most direct stand-in for "the hint logic executed here" the spec cares
//     about isolating.
//   - 'nim-token' — the CSS class on each clickable pile token, unique to
//     Nim's board and present only inside NimGame.tsx.
// Either marker appearing in the entry chunk would mean Nim's UI/rules leaked
// into the always-loaded bundle; both should appear together in whichever
// separate chunk Nim split into.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '../client/dist')
const assetsDir = path.join(distDir, 'assets')
const indexHtmlPath = path.join(distDir, 'index.html')

const MARKERS = ['No winning move', 'nim-token']

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

if (!fs.existsSync(indexHtmlPath)) {
  console.error(`Missing ${indexHtmlPath} — run "npm run build" first.`)
  process.exit(1)
}
if (!fs.existsSync(assetsDir)) {
  console.error(`Missing ${assetsDir} — run "npm run build" first.`)
  process.exit(1)
}

const html = fs.readFileSync(indexHtmlPath, 'utf8')
const scriptMatch = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)
if (!scriptMatch) {
  console.error('Could not find the entry <script type="module" src="..."> tag in index.html.')
  process.exit(1)
}
// src is an absolute path like "/assets/index-AbC123.js" — only the basename
// matters, since we read straight from client/dist/assets on disk.
const entryFile = path.basename(scriptMatch[1])
const entryPath = path.join(assetsDir, entryFile)
check(`entry chunk file exists on disk (${entryFile})`, fs.existsSync(entryPath))

const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
check('found at least one built JS chunk', jsFiles.length > 0)

const entrySrc = fs.readFileSync(entryPath, 'utf8')
for (const marker of MARKERS) {
  check(`entry chunk does NOT contain ${JSON.stringify(marker)}`, !entrySrc.includes(marker))
}

const otherChunksWithNim = jsFiles.filter((f) => {
  if (f === entryFile) return false
  const src = fs.readFileSync(path.join(assetsDir, f), 'utf8')
  return MARKERS.every((m) => src.includes(m))
})
check(
  'a SEPARATE (non-entry) chunk contains every Nim marker — Nim actually split out',
  otherChunksWithNim.length > 0,
)

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
