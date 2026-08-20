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
//
// Lockers gets the same treatment with its own markers — 'the perfect
// squares!' (the completion-reveal text, unique to LockersGame.tsx) and
// 'locker-number' (a CSS class unique to its board) — plus an extra check
// that its chunk is a DIFFERENT file from Nim's, since registry.ts's whole
// point is a lazy() boundary per game, not just "not the entry bundle".
//
// Pizza gets the same treatment too, with 'pizza-pepperoni' (a CSS class
// unique to its board, used as a JSX className so it lands in the JS chunk —
// unlike a keyframe name, which Vite extracts into a separate .css asset
// this test doesn't scan) and 'is making cut #' (banner text unique to
// PizzaGame.tsx) as markers, checked against both Nim's and Lockers' chunks.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '../client/dist')
const assetsDir = path.join(distDir, 'assets')
const indexHtmlPath = path.join(distDir, 'index.html')

const MARKERS = ['No winning move', 'nim-token']
const LOCKERS_MARKERS = ['the perfect squares!', 'locker-number']
const PIZZA_MARKERS = ['pizza-pepperoni', 'is making cut #']
// Balance: 'balance-stone' (a JSX className unique to its board) and the exact
// tutor-hint text (a string literal unique to BalanceGame.tsx).
const BALANCE_MARKERS = ['balance-stone', 'No winning move — balanced']
// Coins: 'coins-coin' (a JSX className unique to its board) and the exact
// mirror-hint text (a string literal unique to CoinsGame.tsx).
const COINS_MARKERS = ['coins-coin', 'Copy the last coin through the center']
// Water: 'water-jug' (a JSX className unique to its board) and the exact
// opponent-status text (a string literal unique to WaterGame.tsx).
const WATER_MARKERS = ['water-jug', 'still pouring']
// Sim: 'sim-edge-hit' (the className on each segment's wide invisible click
// target, unique to SimGame.tsx) and the draw headline — the outcome the whole
// lesson turns on, and a string literal unique to that module.
const SIM_MARKERS = ['sim-edge-hit', 'Nobody made a triangle']

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

for (const marker of LOCKERS_MARKERS) {
  check(`entry chunk does NOT contain ${JSON.stringify(marker)}`, !entrySrc.includes(marker))
}

for (const marker of PIZZA_MARKERS) {
  check(`entry chunk does NOT contain ${JSON.stringify(marker)}`, !entrySrc.includes(marker))
}

for (const marker of BALANCE_MARKERS) {
  check(`entry chunk does NOT contain ${JSON.stringify(marker)}`, !entrySrc.includes(marker))
}

for (const marker of COINS_MARKERS) {
  check(`entry chunk does NOT contain ${JSON.stringify(marker)}`, !entrySrc.includes(marker))
}

for (const marker of WATER_MARKERS) {
  check(`entry chunk does NOT contain ${JSON.stringify(marker)}`, !entrySrc.includes(marker))
}

