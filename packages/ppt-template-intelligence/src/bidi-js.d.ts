declare module 'bidi-js' {
  export interface BidiApi {
    getEmbeddingLevels(text: string, baseDirection?: string): unknown
    getReorderSegments(...args: unknown[]): unknown
    getMirroredCharacter?(ch: string): string | undefined
  }
  export default function bidiFactory(): BidiApi
}
