// Variables used by Scriptable.
// icon-color: green; icon-glyph: tachometer-alt;
const settings = null // Replaced when exporting the configured script.

const requestedFinish = String(args.widgetParameter ?? '').trim().toLowerCase()
const finish = ['light', 'dark', 'walnut'].includes(requestedFinish) ? requestedFinish
  : requestedFinish === 'system' && Device.isUsingDarkAppearance() ? 'dark' : 'light'
const light = finish === 'light'
const walnut = finish === 'walnut'
const stops = light ? [0xf6f4ef, 0xece8e0, 0xe3ded4]
  : walnut ? [0x3c281d, 0x271a12, 0x1b120d] : [0x22201f, 0x161514, 0x100f0f]
const palette = {
  surface: new Color(light ? '#ece8e0' : walnut ? '#271a12' : '#161514'),
  primary: new Color(light ? '#181614' : walnut ? '#faf2e6' : '#f6f1ea'),
  secondary: new Color(light ? '#5b554e' : walnut ? '#c9b096' : '#a39a92'),
  accent: new Color(light ? '#d14114' : walnut ? '#f68646' : '#f9671e'),
  used: new Color(light ? '#b5aaa0' : '#534b45'),
  remaining: new Color(light ? '#0d9668' : walnut ? '#34d399' : '#10b981'),
  low: new Color(light ? '#d97706' : walnut ? '#fbbf24' : '#f59e0b'),
  eject: new Color(light ? '#b51d44' : '#fb7185'),
  rule: new Color(light ? '#c9c0b4' : '#50463e'),
  well: new Color(light ? '#d3ccc0' : '#1a1614'),
  badge: new Color(light ? '#e7e1d9' : '#39312c'),
}
const agentIds = ['codex', 'zcode', 'antigravity']
const agentColors = ['#06b6d4', '#4387fb', '#d946ef']
const coverColors = light ? ['#dcd4c8','#d2c9bc','#d9cdc0','#cfc4b4','#d7ccbe','#cec6ba']
  : walnut ? ['#523a2c','#483327','#5b4030','#644533','#50392c','#443025']
  : ['#342f2c','#2c2826','#38312c','#40362f','#322d2a','#2b2725']
const sleeveInk = ['#6f8594','#9c785c','#b86846','#c99749','#5f8a7a','#7d756e'].map(x => new Color(x))
const inset = 11
const railWidth = 42
const columnGap = 8
const refreshInterval = 15 * 60 * 1000

// Medium width, small edge, large height, in portrait points.
const widgetSizes = {
  '320x568': [292, 141, 311],
  '360x780': [329, 155, 345],
  '375x667': [321, 148, 324],
  '375x812': [329, 155, 345],
  '390x844': [338, 158, 354],
  '393x852': [338, 158, 354],
  '414x736': [348, 157, 357],
  '414x896': [360, 169, 379],
  '428x926': [364, 170, 382],
  '430x932': [364, 170, 382],
}

function widgetSize(family) {
  const screen = Device.screenSize()
  const width = Math.min(screen.width, screen.height)
  const height = Math.max(screen.width, screen.height)
  const fallback = Math.min(364, Math.max(260, Math.floor(width) - 66))
  const [wide, small, tall] = widgetSizes[`${Math.round(width)}x${Math.round(height)}`] ??
    [fallback, Math.floor(fallback * 0.46), fallback + 12]
  if (family === 'small') return [small, small]
  return [wide, family === 'large' ? tall : small]
}

function text(stack, value, font, color = palette.primary) {
  const label = stack.addText(value)
  label.font = font
  label.textColor = color
  label.lineLimit = 1
  label.minimumScaleFactor = 0.8
}

function horizontal(parent) {
  const stack = parent.addStack()
  stack.layoutHorizontally()
  stack.centerAlignContent()
  return stack
}

function slot(parent, width, height) {
  const stack = horizontal(parent)
  stack.size = new Size(width, height)
  return stack
}

function icon(stack, name, size, fallback, color = palette.primary) {
  const encoded = settings?.icons?.[name]
  const image = encoded ? Image.fromData(Data.fromBase64String(encoded)) : SFSymbol.named(fallback)?.image
  if (!image) return
  const view = stack.addImage(image)
  view.imageSize = new Size(size, size)
  view.tintColor = color
}

