import { test, expect } from '@playwright/test'
import { closeAndSaveVideo, screenshotPath } from './helpers'
import { createResearchFigure, launchResearchEditor } from './helpers/research-figure'

/**
 * Research Figure CREATE (QA-P1-12): a deterministic stub model answers the
 * agent loop, but everything else is the REAL Electron app, REAL agent loop,
 * REAL orchestrator, REAL Konva renderer. Pass = the figure reaches the real
 * canvas without a transcript error.
 */
test.describe('research figure create', () => {
  test('stub-driven request renders the orchestrated figure on the real canvas', async () => {
    const session = await launchResearchEditor()
    const { launched, editor, stub } = session
    try {
      await createResearchFigure(session)

      // the agent loop actually called the orchestrated creation tool
      const transcript = await editor.locator('.ai-msg').allTextContents()
      const joined = transcript.join('\n')
      expect(joined).toContain('create_research_figure')
      expect(joined).toContain('生成完毕')

      // planner + composer contracts both went through the user's model
      const plannerCall = stub.requests.find(
        (r) => !r.hasTools && r.systemSnippet.includes('Semantic Planner'),
      )
      expect(plannerCall).toBeDefined()
      const composerCall = stub.requests.find(
        (r) => !r.hasTools && r.systemSnippet.includes('Composition Designer'),
      )
      expect(composerCall, 'composition designer must be invoked (A1 path)').toBeDefined()

      // the REAL renderer shows the deck stage with the figure
      await expect(editor.locator('.stage-wrap canvas').first()).toBeVisible()
      await editor.screenshot({ path: screenshotPath('research-figure-create') })
    } finally {
      await closeAndSaveVideo(launched, 'research-figure-create')
      await stub.close()
    }
  })
})
