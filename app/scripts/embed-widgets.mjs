import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const sources = path.join(appDir, '..', 'mac', 'Widgets')
const application = path.join(appDir, 'release-widgets', 'mac-arm64', 'CodeBurn BigModel.app')
const hostInfo = path.join(application, 'Contents', 'Info.plist')
const pluginDir = path.join(application, 'Contents', 'PlugIns')
const name = 'CodeBurnWidgets'
const temp = mkdtempSync(path.join(tmpdir(), 'codeburn-widget-'))
const extension = path.join(temp, name + '.appex')
const info = path.join(extension, 'Contents', 'Info.plist')
const binary = path.join(extension, 'Contents', 'MacOS', name)

function run(file, args) {
  execFileSync(file, args, { stdio: 'inherit' })
}

try {
  mkdirSync(path.dirname(binary), { recursive: true })
  copyFileSync(path.join(sources, 'Info.plist'), info)
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const value = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print ' + key, hostInfo], { encoding: 'utf8' }).trim()
    run('/usr/bin/plutil', ['-replace', key, '-string', value, info])
  }

  const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim()
  run('xcrun', [
    'swiftc', '-parse-as-library', '-application-extension', '-target', 'arm64-apple-macosx14.0',
    '-sdk', sdk, '-module-cache-path', path.join(temp, 'swift-cache'), '-O',
    '-framework', 'SwiftUI', '-framework', 'WidgetKit',
    path.join(sources, name + '.swift'), '-o', binary,
  ])
  run('/usr/bin/codesign', ['--sign', '-', '--timestamp=none', '--entitlements', path.join(sources, 'Widget.entitlements'), extension])
  mkdirSync(pluginDir, { recursive: true })
  cpSync(extension, path.join(pluginDir, name + '.appex'), { recursive: true })

  // The CLI and Electron helpers are already signed. Seal the new nested
  // extension in the outer bundle without re-signing subordinate executables.
  run('/usr/bin/codesign', [
    '--force', '--sign', '-', '--timestamp=none', '--entitlements',
    path.join(appDir, 'build', 'entitlements.mac.plist'), application,
  ])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application])
  console.log(application)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