for (const marker of SIM_MARKERS) {
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

const otherChunksWithLockers = jsFiles.filter((f) => {
  if (f === entryFile) return false
  const src = fs.readFileSync(path.join(assetsDir, f), 'utf8')
  return LOCKERS_MARKERS.every((m) => src.includes(m))
})
check(
  'a SEPARATE (non-entry) chunk contains every Lockers marker — Lockers actually split out',
  otherChunksWithLockers.length > 0,
)
check(
  "Lockers' chunk is a DIFFERENT file from Nim's — each game got its own lazy() boundary, not a shared one",
  otherChunksWithNim.length > 0 &&
    otherChunksWithLockers.length > 0 &&
    otherChunksWithNim.every((f) => !otherChunksWithLockers.includes(f)),
)

const otherChunksWithPizza = jsFiles.filter((f) => {
  if (f === entryFile) return false
  const src = fs.readFileSync(path.join(assetsDir, f), 'utf8')
  return PIZZA_MARKERS.every((m) => src.includes(m))
})
check(
  'a SEPARATE (non-entry) chunk contains every Pizza marker — Pizza actually split out',
  otherChunksWithPizza.length > 0,
)
check(
  "Pizza's chunk is a DIFFERENT file from Nim's and Lockers' — each game got its own lazy() boundary, not a shared one",
  otherChunksWithPizza.length > 0 &&
    otherChunksWithNim.every((f) => !otherChunksWithPizza.includes(f)) &&
    otherChunksWithLockers.every((f) => !otherChunksWithPizza.includes(f)),
)

const otherChunksWithBalance = jsFiles.filter((f) => {
  if (f === entryFile) return false
  const src = fs.readFileSync(path.join(assetsDir, f), 'utf8')
  return BALANCE_MARKERS.every((m) => src.includes(m))
})
check(
  'a SEPARATE (non-entry) chunk contains every Balance marker — Balance actually split out',
  otherChunksWithBalance.length > 0,
)
check(
  "Balance's chunk is its own file, distinct from Nim/Lockers/Pizza",
  otherChunksWithBalance.length > 0 &&
    otherChunksWithNim.every((f) => !otherChunksWithBalance.includes(f)) &&
    otherChunksWithLockers.every((f) => !otherChunksWithBalance.includes(f)) &&
    otherChunksWithPizza.every((f) => !otherChunksWithBalance.includes(f)),
)

const otherChunksWithCoins = jsFiles.filter((f) => {
  if (f === entryFile) return false
  const src = fs.readFileSync(path.join(assetsDir, f), 'utf8')
  return COINS_MARKERS.every((m) => src.includes(m))
})
check(
  'a SEPARATE (non-entry) chunk contains every Coins marker — Coins actually split out',
  otherChunksWithCoins.length > 0,
)
check(
  "Coins' chunk is its own file, distinct from Nim/Lockers/Pizza/Balance",
  otherChunksWithCoins.length > 0 &&
    otherChunksWithNim.every((f) => !otherChunksWithCoins.includes(f)) &&
    otherChunksWithLockers.every((f) => !otherChunksWithCoins.includes(f)) &&
    otherChunksWithPizza.every((f) => !otherChunksWithCoins.includes(f)) &&
    otherChunksWithBalance.every((f) => !otherChunksWithCoins.includes(f)),
)

const otherChunksWithWater = jsFiles.filter((f) => {
  if (f === entryFile) return false
  const src = fs.readFileSync(path.join(assetsDir, f), 'utf8')
  return WATER_MARKERS.every((m) => src.includes(m))
})
check(
  'a SEPARATE (non-entry) chunk contains every Water marker — Water actually split out',
  otherChunksWithWater.length > 0,
)
check(
  "Water's chunk is its own file, distinct from Nim/Lockers/Pizza/Balance/Coins",
  otherChunksWithWater.length > 0 &&
    otherChunksWithNim.every((f) => !otherChunksWithWater.includes(f)) &&
    otherChunksWithLockers.every((f) => !otherChunksWithWater.includes(f)) &&
    otherChunksWithPizza.every((f) => !otherChunksWithWater.includes(f)) &&
    otherChunksWithBalance.every((f) => !otherChunksWithWater.includes(f)) &&
    otherChunksWithCoins.every((f) => !otherChunksWithWater.includes(f)),
)

const otherChunksWithSim = jsFiles.filter((f) => {
  if (f === entryFile) return false
  const src = fs.readFileSync(path.join(assetsDir, f), 'utf8')
  return SIM_MARKERS.every((m) => src.includes(m))
})
check(
  'a SEPARATE (non-entry) chunk contains every Sim marker — Sim actually split out',
  otherChunksWithSim.length > 0,
)
check(
  "Sim's chunk is its own file, distinct from Nim/Lockers/Pizza/Balance/Coins/Water",
  otherChunksWithSim.length > 0 &&
    otherChunksWithNim.every((f) => !otherChunksWithSim.includes(f)) &&
    otherChunksWithLockers.every((f) => !otherChunksWithSim.includes(f)) &&
    otherChunksWithPizza.every((f) => !otherChunksWithSim.includes(f)) &&
    otherChunksWithBalance.every((f) => !otherChunksWithSim.includes(f)) &&
    otherChunksWithCoins.every((f) => !otherChunksWithSim.includes(f)) &&
    otherChunksWithWater.every((f) => !otherChunksWithSim.includes(f)),
)

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
