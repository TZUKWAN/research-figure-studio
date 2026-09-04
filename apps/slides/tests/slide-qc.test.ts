/**
 * Post-generation layout QC helpers:
 *  - generatedPageRange / mergeQcPages: which pages a landing marks for QC (incl. insert_at shifting)
 *  - createSlideFixSkill: tool allowlist wraps the full slides skill without losing the executor
 */
import { describe, it, expect } from 'vitest'
import type { AgentStreamRequest, AgentTransport } from '@genoffice/agent-core'
import {
  generatedPageRange,
  mergeQcPages,
  createSlideFixSkill,
  isUnsupportedImageInputError,
  isQcEnabled,
  qcSlidePage,
  settingsSupportVision,
  guardDeckAccess,
  restoreOwnedSnapshot,
} from '../src/renderer/ai/slide-qc'
import { defaultAiSettings, type AiProviderId } from '@genoffice/ai-provider'
import type { DeckAccess } from '../src/renderer/ai/slides-skill'

const access: DeckAccess = {
  getSlides: () => [],
  getCurrent: () => 0,
  getSelectedIds: () => [],
  applySlide: () => {},
  applyDeck: () => {},
  fitWidthPx: 1280,
}

describe('generatedPageRange', () => {
  it('replace covers the whole deck', () => {
    expect(generatedPageRange('replace', { pages: 3 })).toEqual([0, 1, 2])
  })

  it('append covers only the new tail', () => {
    expect(generatedPageRange('append', { pages: 5, appendedFrom: 3 })).toEqual([3, 4])
  })

  it('replace_at / insert_at cover the single touched page', () => {
    expect(generatedPageRange('replace_at', { pages: 5, insertedIndex: 2 })).toEqual([2])
    expect(generatedPageRange('insert_at', { pages: 5, insertedIndex: 0 })).toEqual([0])
  })

  it('missing insertedIndex yields nothing', () => {
    expect(generatedPageRange('insert_at', { pages: 5 })).toEqual([])
  })
})

describe('mergeQcPages', () => {
  it('replace discards earlier pendings', () => {
    expect(mergeQcPages([7, 8], 'replace', { pages: 2 })).toEqual([0, 1])
  })

  it('append unions and dedupes', () => {
    expect(mergeQcPages([1, 3], 'append', { pages: 5, appendedFrom: 3 })).toEqual([1, 3, 4])
  })

  it('insert_at shifts pendings at/after the insertion point', () => {
    expect(mergeQcPages([1, 3], 'insert_at', { pages: 5, insertedIndex: 2 })).toEqual([1, 2, 4])
  })

  it('replace_at adds the page without shifting', () => {
    expect(mergeQcPages([1], 'replace_at', { pages: 5, insertedIndex: 3 })).toEqual([1, 3])
  })
})

describe('createSlideFixSkill', () => {
  it('exposes only read_slide and execute_slide_script', () => {
    const skill = createSlideFixSkill(access)
    expect(skill.tools.map((t) => t.name).sort()).toEqual(['execute_slide_script', 'read_slide'])
  })

  it('delegates execution to the slides executor (read_slide works)', async () => {
    const one: DeckAccess = {
      ...access,
      getSlides: () => [
        {
          widthPx: 1280,
          heightPx: 720,
          nodes: [],
        } as never,
      ],
    }
    const skill = createSlideFixSkill(one)
    const r = await skill.executeTool({ id: 't1', name: 'read_slide', input: { slideIndex: 0 } })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('Canvas 1280×720px')
  })

  it('uses a geometry-only prompt when no screenshot can be sent', () => {
    const skill = createSlideFixSkill(access, false)
    expect(skill.systemPrompt).toContain('NO rendered screenshot is attached')
    expect(skill.systemPrompt).toContain('DO NOT judge or change contrast')
  })
})

describe('guardDeckAccess', () => {
  it('blocks QC writes after its owner becomes stale', () => {
    let current = true
    let slideWrites = 0
    let deckWrites = 0
    const guarded = guardDeckAccess(
      {
        ...access,
        applySlide: () => {
          slideWrites++
        },
        applyDeck: () => {
          deckWrites++
        },
      },
      () => current,
    )

    guarded.applySlide(0, {} as never)
    guarded.applyDeck([])
    current = false
    guarded.applySlide(0, {} as never)
    guarded.applyDeck([])

    expect(slideWrites).toBe(1)
    expect(deckWrites).toBe(1)
  })
})

