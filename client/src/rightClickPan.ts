import type { Editor } from 'tldraw'

// Tutor convenience: hold the RIGHT mouse button and drag to pan the canvas,
// instead of the default space-drag / hand-tool. The browser context menu is
// suppressed while we're on the board. Students don't need this — their camera
// is locked to the tutor's anyway.
export function setupRightClickPan(editor: Editor): () => void {
  const container = editor.getContainer()
  let panning = false
  let lastX = 0
  let lastY = 0

  const onContextMenu = (e: MouseEvent) => e.preventDefault()

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 2) return
    panning = true
    lastX = e.clientX
    lastY = e.clientY
    e.preventDefault()
    e.stopPropagation()
    try {
      container.setPointerCapture(e.pointerId)
    } catch {
      /* not all targets support capture */
    }
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!panning) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    const cam = editor.getCamera()
    // Screen pixels -> page units (divide by zoom). Dragging right pushes the
    // canvas right under the cursor, like grabbing the paper.
    editor.setCamera({ x: cam.x + dx / cam.z, y: cam.y + dy / cam.z, z: cam.z }, { immediate: true })
    e.preventDefault()
    e.stopPropagation()
  }

  const endPan = (e: PointerEvent) => {
    if (!panning) return
    panning = false
    try {
      container.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  container.addEventListener('contextmenu', onContextMenu)
  container.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', endPan, true)

  return () => {
    container.removeEventListener('contextmenu', onContextMenu)
    container.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', endPan, true)
  }
}