function identity(stack, row, height) {
  const rail = slot(stack, railWidth, height)
  if (row.id) {
    const size = Math.min(height, row.id === 'zcode' ? 22 : 18)
    const markWidth = 22
    const offset = (markWidth - size) / 2
    if (offset > 0) rail.addSpacer(offset)
    icon(rail, row.id, size, 'terminal')
    if (row.stale) {
      rail.addSpacer(markWidth - size - offset + 4)
      icon(rail, null, 10, 'clock.arrow.circlepath', palette.secondary)
    }
  } else {
    rail.addSpacer(9)
    const name = row.group.toLowerCase()
    const claude = name.includes('claude')
    const gpt = name.includes('gpt')
    const gemini = name.includes('gemini')
    const model = claude ? 'claude' : gpt ? 'codex' : gemini ? 'gemini' : null
    icon(rail, model, 14, 'cpu')
    if (claude && gpt) {
      rail.addSpacer(4)
      icon(rail, 'codex', 14, 'circle.hexagongrid')
    } else if (gemini && name.includes('argon')) {
      rail.addSpacer(4)
      const badge = slot(rail, 22, 15)
      badge.cornerRadius = 4
      badge.backgroundColor = palette.badge
      badge.addSpacer(5)
      text(badge, 'Ar', Font.semiboldMonospacedSystemFont(9), palette.secondary)
    }
  }
  rail.addSpacer()
}

function accountRows(agent) {
  if (!agent.windows.length) return [{ ...agent, message: '额度暂不可用' }]
  const short = agent.windows.find(window => window.label === '5-hour')
  const week = agent.windows.find(window => window.label === 'Weekly')
  const other = agent.windows.filter(window => window !== short && window !== week)
  const rows = short || week ? [{ ...agent, short, week }] : []
  return rows.concat(other.map(window => ({ ...agent, single: window, label: window.label })))
}

function gravityRows(agent, limit) {
  if (!agent.windows.length) return [{ ...agent, message: '额度暂不可用' }]
  const groups = new Map()
  const rows = []
  for (const window of agent.windows) {
    const [group, bucket = ''] = window.label.split(' · ', 2)
    const period = /(?:five|5)[ -]hour/i.test(bucket) ? 'short' : /weekly/i.test(bucket) ? 'week' : null
    if (!period) {
      rows.push({ group, single: window, label: group })
      continue
    }
    if (!groups.has(group)) {
      const row = { group }
      groups.set(group, row)
      rows.push(row)
    }
    groups.get(group)[period] = window
  }
  return [{ ...agent, rule: true, extra: Math.max(0, rows.length - limit) }, ...rows.slice(0, limit)]
}

