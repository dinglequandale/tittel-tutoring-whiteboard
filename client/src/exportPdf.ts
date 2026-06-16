import { jsPDF } from 'jspdf'
import type { Editor } from 'tldraw'

// Exports the whole board — every page — to a multi-page PDF so students can keep
// exactly what was worked on after the ephemeral room is gone. tldraw's export is
// per-page, so we walk the pages and render each to a high-res PNG, then give each
// PDF page that board page's natural content aspect ratio (rather than forcing a
// fixed paper size, which would shrink an expansive page into illegible mush).
// Exporting reads shapes by page id, so it never switches the tutor's current
// page (students following along don't get yanked around).

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function exportBoardToPdf(editor: Editor, filename = 'whiteboard.pdf'): Promise<number> {
  const pages = editor.getPages()
  let pdf: jsPDF | null = null
  let exported = 0

  for (const page of pages) {
    const ids = [...editor.getPageShapeIds(page.id)]
    if (ids.length === 0) continue // skip empty pages (e.g. a blank scratch page)

    const { blob, width, height } = await editor.toImage(ids, {
      format: 'png',
      background: true,
      padding: 40,
      pixelRatio: 2,
    })
    const dataUrl = await blobToDataUrl(blob)

    // jsPDF takes the format in portrait spec [short, long] and swaps it for
    // landscape, so this lands the page at exactly [width, height] either way.
    const shorter = Math.min(width, height)
    const longer = Math.max(width, height)
    const orientation = width >= height ? 'landscape' : 'portrait'
    const format: [number, number] = [shorter, longer]

    if (!pdf) pdf = new jsPDF({ unit: 'px', format, orientation, compress: true })
    else pdf.addPage(format, orientation)

    pdf.addImage(dataUrl, 'PNG', 0, 0, width, height)
    exported++
  }

  if (!pdf) throw new Error('Nothing to export yet — the board is empty.')
  pdf.save(filename)
  return exported
}