describe('restoreOwnedSnapshot', () => {
  it('does not invoke the restore operation after its owner becomes stale', async () => {
    let restoreCalls = 0
    let applied = 0

    const result = await restoreOwnedSnapshot(
      7,
      async () => {
        restoreCalls++
        return []
      },
      () => false,
      () => {
        applied++
      },
    )

    expect(result).toBe('stale')
    expect(restoreCalls).toBe(0)
    expect(applied).toBe(0)
  })

  it('does not publish a restored deck when ownership expires during restore', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let current = true
    let applied = 0

    const resultPromise = restoreOwnedSnapshot(
      7,
      async () => {
        await pending
        return []
      },
      () => current,
      () => {
        applied++
      },
    )
    current = false
    release()

    expect(await resultPromise).toBe('stale')
    expect(applied).toBe(0)
  })
})

describe('isQcEnabled', () => {
  it("localStorage 'ai-slides-qc'='0' is the kill switch", () => {
    localStorage.removeItem('ai-slides-qc')
    expect(isQcEnabled()).toBe(true)
    localStorage.setItem('ai-slides-qc', '0')
    expect(isQcEnabled()).toBe(false)
    localStorage.removeItem('ai-slides-qc')
  })
})

describe('vision capability fallback', () => {
  it('uses the selected model when a provider mixes text and vision models', () => {
    const withProvider = (provider: AiProviderId) => ({ ...defaultAiSettings(), provider })
    const deepseek = withProvider('deepseek')
    expect(settingsSupportVision(deepseek)).toBe(false)
    deepseek.providers.deepseek.model = 'deepseek-v4-flash-vision-exp'
    expect(settingsSupportVision(deepseek)).toBe(true)
    expect(settingsSupportVision(withProvider('glm'))).toBe(false)
    expect(settingsSupportVision(withProvider('gemini'))).toBe(true)
  })

  it('does not send screenshots to text-only models under a vision-capable provider', () => {
    const settings = defaultAiSettings()
    settings.provider = 'anthropic'
    settings.providers.anthropic = { apiKey: '', model: '' }
    settings.providers.anthropic.model = 'deepseek-v4-flash'
    expect(settingsSupportVision(settings)).toBe(false)
    settings.providers.anthropic.model = 'claude-sonnet-5'
    expect(settingsSupportVision(settings)).toBe(true)
    // the explicit multimodal toggle overrides the model heuristic both ways
    settings.providers.anthropic.model = 'deepseek-v4-flash'
    settings.providers.anthropic.vision = true
    expect(settingsSupportVision(settings)).toBe(true)
    settings.providers.anthropic.vision = false
    settings.providers.anthropic.model = 'claude-sonnet-5'
    expect(settingsSupportVision(settings)).toBe(false)
  })

  it('recognizes image-capability errors from optimistic custom endpoints', () => {
    expect(isUnsupportedImageInputError('This model does not support image')).toBe(true)
    expect(isUnsupportedImageInputError('Vision input is not supported by this model')).toBe(true)
    expect(isUnsupportedImageInputError('HTTP 500: temporary provider failure')).toBe(false)
  })

  it('skips the model entirely when a geometry-only page passes the deterministic audit', async () => {
    let streamed = false
    const transport: AgentTransport = {
      stream: () => {
        streamed = true
        return { cancel: () => {} }
      },
    }
    const one: DeckAccess = {
      ...access,
      getSlides: () => [
        {
          widthPx: 1280,
          heightPx: 720,
          scale: 1,
          nodes: [],
        } as never,
      ],
    }
    const result = await qcSlidePage({
      access: one,
      transport,
      pageIndex: 0,
      screenshot: null,
    })
    expect(result).toMatchObject({ ok: true, edited: false, reply: 'OK' })
    expect(streamed).toBe(false)
  })

  it('runs an audited geometry issue without attaching an image', async () => {
    let request: AgentStreamRequest | undefined
    const transport: AgentTransport = {
      stream: (next, callbacks) => {
        request = next
        queueMicrotask(() => {
          callbacks.onDelta('OK')
          callbacks.onDone()
        })
        return { cancel: () => {} }
      },
    }
    const one: DeckAccess = {
      ...access,
      getSlides: () => [
        {
          widthPx: 1280,
          heightPx: 720,
          scale: 1,
          nodes: [
            {
              type: 'picture',
              sourceId: 'picture-1',
              box: { x: 1270, y: 20, w: 100, h: 100, rotationDeg: 0 },
            },
          ],
        } as never,
      ],
    }
    const result = await qcSlidePage({
      access: one,
      transport,
      pageIndex: 0,
      screenshot: null,
    })
    expect(result.error).toBeUndefined()
    const message = request?.messages[0]
    expect(message).toMatchObject({ role: 'user' })
    expect(message).not.toHaveProperty('images')
    expect(request?.system).toContain('NO rendered screenshot is attached')
    expect(message?.role === 'user' ? message.text : '').toContain('No image is attached')
  })
})