function bar(parent, width, height, remaining, detailed) {
  const view = slot(parent, width, height)
  view.cornerRadius = detailed ? 3 : height / 2
  view.backgroundColor = detailed ? palette.well : palette.used
  if (detailed) {
    view.borderWidth = 0.65
    view.borderColor = remaining === 0 ? palette.eject : palette.rule
  }
  if (remaining === 0) {
    if (detailed && width >= 28) {
      view.addSpacer()
      text(view, '耗尽', Font.semiboldSystemFont(7), palette.eject)
      view.addSpacer()
    }
    return
  }
  const tint = remaining <= 0.25 ? palette.low : palette.remaining
  if (!detailed) {
    const fill = slot(view, Math.max(1, width * remaining), height)
    fill.backgroundColor = tint
    fill.cornerRadius = height / 2
    return
  }
  const canvas = new DrawContext()
  canvas.opaque = false
  canvas.respectScreenScale = true
  canvas.size = new Size(width, height)
  const side = Math.min(height - 3, width * 0.19)
  const left = side / 2 + 3
  const right = width - left
  const centerY = height / 2
  for (const [x, fraction, color] of [[left, remaining, tint], [right, 1 - remaining, palette.secondary]]) {
    const radius = side * (0.20 + 0.27 * fraction)
    canvas.setFillColor(color)
    canvas.fillEllipse(new Rect(x - radius, centerY - radius, radius * 2, radius * 2))
    canvas.setFillColor(palette.well)
    canvas.fillEllipse(new Rect(x - side * 0.19, centerY - side * 0.19, side * 0.38, side * 0.38))
    const spokes = new Path()
    for (let index = 0; index < 6; index++) {
      const angle = index * Math.PI / 3
      spokes.move(new Point(x + Math.cos(angle) * side * 0.06, centerY + Math.sin(angle) * side * 0.06))
      spokes.addLine(new Point(x + Math.cos(angle) * side * 0.13, centerY + Math.sin(angle) * side * 0.13))
    }
    canvas.addPath(spokes)
    canvas.setStrokeColor(color)
    canvas.setLineWidth(0.55)
    canvas.strokePath()
  }
  const start = left + side * 0.63 + 1
  const track = Math.max(1, width - 2 * start)
  canvas.setFillColor(palette.used)
  canvas.fillRect(new Rect(start, centerY - 1.6, track, 3.2))
  canvas.setFillColor(tint)
  canvas.fillRect(new Rect(start, centerY - 1.6, track * remaining, 3.2))
  canvas.setFillColor(palette.rule)
  for (const part of [0.25, 0.5, 0.75]) canvas.fillRect(new Rect(start + track * part, centerY - 1.6, 0.55, 3.2))
  const image = view.addImage(canvas.getImage())
  image.imageSize = new Size(width, height)
}

function quotaCell(parent, width, rowHeight, valueSize, window, now, label) {
  const view = slot(parent, width, rowHeight)
  if (!window) return
  if (window.resetsAt && Date.parse(window.resetsAt) <= now) {
    view.addSpacer()
    text(view, '待更新', Font.mediumSystemFont(Math.min(13, valueSize)), palette.secondary)
    return
  }
  const numberWidth = Math.ceil(valueSize * 2.5 + 2)
  const numberGap = 7
  let barWidth = width - numberWidth - numberGap
  if (label) {
    const labelWidth = Math.min(82, Math.floor(width * 0.36))
    const labelSlot = slot(view, labelWidth, rowHeight)
    text(labelSlot, label === 'Session' ? '会话' : label, Font.mediumSystemFont(11), palette.secondary)
    labelSlot.addSpacer()
    barWidth -= labelWidth + numberGap
    view.addSpacer(numberGap)
  }
  bar(view, barWidth, valueSize >= 15 ? 16 : 12, Math.max(0, 1 - window.percent), true)
  view.addSpacer(numberGap)
  const value = slot(view, numberWidth, rowHeight)
  value.addSpacer()
  text(value, `${Math.round((1 - window.percent) * 100)}%`, Font.semiboldMonospacedSystemFont(valueSize))
}

function rule(parent, width) {
  slot(parent, width, 1).backgroundColor = palette.rule
}

function quotaTable(widget, quota, now, width, availableHeight, large) {
  const column = Math.floor((width - railWidth - 2 * columnGap) / 2)
  const span = column * 2 + columnGap
  const byId = new Map(quota.agents.map(agent => [agent.id, agent]))
  const account = id => byId.get(id) ?? { id, windows: [] }
  const accounts = [...accountRows(account('codex')), ...accountRows(account('zcode'))]
  const minRowHeight = large ? 18 : 11
  const maxModelCount = Math.min(large ? 8 : 3, Math.max(1, Math.floor(availableHeight / minRowHeight) - accounts.length - 1))
  const rows = [...accounts, ...gravityRows(account('antigravity'), maxModelCount)]
  const rowHeight = Math.min(large ? 38 : 14, Math.floor(availableHeight / rows.length))
  const valueSize = rowHeight >= 30 ? 16 : rowHeight >= 20 ? 13 : 9.75

  const headers = horizontal(widget)
  headers.addSpacer(railWidth + columnGap)
  const periods = ['5 小时', '每周']
  for (const title of periods) {
    const heading = slot(headers, column, large ? 16 : 12)
    heading.addSpacer()
    text(heading, title, Font.mediumSystemFont(large ? 10.5 : 8.5), palette.secondary)
    if (title === periods[0]) headers.addSpacer(columnGap)
  }
  widget.addSpacer(2)

  // Distribute the space proposed by WidgetKit between rows so the table
  // expands with the card and the footer stays at the bottom.
  for (const row of rows) {
    widget.addSpacer()
    const line = horizontal(widget)
    const height = row.rule ? Math.min(26, rowHeight) : rowHeight
    identity(line, row, height)
    line.addSpacer(columnGap)
    if (row.rule) {
      const separator = slot(line, span, height)
      rule(separator, row.extra ? span - 29 : span)
      if (row.extra) {
        separator.addSpacer(6)
        text(separator, `+${row.extra}`, Font.mediumSystemFont(10), palette.secondary)
      }
    } else if (row.message) {
      const message = slot(line, span, height)
      message.addSpacer()
      text(message, row.message, Font.mediumSystemFont(11), palette.secondary)
    } else if (row.single) {
      quotaCell(line, span, height, valueSize, row.single, now, row.label)
    } else {
      quotaCell(line, column, height, valueSize, row.short, now)
      line.addSpacer(columnGap)
      quotaCell(line, column, height, valueSize, row.week, now)
    }
  }
}

