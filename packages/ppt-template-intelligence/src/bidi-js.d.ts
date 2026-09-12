/**
 * Ambient types for bidi-js (ships no declarations).
 * Must stay signature-compatible with packages/pptx-render/src/bidi-js.d.ts —
 * when pptx-render sources are compiled inside this project, this ambient
 * module is the one that applies.
 */
declare module 'bidi-js' {
  interface BidiApi {
    getEmbeddingLevels(
      text: string,
      explicitDirection?: 'ltr' | 'rtl',
    ): { levels: Uint8Array; paragraphs: Array<{ start: number; end: number; level: number }> }
    getReorderSegments(...args: unknown[]): unknown
    getMirroredCharacter?(ch: string): string | undefined
  }
  export default function bidiFactory(): BidiApi
}
