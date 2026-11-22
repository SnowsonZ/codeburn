import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('Swift widget reads committed snapshots and schedules civil-day rollover', { skip: process.platform !== 'darwin' }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'codeburn-swift-snapshot-'))
  try {
    const source = await readFile(new URL('../CodeBurnWidgets.swift', import.meta.url), 'utf8')
    const entryPoint = source.lastIndexOf('@main\nstruct CodeBurnWidgets: WidgetBundle')
    assert(entryPoint >= 0)
    // Compile the actual model and view implementation, substituting only a
    // synthetic test entry point so no WidgetKit extension is registered.
    const harness = `
@main
struct SnapshotValidationTest {
    static func main() throws {
        precondition(VinylFinish.system.resolved(for: .dark) == .walnut)
        precondition(VinylFinish.system.resolved(for: .light) == .silver)
        precondition(VinylFinish.dark.resolved(for: .dark) == .dark)
        precondition(VinylFinish.walnut.resolved(for: .light) == .walnut)
        let compactGrid = QuotaGridMetrics(height: 77, large: false, accountRows: 2, modelRows: 3, hasAntigravity: true)
        precondition(compactGrid.modelLimit == 3)
        precondition(5 * compactGrid.rowHeight + compactGrid.dividerHeight + 6 * compactGrid.spacing + compactGrid.headingHeight <= 77)

        let timestamp = "2026-11-20T16:00:00.000Z"
        let ids = ["codex", "zcode", "antigravity"]
        let day = "2026-11-20"
        let usage: [String: Any] = [
            "day": day, "updatedAt": timestamp,
            "agents": ids.map { ["id": $0, "tokens": 0, "input": 0, "cached": 0] as [String: Any] },
            "days": (14...20).map { ["day": "2026-11-\\($0)", "tokens": 0] as [String: Any] },
        ]
        let quota: [String: Any] = [
            "updatedAt": timestamp,
            "agents": ids.map { ["id": $0, "windows": [["label": "Weekly", "percent": 0, "resetsAt": NSNull()]]] },
        ]
        func decode(_ root: [String: Any]) throws -> Snapshot {
            try JSONDecoder().decode(Snapshot.self, from: JSONSerialization.data(withJSONObject: root))
        }
        let full = try decode(["version": 1, "updatedAt": timestamp, "usage": usage, "quota": quota])
        precondition(full.isComplete && full.usage?.total == 0)
        precondition(full.updatedAt == full.quota?.updatedAt && full.updatedAt == full.usage?.updatedAt)
        let legacy = try decode(["version": 1, "usage": usage, "quota": quota])
        precondition(!legacy.isComplete && legacy.updatedAt == nil)
        let mixed = try decode(["version": 1, "updatedAt": timestamp, "usage": usage,
            "quota": quota.merging(["updatedAt": "2026-11-20T15:00:00.000Z"]) { _, new in new }])
        precondition(!mixed.isComplete)
        let short = try decode(["version": 1, "updatedAt": timestamp, "usage": usage.merging(["agents": []]) { _, new in new }, "quota": quota])
        precondition(!short.isComplete)
        let invalidCount = try decode(["version": 1, "updatedAt": timestamp,
            "usage": usage.merging(["agents": ids.map { ["id": $0, "tokens": 0, "input": 0, "cached": NSNull()] as [String: Any] }]) { _, new in new },
            "quota": quota])
        precondition(!invalidCount.isComplete)
        let reset = QuotaWindow(label: "5-hour", percent: 1, resetsAt: timestamp)
        let other = QuotaWindow(label: "Weekly", percent: 0.1, resetsAt: nil)
        let after = parseDate(timestamp)!
        let commit = after.addingTimeInterval(-1)
        let row = QuotaAgent(id: .antigravity, windows: [other, reset])
        let displayed = row.preferredWindow(atCommit: commit)!
        precondition(displayed.label == "5-hour" && displayed.remaining == 0)
        precondition(displayed.isActive(at: commit) && !displayed.isActive(at: after))
        // Rendering keeps the same commit-selected value. Selecting by the
        // viewing date (the prior behavior) would incorrectly choose Weekly.
        precondition(row.preferredWindow(atCommit: after)?.label == "Weekly")
        precondition(row.preferredWindow(atCommit: commit)?.remaining == 0)
        precondition(QuotaAgent(id: .codex, windows: []).preferredWindow(atCommit: commit) == nil)
        let grid = WidgetCard(card: .quota, entry: .init(date: after, snapshot: full))
        _ = grid.body

        let file = URL(fileURLWithPath: CommandLine.arguments[1])
        try? FileManager.default.removeItem(at: file)
        let midnight = civilCalendar.dateInterval(of: .day, for: parseDay(day)!)!.end
        let before = midnight.addingTimeInterval(-60)
        let missing = SnapshotProvider.timeline(now: midnight, snapshot: Snapshot.load(from: file), finish: .system)
        precondition(missing.entries.count == 1 && missing.entries[0].snapshot == nil)

        func write(_ root: [String: Any]) throws {
            try JSONSerialization.data(withJSONObject: root).write(to: file)
        }
        try write(["version": 1, "usage": usage, "quota": quota])
        precondition(Snapshot.load(from: file) == nil)
        try write(["version": 1, "updatedAt": timestamp, "usage": usage, "quota": quota])
        let prior = Snapshot.load(from: file)
        let rollover = SnapshotProvider.timeline(now: before, snapshot: prior, finish: .system)
        precondition(rollover.entries.map { $0.date } == [before, midnight])
        precondition(rollover.entries[0].historicalUsageDay == nil)
        precondition(rollover.entries[1].historicalUsageDay == day)
        precondition(rollover.entries[1].snapshot?.updatedAt == timestamp)
        let stale = SnapshotProvider.timeline(now: midnight, snapshot: prior, finish: .system)
        precondition(stale.entries.count == 1 && stale.entries[0].historicalUsageDay == day)

        let currentTimestamp = midnight.ISO8601Format()
        let currentDays = (0...6).map { index in
            let date = civilCalendar.date(byAdding: .day, value: index - 6, to: midnight)!
            return ["day": dayKey(date), "tokens": 0] as [String: Any]
        }
        try write(["version": 1, "updatedAt": currentTimestamp,
            "usage": usage.merging(["day": dayKey(midnight), "days": currentDays, "updatedAt": currentTimestamp]) { _, new in new },
            "quota": quota.merging(["updatedAt": currentTimestamp]) { _, new in new }])
        let current = SnapshotProvider.timeline(now: midnight, snapshot: Snapshot.load(from: file), finish: .system)
        precondition(current.entries[0].snapshot?.usage?.day == dayKey(midnight))
        precondition(current.entries[0].historicalUsageDay == nil)
    }
}
`
    const swift = join(temporary, 'SnapshotValidationTest.swift')
    const executable = join(temporary, 'snapshot-test')
    await writeFile(swift, source.slice(0, entryPoint) + harness)
    execFileSync('xcrun', ['swiftc', '-parse-as-library', '-module-cache-path', join(temporary, 'cache'), swift, '-o', executable], { stdio: 'pipe' })
    execFileSync(executable, [join(temporary, 'snapshot.json')], { stdio: 'pipe' })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
