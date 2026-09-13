import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.env.METIS_GORDEN_TEMPLATES_DIR!
console.log('dir:', dir, 'INDEX:', existsSync(join(dir, 'INDEX.md')))
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  const hasPptx = existsSync(join(dir, entry.name, 'template.pptx'))
  console.log(entry.isDirectory() ? 'DIR ' : 'FILE', entry.name, hasPptx ? '(template.pptx)' : '')
}
