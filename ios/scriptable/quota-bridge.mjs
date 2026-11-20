import { timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const agentIds = ['codex', 'zcode', 'antigravity']
const snapshotPath = join(homedir(), 'Library', 'Containers', 'local.codeburn.bigmodel.widgets', 'Data',
  'Library', 'Application Support', 'CodeBurn Widgets', 'snapshot.json')
const maxSnapshotBytes = 32 * 1024
const vinylDirectory = fileURLToPath(new URL('../../mac/Widgets/Vinyl/', import.meta.url))

async function readSnapshot(file) {
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
    return snapshot?.version === 1 ? snapshot : null
  } finally {
    await handle.close()
  }
}

function isDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function calendarDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && isDate(value)
}

function isoDate(value) {
  return isDate(value) ? new Date(value).toISOString() : null
}

function quotaFields(quota) {
  if (!isDate(quota?.updatedAt) || !Array.isArray(quota.agents)) return null
  const agents = agentIds.map(id => {
    const row = quota.agents.find(entry => entry?.id === id)
    const windows = Array.isArray(row?.windows) ? row.windows : []
    return {
      id,
      stale: row?.stale === true,
      windows: windows.slice(0, id === 'antigravity' ? 24 : 2).filter(window =>
        typeof window?.label === 'string' && window.label.length <= 120 &&
        Number.isFinite(window.percent) && window.percent >= 0 && window.percent <= 1
      ).map(({ label, percent, resetsAt }) => ({ label, percent, resetsAt: isoDate(resetsAt) })),
    }
  })
  return { version: 1, updatedAt: isoDate(quota.updatedAt), agents }
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function usageFields(usage) {
  if (!isDate(usage?.updatedAt) || !calendarDay(usage.day) ||
      !Array.isArray(usage.agents) || !Array.isArray(usage.days)) return null
  const agents = agentIds.map(id => {
    const row = usage.agents.find(entry => entry?.id === id)
    return { id, tokens: count(row?.tokens), input: count(row?.input), cached: count(row?.cached) }
  })
  const days = usage.days.slice(0, 7).filter(row => calendarDay(row?.day))
    .map(({ day, tokens }) => ({ day, tokens: count(tokens) }))
  return { version: 1, updatedAt: isoDate(usage.updatedAt), day: usage.day, agents, days }
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
    const route = request.url
    const frame = route?.match(/^\/codeburn-vinyl\/(light|dark|walnut)-(\d{1,2})\.png$/)
    const frameValid = frame && Number(frame[2]) >= 2 && Number(frame[2]) <= 36
    if (route !== '/codeburn-quota' && route !== '/codeburn-usage' && !frameValid) {
      return send(404, { error: 'not_found' })
    }
    if (request.method !== 'GET') return send(405, { error: 'method_not_allowed' })
    const presented = Buffer.from(request.headers.authorization ?? '')
    if (presented.length !== authorization.length || !timingSafeEqual(presented, authorization)) {
      return send(401, { error: 'unauthorized' })
    }
    if (frameValid) {
      const png = await readFile(join(vinylDirectory, `${frame[1]}-${Number(frame[2])}.png`)).catch(() => null)
      if (!png || png.length > 256 * 1024) return send(404, { error: 'not_found' })
      response.writeHead(200, {
        'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      return response.end(png)
    }
    const snapshot = await readSnapshot(file).catch(() => null)
    const body = route === '/codeburn-quota' ? quotaFields(snapshot?.quota) : usageFields(snapshot?.usage)
    if (!body) return send(503, { error: route === '/codeburn-quota' ? 'quota_unavailable' : 'usage_unavailable' })
    send(200, body)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keyFile = process.argv[2]
  if (!keyFile) throw new Error('Widget access key file is required')
  const accessKey = (await readFile(keyFile, 'utf8')).trim()
  quotaServer(accessKey).listen(37461, '127.0.0.1')
}
