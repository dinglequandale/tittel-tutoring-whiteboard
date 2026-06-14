/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional tldraw license key to remove the "made with tldraw" watermark. */
  readonly VITE_TLDRAW_LICENSE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