function isQuota(value) {
  return value?.version === 1 && Number.isFinite(Date.parse(value.updatedAt)) &&
    Array.isArray(value.agents) && value.agents.every(agent => typeof agent?.id === 'string' &&
      Array.isArray(agent.windows) && agent.windows.every(window =>
        typeof window?.label === 'string' && Number.isFinite(window.percent) &&
        window.percent >= 0 && window.percent <= 1))
}

function isUsage(value) {
  return value?.version === 1 && Number.isFinite(Date.parse(value.updatedAt)) &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.day) && Array.isArray(value.agents) && Array.isArray(value.days)
}

function endpoint(route) {
  return settings.endpoint.replace(/\/codeburn-quota$/, route)
}

function privateRequest(url) {
  const request = new Request(url)
  request.headers = { Authorization: `Bearer ${settings.accessKey}` }
  request.timeoutInterval = 7
  request.onRedirect = () => null
  return request
}

async function loadData(card) {
  if (!settings) return { data: null, status: '请先导入已配置的脚本' }
  const disk = FileManager.local()
  const usage = card !== 'quota'
  const validate = usage ? isUsage : isQuota
  const url = endpoint(usage ? '/codeburn-usage' : '/codeburn-quota')
  const source = url.replace(/[^a-z0-9]/gi, '-')
  const cache = disk.joinPath(disk.libraryDirectory(), `codeburn-${source}.json`)
  try {
    const request = privateRequest(url)
    const value = await request.loadJSON()
    if (request.response.statusCode === 401) return { data: null, status: '请重新导入配对脚本' }
    if (request.response.statusCode !== 200 || !validate(value)) throw new Error('Widget data unavailable')
    try { disk.writeString(cache, JSON.stringify(value)) } catch {}
    return { data: value, status: null }
  } catch {
    try {
      const previous = JSON.parse(disk.readString(cache))
      if (validate(previous)) return { data: previous, status: '显示缓存' }
    } catch {}
    return { data: null, status: '等待同步，请检查 Mac 或 Tailscale' }
  }
}

function sum(values) {
  return values.some(value => value === null || !Number.isFinite(value))
    ? null : values.reduce((total, value) => total + value, 0)
}

function tokenText(number) {
  if (number === null || !Number.isFinite(number)) return '—'
  if (number >= 1e8) return `${Number((number / 1e8).toFixed(2))} 亿`
  if (number >= 1e4) return `${Math.round(number / 1e4)} 万`
  return String(number)
}

function hitRate(usage) {
  const input = sum(usage.agents.map(agent => agent.input))
  const cached = sum(usage.agents.map(agent => agent.cached))
  return input > 0 && cached !== null && cached <= input ? Math.round(100 * cached / input) : null
}

function calendarKey(now) {
  const date = new Date(now)
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(value => String(value).padStart(2, '0')).join('-')
}

