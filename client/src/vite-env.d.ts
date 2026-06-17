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

// KaTeX's auto-render contrib extension ships no types of its own.
declare module 'katex/dist/contrib/auto-render' {
  export interface RenderMathInElementOptions {
    delimiters?: Array<{ left: string; right: string; display: boolean }>
    throwOnError?: boolean
    errorColor?: string
  }
  export default function renderMathInElement(
    el: HTMLElement,
    options?: RenderMathInElementOptions,
  ): void
}
