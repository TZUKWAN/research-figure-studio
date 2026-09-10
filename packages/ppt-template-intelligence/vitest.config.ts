import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@genoffice/pptx-engine/animation': resolve(here, '../pptx-engine/src/animation.ts'),
      '@genoffice/pptx-engine/identity': resolve(here, '../pptx-engine/src/identity.ts'),
      '@genoffice/pptx-engine/research-metadata': resolve(
        here,
        '../pptx-engine/src/research-metadata.ts',
      ),
      '@genoffice/pptx-engine': resolve(here, '../pptx-engine/src/index.ts'),
      '@genoffice/font-metrics': resolve(here, '../font-metrics/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