async function readVinyl(usage) {
  if (!settings || !usage) return null
  const total = sum(usage.agents.map(agent => agent.tokens)) ?? 0
  const groove = Math.max(2, Math.min(36, Math.round(36 * total / 1e9)))
  const url = endpoint(`/codeburn-vinyl/${finish}-${groove}.png`)
  const disk = FileManager.local()
  const file = disk.joinPath(disk.libraryDirectory(), `codeburn-v3-vinyl-${finish}-${groove}.png`)
  try {
    if (disk.fileExists(file)) return disk.readImage(file)
  } catch {}
  try {
    const request = privateRequest(url)
    const image = await request.loadImage()
    if (request.response.statusCode !== 200 || image.size.width !== 444 || image.size.height !== 444) return null
    try { disk.writeImage(file, image) } catch {}
    return image
  } catch {
    return null
  }
}

function colorAt(a, b, ratio) {
  const channels = [16, 8, 0].map(shift => {
    const start = (a >> shift) & 255
    const end = (b >> shift) & 255
    return Math.round(start + (end - start) * ratio).toString(16).padStart(2, '0')
  })
  return new Color('#' + channels.join(''))
}

function chassis(width, height, art, usage) {
  const canvas = new DrawContext()
  canvas.size = new Size(width, height)
  canvas.respectScreenScale = true
  const band = 4
  for (let y = 0; y < height; y += band) {
    const progress = (y / height) * 2
    const left = Math.min(1, Math.floor(progress))
    canvas.setFillColor(colorAt(stops[left], stops[left + 1], progress - left))
    canvas.fillRect(new Rect(0, y, width, band))
  }
  canvas.setFillColor(new Color('#ffffff', light ? 0.34 : 0.025))
  for (let x = 0; x < width; x += 3) canvas.fillRect(new Rect(x, 0, 0.7, height))
  if (art && usage) {
    const side = Math.min(width, height)
    const left = width - side
    const scale = side / 222
    canvas.drawImageInRect(art, new Rect(left, height - side, side, side))
    const total = sum(usage.agents.map(agent => agent.tokens)) ?? 0
    let angle = -Math.PI / 2
    for (const [index, agent] of agentIds.entries()) {
      const tokens = usage.agents.find(row => row.id === agent)?.tokens ?? 0
      if (total <= 0 || tokens <= 0) continue
      const span = (tokens / total) * Math.PI * 2
      const path = new Path()
      const segments = Math.max(2, Math.ceil(span * 23))
      for (let point = 0; point <= segments; point++) {
        const theta = angle + span * (point / segments)
        const position = new Point(left + (178 + 22.6 * Math.cos(theta)) * scale,
          height - side + (168 + 22.6 * Math.sin(theta)) * scale)
        if (point === 0) path.move(position)
        else path.addLine(position)
      }
      angle += span
      canvas.addPath(path)
      canvas.setStrokeColor(new Color(agentColors[index]))
      canvas.setLineWidth(Math.max(1, 2.4 * scale))
      canvas.strokePath()
    }
  }
  return canvas.getImage()
}

function updatedTime(raw, now) {
  if (!raw) return '—'
  const date = new Date(raw)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === new Date(now).toDateString()) return time
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function smallQuota(widget, quota, now, width) {
  for (const agent of quota.agents) {
    widget.addSpacer()
    const row = horizontal(widget)
    const active = agent.windows.filter(window => !window.resetsAt || Date.parse(window.resetsAt) > now)
    const windows = agent.id === 'antigravity' ? [...active].sort((a, b) => b.percent - a.percent) : active
    const window = windows[0] ?? agent.windows[0]
    identity(row, agent, 14)
    row.addSpacer()
    if (!window) {
      text(row, '额度暂不可用', Font.mediumSystemFont(9), palette.secondary)
      continue
    }
    const pending = window.resetsAt && Date.parse(window.resetsAt) <= now
    const bucket = window.label.toLowerCase()
    if (!pending && bucket.includes('week')) text(row, '每周', Font.mediumSystemFont(8), palette.secondary)
    else if (!pending && /(?:five|5)[ -]hour/.test(bucket)) text(row, '5 小时', Font.mediumSystemFont(8), palette.secondary)
    row.addSpacer(4)
    text(row, pending ? '待更新' : `${Math.round(100 * (1 - window.percent))}%`, Font.semiboldMonospacedSystemFont(10))
    if (!pending) bar(widget, width, 3.7, 1 - window.percent, false)
  }
}

