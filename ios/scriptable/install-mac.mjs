import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const target = process.argv[2]
if (!/^https:\/\/[a-z0-9][a-z0-9.-]*\.ts\.net(?::[1-9][0-9]{0,4})?\/?$/.test(target ?? '')) {
  throw new Error('Usage: node ios/scriptable/install-mac.mjs https://device.tailnet.ts.net')
}
const dir = dirname(fileURLToPath(import.meta.url))
const state = join(homedir(), 'Library', 'Application Support', 'CodeBurn iPhone Widget')
const keyFile = join(state, 'access-key')
const label = 'local.codeburn.iphone-quota'
const agents = join(homedir(), 'Library', 'LaunchAgents')
const plist = join(agents, `${label}.plist`)
const domain = `gui/${process.getuid()}`

await mkdir(state, { recursive: true, mode: 0o700 })
try {
  await writeFile(keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
} catch (error) {
  if (error.code !== 'EEXIST') throw error
}
const icons = JSON.parse(execFileSync('/usr/bin/xcrun', [
  'swift', '-module-cache-path', join(state, 'swift-cache'), join(dir, 'render-icons.swift'),
  join(dir, '../../mac/Sources/CodeBurnMenubar/Resources/ProviderIcons'),
], { encoding: 'utf8' }))
const settings = {
  endpoint: new URL('/codeburn-quota', target).href,
  accessKey: (await readFile(keyFile, 'utf8')).trim(),
  icons,
}
const template = await readFile(join(dir, 'quota-widget.js'), 'utf8')
const marker = 'const settings = null // Replaced when exporting the configured script.'
if (!template.includes(marker)) throw new Error('Missing Scriptable settings marker')
const scriptFiles = []
for (const [card, title] of [['quota', '套餐额度'], ['today', '今日用量'], ['trend', '7 天趋势']]) {
  const file = join(state, `CodeBurn ${title}.js`)
  const script = template.replace(marker, () => `const settings = ${JSON.stringify({ ...settings, card })}`)
  await writeFile(file, script, { mode: 0o600 })
  scriptFiles.push(file)
}

const strings = [process.env.CODEBURN_WIDGET_NODE || process.execPath, join(dir, 'quota-bridge.mjs'), keyFile]
const xmlString = value => '<string>' + value.replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</string>'
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${xmlString(label)}
  <key>ProgramArguments</key>
  <array>${strings.map(xmlString).join('')}</array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`
await mkdir(agents, { recursive: true })
await writeFile(plist, xml, { mode: 0o600 })
const launchctl = (args, options = { stdio: 'inherit' }) => execFileSync('/bin/launchctl', args, options)
const service = `${domain}/${label}`
const loaded = () => spawnSync('/bin/launchctl', ['print', service]).status === 0
if (loaded()) {
  launchctl(['bootout', service])
  // launchd can return from bootout before the old registration is removed.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && loaded()) await delay(100)
  if (loaded()) throw new Error('The previous CodeBurn widget bridge is still unloading')
}
launchctl(['bootstrap', domain, plist])
console.log(scriptFiles.join('\n'))
