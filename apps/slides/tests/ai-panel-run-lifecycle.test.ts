import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('react-konva', () => {
  const stub = () => null
  return {
    Stage: stub,
    Layer: stub,
    Rect: stub,
    Group: stub,
    Transformer: stub,
    Line: stub,
    Arrow: stub,
    Text: stub,
    Ellipse: stub,
    Image: stub,
    Path: stub,
    Circle: stub,
    Arc: stub,
  }
})

import { AiPanel } from '../src/renderer/ai/AiPanel'
import { AI_PROVIDERS, type AiSettings } from '../src/shared/ipc'

const settings: AiSettings = {
  provider: 'anthropic',
  providers: Object.fromEntries(
    AI_PROVIDERS.map((p) => [p.id, { apiKey: '', model: p.defaultModel }]),
  ) as AiSettings['providers'],
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function installApis(options: {
  readImage?: (path: string) => Promise<unknown>
  finishStream: boolean
  endHistoryBatch?: () => Promise<number>
}) {
  let listener: ((chunk: { requestId: string; type: 'done' }) => void) | null = null
  let activeRequestId: string | null = null
  const emitDone = (requestId = activeRequestId) => {
    if (requestId) listener?.({ requestId, type: 'done' })
  }
  const slidesApi = {
    aiGskStatus: vi.fn(async () => ({ loggedIn: true })),
    beginHistoryBatch: vi.fn(async () => true),
    endHistoryBatch: vi.fn(options.endHistoryBatch ?? (async () => 7)),
    aiRunBegin: vi.fn(async (_ownerToken: string) => true),
    aiRunEnd: vi.fn(async (_ownerToken: string) => true),
    aiSnapshotRestore: vi.fn(async () => []),
    onAiStream: vi.fn((cb: typeof listener) => {
      listener = cb
      return () => {
        if (listener === cb) listener = null
      }
    }),
    aiStream: vi.fn((request: { requestId: string }) => {
      activeRequestId = request.requestId
      if (options.finishStream) queueMicrotask(emitDone)
    }),
    aiStreamCancel: vi.fn(() => {
      const requestId = activeRequestId
      queueMicrotask(() => emitDone(requestId))
    }),
  }
  const desktop = {
    readAttachmentImage: vi.fn(
      options.readImage ?? (async () => ({ ok: true, base64: 'AAAA', mime: 'image/png' })),
    ),
  }
  ;(window as any).slidesApi = slidesApi
  ;(window as any).desktop = desktop
  return { slidesApi, desktop, finishCurrentStream: emitDone }
}

function mount(overrides: Record<string, unknown>): { container: HTMLElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() =>
    root.render(
      createElement(AiPanel, {
        slides: [],
        current: 0,
        selectedIds: [],
        images: new Map<string, HTMLImageElement>(),
        applySlide: () => {},
        applyDeck: () => {},
        fitWidthPx: 960,
        settings,
        open: true,
        onExpand: () => {},
        onCollapse: () => {},
        ...overrides,
      } as any),
    ),
  )
  return { container, root }
}

async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => root.unmount())
  container.remove()
}

