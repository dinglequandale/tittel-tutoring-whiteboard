/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional tldraw license key to remove the "made with tldraw" watermark. */
  readonly VITE_TLDRAW_LICENSE_KEY?: string
  /** Optional Desmos API key (defaults to Desmos's public demo key). */
  readonly VITE_DESMOS_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
