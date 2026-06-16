import { toBlob } from 'html-to-image'
import renderMathInElement from 'katex/dist/contrib/auto-render'
import 'katex/dist/katex.min.css'
import type { LessonBlock } from './schema'

// Renders a lesson block to a crisp raster image plus its on-canvas size.
//  - 'latex'/'text' blocks: laid out as an offscreen HTML "card" (prose with
//    inline `$...$` and display `$$...$$` math via KaTeX auto-render), then
//    rasterized at high pixel ratio so it stays sharp when zoomed.
//  - 'image' blocks: the source is used directly; we only measure it.
// Raster (not SVG) is the pragmatic, reliable choice for mixed prose+math; the
// 3x pixel ratio keeps it crisp, and a board PDF export embeds it cleanly.

const PIXEL_RATIO = 3

// html-to-image's first capture is often blank until web fonts are decoded and
// embedded; we warm that cache exactly once.
let fontsWarmed = false

export interface RenderedBlock {
  /** PNG image data to upload as an asset; null for 'image' blocks (use `src`). */
  blob: Blob | null
  /** Source URL for 'image' blocks (passed through untouched). */
  src: string | null
  /** On-canvas (logical px) size for layout + the tldraw shape. */
  w: number
  h: number
  mimeType: string
}

// The captured node (`card`) is positioned *statically*; the off-screen offset
// lives on an outer wrapper. This matters: html-to-image clones the captured
// node into an SVG <foreignObject>, and any `position/left` on that node would
// shift its content out of the foreignObject's viewport — producing a correctly
// sized but blank-white image. Keeping the offset on the wrapper avoids that.
function buildCard(block: LessonBlock): { wrapper: HTMLDivElement; card: HTMLDivElement } {
  const wrapper = document.createElement('div')
  Object.assign(wrapper.style, {
    position: 'fixed',
    left: '-99999px',
    top: '0',
    pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>)

  const card = document.createElement('div')
  Object.assign(card.style, {
    boxSizing: 'border-box',
    width: 'fit-content',
    maxWidth: `${block.maxWidth}px`,
    padding: '16px 20px',
    background: '#ffffff',
    color: '#0f172a',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: block.kind === 'heading' ? '30px' : '21px',
    fontWeight: block.kind === 'heading' ? '700' : '400',
    lineHeight: '1.5',
    whiteSpace: 'normal',
    wordBreak: 'break-word',
  } as Partial<CSSStyleDeclaration>)

  // Preserve author line breaks while keeping the text as real text nodes so
  // KaTeX auto-render can find the `$...$` math inside them.
  const lines = (block.content ?? '').split('\n')
  lines.forEach((line, i) => {
    if (i > 0) card.appendChild(document.createElement('br'))
    card.appendChild(document.createTextNode(line))
  })

  wrapper.appendChild(card)
  return { wrapper, card }
}

async function renderTextual(block: LessonBlock): Promise<RenderedBlock> {
  const { wrapper, card } = buildCard(block)
  document.body.appendChild(wrapper)
  try {
    renderMathInElement(card, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
    })
    // KaTeX uses custom web fonts; make sure they're decoded before capture.
    if (document.fonts?.ready) await document.fonts.ready
    // Force layout, then measure the settled card.
    const w = card.offsetWidth
    const h = card.offsetHeight
    const opts = { pixelRatio: PIXEL_RATIO, backgroundColor: '#ffffff', cacheBust: true }
    // Warm the font/style cache once — the first html-to-image pass is otherwise
    // prone to coming back blank.
    if (!fontsWarmed) {
      await toBlob(card, opts)
      fontsWarmed = true
    }
    const blob = await toBlob(card, opts)
    if (!blob) throw new Error('Failed to rasterize lesson block')
    return { blob, src: null, w, h, mimeType: 'image/png' }
  } finally {
    wrapper.remove()
  }
}

function measureImage(block: LessonBlock): Promise<RenderedBlock> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const natW = img.naturalWidth || block.maxWidth
      const natH = img.naturalHeight || block.maxWidth
      const w = Math.min(natW, block.maxWidth)
      const h = (natH / natW) * w
      resolve({ blob: null, src: block.src!, w, h, mimeType: 'image/*' })
    }
    img.onerror = () => reject(new Error(`Could not load image: ${block.src}`))
    img.src = block.src!
  })
}

export function renderBlock(block: LessonBlock): Promise<RenderedBlock> {
  return block.type === 'image' ? measureImage(block) : renderTextual(block)
}
