import { AssetRecordType, PageRecordType, createShapeId, type Editor, type TLPageId } from 'tldraw'
import { nanoid } from 'nanoid'
import { parseLessonDoc } from './schema'
import { renderBlock } from './render'
import { computeLayout, blockId, pageId } from './layout'

// Host-side injection of a lesson into the live, synced tldraw store. Because the
// store is synced, every student sees the pages/blocks appear automatically — no
// separate broadcast needed. Lesson pages are tagged in `meta` so re-loading
// (e.g. after a host refresh) cleanly replaces the previous lesson instead of
// duplicating it. Nothing is persisted: it lives only in the ephemeral room.

async function uploadAsset(roomId: string, blob: Blob): Promise<string> {
  const id = `${nanoid()}-lesson.png`
  const url = `/uploads/${encodeURIComponent(roomId)}/${encodeURIComponent(id)}`
  const res = await fetch(url, {
    method: 'POST',
    body: blob,
    headers: { 'content-type': blob.type || 'image/png' },
  })
  if (!res.ok) throw new Error(`Failed to upload lesson image: ${res.status}`)
  return url
}

/** Remove any previously injected lesson pages, standing on a safe page first. */
function clearPreviousLesson(editor: Editor) {
  const pages = editor.getPages()
  const lessonPages = pages.filter((p) => p.meta?.lesson === true)
  if (lessonPages.length === 0) return

  const keep = pages.find((p) => p.meta?.lesson !== true)
  const standOn: TLPageId = keep
    ? keep.id
    : (() => {
        const scratch = PageRecordType.createId(`scratch-${nanoid()}`)
        editor.createPage({ id: scratch, name: 'Untitled' })
        return scratch
      })()
  if (editor.getCurrentPageId() !== standOn) editor.setCurrentPage(standOn)
  for (const p of lessonPages) editor.deletePage(p.id)
}

export interface LoadResult {
  pages: number
  blocks: number
}

/**
 * Parse a raw lesson JSON value, render every block, and inject the whole thing
 * as tldraw pages + image shapes. `onProgress` reports rendering progress so the
 * UI can show "rendering 3/12".
 */
export async function loadLesson(
  editor: Editor,
  roomId: string,
  raw: unknown,
  onProgress?: (done: number, total: number) => void,
): Promise<LoadResult> {
  const doc = parseLessonDoc(raw)
  const total = doc.pages.reduce((n, p) => n + p.blocks.length, 0)

  // 1. Render + upload every block, collecting measures keyed by page/block.
  type Built = { url: string; w: number; h: number; mimeType: string }
  const built = new Map<string, Built>()
  let done = 0
  for (let pi = 0; pi < doc.pages.length; pi++) {
    for (let bi = 0; bi < doc.pages[pi].blocks.length; bi++) {
      const block = doc.pages[pi].blocks[bi]
      const rendered = await renderBlock(block)
      const url = rendered.blob ? await uploadAsset(roomId, rendered.blob) : rendered.src!
      built.set(`${pi}:${bi}`, { url, w: rendered.w, h: rendered.h, mimeType: rendered.mimeType })
      onProgress?.(++done, total)
    }
  }

  // 2. Compute flow positions from the measured sizes.
  const placed = computeLayout(doc, (pi, bi) => built.get(`${pi}:${bi}`))

  // 3. Inject. Replace any prior lesson first, then create pages + assets + shapes
  //    inside a single history mark so it's one undo step.
  editor.run(() => {
    clearPreviousLesson(editor)

    for (const page of placed) {
      const tlPageId = PageRecordType.createId(pageId(page.pageIndex))
      editor.createPage({ id: tlPageId, name: page.label, meta: { lesson: true } })

      for (const pb of page.blocks) {
        const info = built.get(`${page.pageIndex}:${pb.blockIndex}`)!
        const assetId = AssetRecordType.createId(nanoid())
        editor.createAssets([
          {
            id: assetId,
            typeName: 'asset',
            type: 'image',
            props: {
              name: blockId(page.pageIndex, pb.blockIndex),
              src: info.url,
              w: pb.w,
              h: pb.h,
              mimeType: info.mimeType || 'image/png',
              isAnimated: false,
            },
            meta: {},
          },
        ])
        editor.createShape({
          id: createShapeId(blockId(page.pageIndex, pb.blockIndex)),
          type: 'image',
          parentId: tlPageId,
          x: pb.x,
          y: pb.y,
          isLocked: true, // lesson content shouldn't be nudged by stray clicks
          props: { assetId, w: pb.w, h: pb.h },
        })
      }
    }
  })

  // Land the tutor on the first lesson page (page-follow then carries students).
  if (placed.length > 0) {
    editor.setCurrentPage(PageRecordType.createId(pageId(placed[0].pageIndex)))
  }

  return { pages: placed.length, blocks: total }
}
