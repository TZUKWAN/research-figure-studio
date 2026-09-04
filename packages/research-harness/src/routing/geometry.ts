/** Shared pixel-space geometry primitives (top-left origin, px at 96dpi). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function rectCenter(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
  )
}
