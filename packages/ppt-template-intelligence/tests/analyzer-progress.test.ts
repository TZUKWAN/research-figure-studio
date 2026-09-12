/**
 * GOAL §29: analyzer progress reporting + cancellation.
 */
import { describe, expect, it } from 'vitest'
import { analyzeTemplateBytes, observeTemplateFacts } from '../src/analyzer.js'
import { createBlankPptx, duplicateSlide, openPptx, savePptx } from '@genoffice/pptx-engine'

async function makeDeck(slides: number): Promise<Uint8Array> {
  let bytes = await createBlankPptx()
  let opened = await openPptx(bytes)
  for (let i = 1; i < slides; i++) {
    duplicateSlide(opened, 0)
    bytes = await savePptx(opened)
    opened = await openPptx(bytes)
  }
  return savePptx(opened)
}

const SOURCE = { type: 'gorden-local' } as const

describe('template analyzer progress + cancel (GOAL §29)', () => {
  it('reports one parse event per slide plus a final analyze event', async () => {
    const bytes = await makeDeck(3)
    const events: Array<{ stage: string; current: number; total: number }> = []
    const def = await analyzeTemplateBytes(bytes, SOURCE, undefined, {
      onProgress: (p) => events.push({ ...p }),
    })
    expect(def.pages).toHaveLength(3)
    expect(events.filter((e) => e.stage === 'parse').map((e) => e.current)).toEqual([1, 2, 3])
    const last = events[events.length - 1]!
    expect(last).toEqual({ stage: 'analyze', current: 1, total: 1 })
  })

  it('aborting before the call surfaces AbortError immediately', async () => {
    const bytes = await makeDeck(2)
    const controller = new AbortController()
    controller.abort()
    await expect(
      analyzeTemplateBytes(bytes, SOURCE, undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('aborting mid-parse surfaces AbortError and stops the walk', async () => {
    const bytes = await makeDeck(4)
    const controller = new AbortController()
    let seen = 0
    await expect(
      observeTemplateFacts(bytes, {
        signal: controller.signal,
        onProgress: () => {
          seen++
          if (seen === 2) controller.abort()
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen).toBeLessThanOrEqual(3) // abort takes effect at the next slide boundary
  })
})
