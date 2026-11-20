import { randomUUID } from 'node:crypto'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const finish = process.argv[2]
if (!['silver', 'dark', 'walnut', 'system'].includes(finish)) {
  console.error('Usage: node mac/Widgets/set-finish.mjs <silver|dark|walnut|system>')
  process.exit(1)
}
const directory = join(homedir(), 'Library', 'Containers', 'local.codeburn.bigmodel.widgets', 'Data',
  'Library', 'Application Support', 'CodeBurn Widgets')
const temporary = join(directory, '.vinyl-finish-' + randomUUID())
try {
  await writeFile(temporary, finish + '\n', { mode: 0o600, flag: 'wx' })
  await rename(temporary, join(directory, 'vinyl-finish'))
} finally {
  await unlink(temporary).catch(() => {})
}
console.log('CodeBurn: ' + finish + ' will appear on the next widget refresh.')