function todayPanel(widget, usage, family, width) {
  const small = family === 'small'
  text(widget, tokenText(sum(usage.agents.map(agent => agent.tokens))), Font.boldSystemFont(small ? 25 : 33))
  const rate = hitRate(usage)
  text(widget, rate === null ? 'Token' : `Token · 缓存 ${rate}%`, Font.mediumSystemFont(8), palette.secondary)
  widget.addSpacer()
  const ranked = usage.agents.filter(agent => agent.tokens !== 0)
    .sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1))
  for (const agent of ranked) {
    const row = horizontal(widget)
    const ticker = slot(row, small ? Math.max(52, width * 0.47) : 138, 13)
    icon(ticker, agent.id, 9, 'terminal')
    ticker.addSpacer()
    text(ticker, tokenText(agent.tokens), Font.semiboldMonospacedSystemFont(8.7))
    row.addSpacer()
  }
}

function sleeveImage(usage, width, height) {
  const canvas = new DrawContext()
  canvas.size = new Size(width, height)
  canvas.opaque = false
  canvas.respectScreenScale = true
  const gap = 4
  const column = (width - 6 * gap) / 7
  const max = Math.max(1, ...usage.days.map(row => row.tokens ?? 0))
  const peak = usage.days.findIndex(row => row.tokens === max)
  for (const [index, row] of usage.days.entries()) {
    const x = index * (column + gap)
    const value = row.tokens ?? 0
    const today = row.day === usage.day
    const coverHeight = value > 0 ? Math.max(2, (height - 13) * value / max) : 1
    const y = height - coverHeight
    if (value > 0) {
      const diskHeight = today ? Math.min(12, column * 0.7) : 2
      const left = x + column * 0.1
      canvas.setFillColor(today ? new Color('#f78c47') : palette.well)
      canvas.fillEllipse(new Rect(left, y - diskHeight, column * 0.8, diskHeight * 2))
      if (today) {
        canvas.setFillColor(new Color('#ffd48b'))
        canvas.fillEllipse(new Rect(left + column * 0.23, y - diskHeight * 0.55, column * 0.34, diskHeight))
      }
    }
    canvas.setFillColor(today ? palette.accent : new Color(coverColors[index % coverColors.length]))
    canvas.fillRect(new Rect(x, y, column, coverHeight))
    if (coverHeight >= 14) {
      canvas.setTextColor(today ? new Color('#ffeed2') : palette.primary)
      canvas.setFont(Font.semiboldMonospacedSystemFont(5.5))
      canvas.drawText(String(index + 1).padStart(2, '0'), new Point(x + 2, y + 2))
    }
    if (coverHeight >= 19) {
      canvas.setFillColor(today ? new Color('#ffda86') : sleeveInk[index % sleeveInk.length])
      const mark = Math.min(5, column * 0.28)
      canvas.fillEllipse(new Rect(x + (column - mark) / 2, height - 9, mark, mark))
    }
    if (index === peak && !today && y >= 8) {
      canvas.setFillColor(new Color('#f8cc6a'))
      canvas.fillRect(new Rect(x, Math.max(0, y - 8), column, 6))
      canvas.setTextColor(new Color('#251911'))
      canvas.setFont(Font.semiboldMonospacedSystemFont(4.8))
      canvas.drawText('PEAK', new Point(x + 1, Math.max(0, y - 8)))
    }
  }
  return canvas.getImage()
}

function trendPanel(widget, usage, family, width, widgetHeight) {
  text(widget, `${tokenText(sum(usage.days.map(day => day.tokens)))} Token`,
    Font.boldSystemFont(family === 'small' ? 22 : 29))
  widget.addSpacer()
  const totalHeight = family === 'small' ? 27 : 35
  const height = Math.max(30, Math.min(62, widgetHeight - 2 * inset - 18 - 4 - totalHeight - 13 - 13 - 4))
  const display = widget.addImage(sleeveImage(usage, width, height))
  display.imageSize = new Size(width, height)
  const base = slot(widget, width, 13)
  base.backgroundColor = palette.well
  base.cornerRadius = 3
  const days = ['日', '一', '二', '三', '四', '五', '六']
  for (const entry of usage.days) {
    const day = slot(base, width / 7, 13)
    day.addSpacer()
    text(day, days[new Date(entry.day + 'T12:00:00').getDay()] ?? '—',
      Font.semiboldSystemFont(7.8), entry.day === usage.day ? palette.accent : palette.primary)
    day.addSpacer()
  }
}

