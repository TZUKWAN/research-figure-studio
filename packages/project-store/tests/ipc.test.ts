import { describe, expect, it } from 'vitest'
import {
  assertAppendChatArgs,
  assertLoadChatArgs,
  assertRebindChatArgs,
  assertResolveChatArgs,
} from '../src/ipc.js'

describe('project-store IPC argument validation', () => {
  it('accepts a resolve request for a saved or unsaved file', () => {
    expect(assertResolveChatArgs({ filePath: 'C:\\work\\deck.pptx' })).toEqual({
      filePath: 'C:\\work\\deck.pptx',
    })
    expect(assertResolveChatArgs({ filePath: null, tempChatId: 'unsaved-123' })).toEqual({
      filePath: null,
      tempChatId: 'unsaved-123',
    })
  })

  it.each([
    undefined,
    null,
    {},
    { filePath: 42 },
    { filePath: '' },
    { filePath: null, tempChatId: '../escape' },
  ])('rejects malformed resolve request %#', (args) => {
    expect(() => assertResolveChatArgs(args)).toThrow(/Invalid resolveChat args/)
  })

  it('accepts canonical append data and rejects untrusted field types', () => {
    expect(
      assertAppendChatArgs({
        projectId: 'default',
        chatId: 'chat-1',
        role: 'assistant',
        text: 'answer',
        tools: [{ name: 'read_slide', summary: 'read page', isError: false }],
        attachments: [{ name: 'figure.png', sizeBytes: 12 }],
      }),
    ).toMatchObject({ role: 'assistant', text: 'answer' })

    expect(() =>
      assertAppendChatArgs({
        projectId: 'default',
        chatId: 'chat-1',
        role: 'system',
        text: 'answer',
      }),
    ).toThrow(/Invalid appendChat args/)
    expect(() =>
      assertAppendChatArgs({
        projectId: 'default',
        chatId: 'chat-1',
        role: 'user',
        text: 42,
      }),
    ).toThrow(/Invalid appendChat args/)
    expect(() =>
      assertAppendChatArgs({
        projectId: 'default',
        chatId: 'chat-1',
        role: 'user',
        text: 'question',
        attachments: [{ name: 'figure.png', sizeBytes: -1 }],
      }),
    ).toThrow(/Invalid appendChat args/)
  })

  it('requires a positive bounded load limit', () => {
    expect(assertLoadChatArgs({ projectId: 'default', chatId: 'chat-1', limit: 200 })).toEqual({
      projectId: 'default',
      chatId: 'chat-1',
      limit: 200,
    })
    for (const limit of [0, -1, 1.5, Number.NaN, 10_001]) {
      expect(() => assertLoadChatArgs({ projectId: 'default', chatId: 'chat-1', limit })).toThrow(
        /Invalid loadChat args/,
      )
    }
  })

  it('requires exactly one valid rebind target', () => {
    expect(
      assertRebindChatArgs({
        projectId: 'default',
        tempChatId: 'unsaved-123',
        newChatId: 'chat-1',
      }),
    ).toMatchObject({ newChatId: 'chat-1' })
    expect(
      assertRebindChatArgs({
        projectId: 'default',
        tempChatId: 'unsaved-123',
        newFilePath: 'C:\\work\\deck.pptx',
      }),
    ).toMatchObject({ newFilePath: 'C:\\work\\deck.pptx' })
    expect(() => assertRebindChatArgs({ projectId: 'default', tempChatId: 'unsaved-123' })).toThrow(
      /Invalid rebindChat args/,
    )
    expect(() =>
      assertRebindChatArgs({
        projectId: 'default',
        tempChatId: 'unsaved-123',
        newChatId: 'chat-1',
        newFilePath: 'C:\\work\\deck.pptx',
      }),
    ).toThrow(/Invalid rebindChat args/)
  })
})
