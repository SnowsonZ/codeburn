import { timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const agentIds = ['codex', 'zcode', 'antigravity']
const snapshotPath = join(homedir(), 'Library', 'Containers', 'local.codeburn.bigmodel.widgets', 'Data',
  'Library', 'Application Support', 'CodeBurn Widgets', 'snapshot.json')
const maxSnapshotBytes = 32 * 1024

async function readQuota(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxSnapshotBytes || info.uid !== process.getuid() || (info.mode & 0o077)) {
      return null
    }
    const buffer = Buffer.alloc(maxSnapshotBytes + 1)
    const { bytesRead } = await handle.read(buffer)
    if (bytesRead > maxSnapshotBytes) return null
    const snapshot = JSON.parse(buffer.toString('utf8', 0, bytesRead))
    const quota = snapshot?.quota
    if (snapshot?.version !== 1 || typeof quota?.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(quota.updatedAt)) || !Array.isArray(quota.agents)) return null

    // Share the same fields the desktop quota widget displays.
    const agents = agentIds.map(id => {
      const row = quota.agents.find(entry => entry?.id === id)
      const windows = Array.isArray(row?.windows) ? row.windows : []
      return {
        id,
        stale: row?.stale === true,
        windows: windows.slice(0, id === 'antigravity' ? 24 : 2).filter(window =>
          typeof window?.label === 'string' && window.label.length <= 120 &&
          Number.isFinite(window.percent) && window.percent >= 0 && window.percent <= 1
        ).map(({ label, percent, resetsAt }) => ({
          label, percent, resetsAt: typeof resetsAt === 'string' && Number.isFinite(Date.parse(resetsAt))
            ? new Date(resetsAt).toISOString() : null,
        })),
      }
    })
    return { version: 1, updatedAt: new Date(quota.updatedAt).toISOString(), agents }
  } finally {
    await handle.close()
  }
}

export function quotaServer(accessKey, file = snapshotPath) {
  if (!/^[a-f0-9]{64}$/.test(accessKey)) throw new Error('Invalid widget access key')
  const authorization = Buffer.from(`Bearer ${accessKey}`)
  return createServer({ requestTimeout: 5000, headersTimeout: 5000 }, async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      response.end(JSON.stringify(body))
    }
    if (request.url !== '/codeburn-quota') return send(404, { error: 'not_found' })
    if (request.method !== 'GET') return send(405, { error: 'method_not_allowed' })
    const presented = Buffer.from(request.headers.authorization ?? '')
    if (presented.length !== authorization.length || !timingSafeEqual(presented, authorization)) {
      return send(401, { error: 'unauthorized' })
    }
    const quota = await readQuota(file).catch(() => null)
    if (!quota) return send(503, { error: 'quota_unavailable' })
    send(200, quota)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keyFile = process.argv[2]
  if (!keyFile) throw new Error('Widget access key file is required')
  const accessKey = (await readFile(keyFile, 'utf8')).trim()
  quotaServer(accessKey).listen(37461, '127.0.0.1')
}