function vinylWidget(card, data, status, now, family, art) {
  const widget = new ListWidget()
  widget.setPadding(inset, inset, inset, inset)
  widget.spacing = 0
  widget.refreshAfterDate = new Date(now + refreshInterval)
  widget.url = URLScheme.forRunningScript()
  const [width, height] = widgetSize(family)
  const contentWidth = width - 2 * inset
  widget.backgroundColor = palette.surface
  widget.backgroundImage = chassis(width, height, card === 'today' ? art : null, data)

  const header = slot(widget, 0, 18)
  if (card === 'today') {
    const dot = slot(header, 4, 4)
    dot.cornerRadius = 2
    dot.backgroundColor = palette.accent
    header.addSpacer(4)
  }
  text(header, {today:'今日用量', trend:'7 天趋势', quota:'套餐额度'}[card],
    Font.boldSystemFont(family === 'large' ? 14 : 11), card === 'quota' ? palette.primary : palette.accent)
  header.addSpacer()
  if (card === 'quota') {
    const dot = slot(header, 4, 4)
    dot.cornerRadius = 2
    dot.backgroundColor = palette.remaining
    header.addSpacer(4)
    text(header, '剩余', Font.mediumSystemFont(8.5), palette.secondary)
  } else if (card === 'today' && data && hitRate(data) !== null) {
    const rate = hitRate(data)
    const indicator = slot(header, 48, 13)
    indicator.cornerRadius = 6.5
    indicator.backgroundColor = palette.well
    indicator.addSpacer()
    text(indicator, `${rate}% ${rate >= 90 ? 'LOCK' : 'DRIFT'}`, Font.semiboldMonospacedSystemFont(7), palette.primary)
    indicator.addSpacer()
  } else if (card === 'trend') {
    text(header, 'LP CRATE', Font.mediumMonospacedSystemFont(7), palette.secondary)
  }

  widget.addSpacer(4)
  if (!data) {
    widget.addSpacer()
    text(widget, status ?? '等待数据同步', Font.mediumSystemFont(10), palette.secondary)
    widget.addSpacer()
  } else if (card === 'today') {
    todayPanel(widget, data, family, contentWidth)
  } else if (card === 'trend') {
    trendPanel(widget, data, family, contentWidth, height)
  } else if (family === 'small') {
    smallQuota(widget, data, now, contentWidth)
  } else {
    const large = family === 'large'
    const rowBudget = height - 2 * inset - 18 - 4 - (large ? 18 : 14) - 14 - 8
    quotaTable(widget, data, now, contentWidth, rowBudget, large)
  }

  widget.addSpacer()
  const foot = slot(widget, 0, 13)
  text(foot, `上次刷新 ${updatedTime(data?.updatedAt, now)}`, Font.mediumSystemFont(8.5), palette.secondary)
  if (data) {
    const freshness = status ?? (now - Date.parse(data.updatedAt) > 20 * 60 * 1000 ? '数据待同步' : null)
    if (freshness) {
      foot.addSpacer()
      text(foot, freshness, Font.mediumSystemFont(8.5), palette.secondary)
    }
  }
  return widget
}

const card = settings?.card ?? 'quota'
const now = Date.now()
const family = config.runsInWidget ? config.widgetFamily : card === 'quota' ? 'large' : 'small'
let { data, status } = await loadData(card)
if (card !== 'quota' && data && data.day !== calendarKey(now)) {
  data = null
  status = '等待新一日用量同步'
}
const art = card === 'today' ? await readVinyl(data) : null
const widget = vinylWidget(card, data, status, now, family, art)
if (config.runsInWidget) Script.setWidget(widget)
else if (family === 'large') await widget.presentLarge()
else await widget.presentSmall()
Script.complete()