function typeInto(textarea: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

afterEach(() => {
  vi.useRealTimers()
  delete (window as any).slidesApi
  delete (window as any).desktop
  delete (window as any).projectApi
})

beforeAll(() => {
  Element.prototype.scrollTo ??= () => {}
})

describe('AiPanel run lifecycle', () => {
  it('does not start a run after cancellation during attachment preflight', async () => {
    const pending = deferred<unknown>()
    const { slidesApi } = installApis({
      finishStream: true,
      readImage: () => pending.promise,
    })
    const { container, root } = mount({
      preset: {
        text: 'Describe the attached image',
        nonce: 1,
        autoRun: true,
        attachments: [{ name: 'figure.png', path: 'C:\\figure.png', ext: 'png', sizeBytes: 10 }],
      },
    })

    const stop = container.querySelector<HTMLButtonElement>('.ai-stop-btn')
    expect(stop).not.toBeNull()
    act(() => stop!.click())

    await act(async () => {
      pending.resolve({ ok: true, base64: 'AAAA', mime: 'image/png' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(slidesApi.beginHistoryBatch).not.toHaveBeenCalled()
    expect(slidesApi.aiStream).not.toHaveBeenCalled()
    await unmount(root, container)
  })

  it('resolves an unsaved blank deck with a null file path', async () => {
    const { slidesApi } = installApis({ finishStream: false })
    const resolveChat = vi.fn(async () => ({ projectId: 'default', chatId: 'unsaved-1' }))
    const loadChat = vi.fn(async () => [])
    ;(window as any).projectApi = { resolveChat, loadChat }

    const { container, root } = mount({ currentFilePath: '' })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(resolveChat).toHaveBeenCalledWith({
      filePath: null,
      tempChatId: expect.stringMatching(/^unsaved-\d+$/),
    })
    expect(loadChat).toHaveBeenCalledWith({ projectId: 'default', chatId: 'unsaved-1', limit: 200 })
    expect(slidesApi.aiStream).not.toHaveBeenCalled()
    await unmount(root, container)
  })

  it('does not let an old attachment read overwrite a newer notice', async () => {
    vi.useFakeTimers()
    const oldRead = deferred<unknown>()
    const readImage = vi.fn((path: string) =>
      path.includes('old')
        ? oldRead.promise
        : Promise.resolve({ ok: false, error: 'new attachment failed' }),
    )
    installApis({ finishStream: false, readImage })
    const { container, root } = mount({
      preset: {
        text: 'Old run',
        nonce: 1,
        autoRun: true,
        attachments: [{ name: 'old.png', path: 'C:\\old.png', ext: 'png', sizeBytes: 10 }],
      },
    })

    const stop = container.querySelector<HTMLButtonElement>('.ai-stop-btn')
    expect(stop).not.toBeNull()
    act(() => stop!.click())

    await act(async () => {
      root.render(
        createElement(AiPanel, {
          slides: [],
          current: 0,
          selectedIds: [],
          images: new Map<string, HTMLImageElement>(),
          applySlide: () => {},
          applyDeck: () => {},
          fitWidthPx: 960,
          settings,
          open: true,
          preset: {
            text: 'New run',
            nonce: 2,
            autoRun: true,
            attachments: [{ name: 'new.png', path: 'C:\\new.png', ext: 'png', sizeBytes: 10 }],
          },
        } as any),
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.ai-attach-notice')?.textContent).toBe('new attachment failed')

    await act(async () => {
      oldRead.resolve({ ok: false, error: 'old attachment failed' })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.ai-attach-notice')?.textContent).toBe('new attachment failed')

    await act(async () => {
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
    })
    expect(container.querySelector('.ai-attach-notice')?.textContent).toBe('new attachment failed')
    await unmount(root, container)
  })

  it('closes the active history batch when starting a new chat', async () => {
    const { slidesApi } = installApis({ finishStream: false })
    const { container, root } = mount({
      preset: { text: 'Start a run', nonce: 1, autoRun: true },
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(slidesApi.beginHistoryBatch).toHaveBeenCalledOnce()
    expect(slidesApi.aiStream).toHaveBeenCalledOnce()

    const newChat = container.querySelector<HTMLButtonElement>('.ai-panel-header .ai-header-btn')
    expect(newChat).not.toBeNull()
    await act(async () => {
      newChat!.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(slidesApi.endHistoryBatch).toHaveBeenCalledOnce()
    await unmount(root, container)
  })

  it('closes the active history batch when the panel unmounts', async () => {
    const { slidesApi } = installApis({ finishStream: false })
    const { container, root } = mount({
      preset: { text: 'Run before file switch', nonce: 1, autoRun: true },
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(slidesApi.beginHistoryBatch).toHaveBeenCalledOnce()

    await unmount(root, container)

    expect(slidesApi.endHistoryBatch).toHaveBeenCalledOnce()
  })

  it('claims and releases main-process AI mutation ownership for a completed run', async () => {
    const { slidesApi } = installApis({ finishStream: true })
    const { container, root } = mount({
      preset: { text: 'Run with ownership', nonce: 1, autoRun: true },
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(slidesApi.aiRunBegin).toHaveBeenCalledOnce()
    expect(slidesApi.aiRunBegin.mock.calls[0]?.[0]).toEqual(expect.any(String))
    expect(slidesApi.aiRunEnd).toHaveBeenCalledOnce()
    expect(slidesApi.aiRunEnd.mock.calls[0]?.[0]).toBe(slidesApi.aiRunBegin.mock.calls[0]?.[0])
    await unmount(root, container)
  })

  it('clears preflight busy state when main-process ownership cannot be claimed', async () => {
    const { slidesApi } = installApis({ finishStream: false })
    slidesApi.aiRunBegin.mockResolvedValue(false)
    const { container, root } = mount({
      preset: { text: 'Claim failure', nonce: 1, autoRun: true },
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('.ai-stop-btn')).toBeNull()
    await unmount(root, container)
  })

  it('does not attach a delayed old batch snapshot to the next chat run', async () => {
    const oldEnd = deferred<number>()
    let endCount = 0
    const { slidesApi, finishCurrentStream } = installApis({
      finishStream: false,
      endHistoryBatch: async () => (endCount++ === 0 ? oldEnd.promise : 99),
    })
    const { container, root } = mount({
      preset: { text: 'First run', nonce: 1, autoRun: true },
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const newChat = container.querySelector<HTMLButtonElement>('.ai-panel-header .ai-header-btn')
    expect(newChat).not.toBeNull()
    await act(async () => newChat!.click())

    const textarea = container.querySelector<HTMLTextAreaElement>('.ai-input-box textarea')
    expect(textarea).not.toBeNull()
    typeInto(textarea!, 'Second run')
    const send = container.querySelector<HTMLButtonElement>('.ai-send-btn:not(.ai-stop-btn)')
    expect(send).not.toBeNull()
    await act(async () => send!.click())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(slidesApi.beginHistoryBatch).toHaveBeenCalledTimes(2)
    expect(slidesApi.aiStream).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.ai-stop-btn')).not.toBeNull()

    await act(async () => {
      finishCurrentStream()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      oldEnd.resolve(42)
      await Promise.resolve()
      await Promise.resolve()
    })

    const rollback = container.querySelector<HTMLButtonElement>('.ai-rollback-btn')
    expect(rollback).not.toBeNull()
    await act(async () => rollback!.click())
    expect(slidesApi.aiSnapshotRestore).toHaveBeenCalledWith(99)
    await unmount(root, container)
  })

  it('does not let an old queue completion resolve a newer queued run', async () => {
    const oldEnd = deferred<number>()
    let endCount = 0
    const { slidesApi, finishCurrentStream } = installApis({
      finishStream: false,
      endHistoryBatch: async () => (endCount++ === 0 ? oldEnd.promise : 99),
    })
    const { container, root } = mount({
      slides: [
        {
          widthPx: 960,
          heightPx: 540,
          nodes: [
            {
              sourceId: 'shape-1',
              type: 'shape',
              box: {
                x: 10,
                y: 10,
                w: 100,
                h: 80,
                rotationDeg: 0,
                flipH: false,
                flipV: false,
                centerX: 60,
                centerY: 50,
              },
              fill: { kind: 'solid', color: '#ffffff' },
            },
          ],
        },
      ],
      editQueue: [
        {
          key: 'queue-1',
          slideIndex: 0,
          targets: [{ id: 'shape-1', sourceId: 'shape-1', type: 'shape' }],
          instruction: 'Tighten the spacing',
          status: 'pending',
        },
      ],
    })

    const queueSend = () => container.querySelector<HTMLButtonElement>('.ai-queue-send')!
    await act(async () => {
      queueSend().click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(slidesApi.beginHistoryBatch).toHaveBeenCalledOnce()
    expect(slidesApi.aiStream).toHaveBeenCalledOnce()

    await act(async () => {
      finishCurrentStream()
      await Promise.resolve()
      await Promise.resolve()
    })
    const newChat = container.querySelector<HTMLButtonElement>('.ai-panel-header .ai-header-btn')
    expect(newChat).not.toBeNull()
    await act(async () => newChat!.click())

    await act(async () => {
      queueSend().click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(slidesApi.beginHistoryBatch).toHaveBeenCalledTimes(2)
    expect(slidesApi.aiStream).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.ai-stop-btn')).not.toBeNull()

    await act(async () => {
      oldEnd.resolve(42)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.ai-stop-btn')).not.toBeNull()
    await unmount(root, container)
  })
})
