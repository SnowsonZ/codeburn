import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
const extension = path.join(temp, 'Build', 'Products', 'Release', name + '.appex')
const destination = path.join(pluginDir, name + '.appex')

function run(file, args) {
  execFileSync(file, args, { stdio: 'inherit' })
}

function plist(file, key) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print ' + key, file], { encoding: 'utf8' }).trim()
}

try {
  const marketingVersion = plist(hostInfo, 'CFBundleShortVersionString')
  // The manually packaged preview used the marketing version as its native
  // build number. A higher build supersedes its cached widget descriptors.
  const buildVersion = '1'
  run('xcodebuild', [
    '-project', path.join(sources, name + '.xcodeproj'), '-scheme', name,
    '-configuration', 'Release', '-destination', 'generic/platform=macOS',
    '-derivedDataPath', temp, '-quiet', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=NO',
    'CODE_SIGNING_ALLOWED=NO', 'MARKETING_VERSION=' + marketingVersion,
    'CURRENT_PROJECT_VERSION=' + buildVersion, 'build',
  ])
  run('/usr/bin/codesign', ['--sign', '-', '--timestamp=none', '--entitlements', path.join(sources, 'Widget.entitlements'), extension])
  mkdirSync(pluginDir, { recursive: true })
  rmSync(destination, { recursive: true, force: true })
  cpSync(extension, destination, { recursive: true })
  run('/usr/bin/plutil', ['-replace', 'CFBundleVersion', '-string', buildVersion, hostInfo])

  // Seal the new nested extension without re-signing Electron's helpers.
  run('/usr/bin/codesign', [
    '--force', '--sign', '-', '--timestamp=none', '--entitlements',
    path.join(appDir, 'build', 'entitlements.mac.plist'), application,
  ])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application])
  console.log(application)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
