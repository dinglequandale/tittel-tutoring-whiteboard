import type { TLAssetStore } from 'tldraw'
import { nanoid } from 'nanoid'

// Assets (pasted/dropped images, including a problem screenshot from online) are
// uploaded to our server's in-memory per-room store and served back by URL.
// Nothing is persisted to disk — assets die with the room, like everything else.
export function makeAssetStore(roomId: string): TLAssetStore {
  return {
    async upload(_asset, file) {
      const id = `${nanoid()}-${file.name || 'asset'}`
      const url = `/uploads/${encodeURIComponent(roomId)}/${encodeURIComponent(id)}`
      const res = await fetch(url, {
        method: 'POST',
        body: file,
        headers: { 'content-type': file.type || 'application/octet-stream' },
      })
      if (!res.ok) {
        throw new Error(`Failed to upload asset: ${res.status}`)
      }
      return { src: url }
    },
    resolve(asset) {
      return asset.props.src
    },
  }
}
