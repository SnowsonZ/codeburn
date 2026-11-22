import AppKit
import Foundation
import SwiftUI
import WidgetKit

private func copy(_ chinese: String, _ english: String) -> String {
    Locale.current.language.languageCode?.identifier == "zh" ? chinese : english
}

private enum Agent: String, Decodable, CaseIterable {
    case codex, zcode, antigravity

    var name: String {
        switch self {
        case .codex: "Codex"
        case .zcode: "ZCode"
        case .antigravity: "Antigravity"
        }
    }

    var color: Color {
        switch self {
        case .codex: Color(rgb: 0x06b6d4)
        case .zcode: Color(rgb: 0x4387fb)
        case .antigravity: Color(rgb: 0xd946ef)
        }
    }
}

private struct UsageAgent: Decodable {
    let id: Agent
    let tokens: Int?
    let input: Int?
    let cached: Int?

    var cacheRate: Double? {
        guard let input, let cached, input > 0, cached >= 0, cached <= input else { return nil }
        return Double(cached) / Double(input)
    }
}

private struct UsageDay: Decodable, Identifiable {
    let day: String
    let tokens: Int?
    var id: String { day }
}

private struct UsageSnapshot: Decodable {
    let day: String
    let updatedAt: String
    let agents: [UsageAgent]
    let days: [UsageDay]

    var total: Int? { sum(agents.map(\.tokens)) }

    var rankedAgents: [UsageAgent] {
        agents.filter { $0.tokens != 0 }.sorted { ($0.tokens ?? -1) > ($1.tokens ?? -1) }
    }

    var cacheRate: Double? {
        guard let input = sum(agents.map(\.input)), input > 0,
              let cached = sum(agents.map(\.cached)), cached <= input else { return nil }
        return Double(cached) / Double(input)
    }
}

private enum QuotaPeriod {
    case fiveHours, weekly

    var title: String {
        switch self {
        case .fiveHours: copy("5 小时", "5h")
        case .weekly: copy("每周", "Week")
        }
    }

}

private struct QuotaWindow: Decodable {
    let label: String
    let percent: Double
    let resetsAt: String?

    var name: String {
        switch label {
        case "5-hour": copy("5 小时", "5h")
        case "Weekly": copy("每周", "Week")
        case "Session": copy("会话", "Session")
        default: label
        }
    }

    var remaining: Double { min(1, max(0, 1 - percent)) }

    var accountPeriod: QuotaPeriod? {
        switch label {
        case "5-hour": .fiveHours
        case "Weekly": .weekly
        default: nil
        }
    }

    var modelGroup: String {
        if let separator = label.range(of: " · ") {
            return String(label[..<separator.lowerBound])
        }
        return label
    }

    var modelPeriod: QuotaPeriod? {
        guard let separator = label.range(of: " · ") else { return nil }
        let bucket = label[separator.upperBound...].lowercased().replacingOccurrences(of: "-", with: " ")
        if bucket.contains("five hour") || bucket.contains("5 hour") { return .fiveHours }
        if bucket.contains("weekly") { return .weekly }
        return nil
    }

    func isActive(at date: Date) -> Bool {
        guard let reset = parseDate(resetsAt) else { return true }
        return reset > date
    }
}

private struct QuotaAgent: Decodable {
    let id: Agent
    let windows: [QuotaWindow]
    var stale: Bool? = nil

    func preferredWindow(atCommit date: Date?) -> QuotaWindow? {
        let atCommit = date.map { date in windows.filter { $0.isActive(at: date) } } ?? windows
        return (id == .antigravity ? atCommit.min { $0.remaining < $1.remaining } : atCommit.first) ?? windows.first
    }
}

private struct ModelQuotaRow: Identifiable {
    let id: String
    let group: String
    var fiveHours: QuotaWindow? = nil
    var weekly: QuotaWindow? = nil
    var standalone: QuotaWindow? = nil
}

private func modelQuotaRows(_ windows: [QuotaWindow]) -> [ModelQuotaRow] {
    var rows: [ModelQuotaRow] = []
    for window in windows {
        let group = window.modelGroup
        guard let period = window.modelPeriod else {
            rows.append(.init(id: "other:" + window.label, group: group, standalone: window))
            continue
        }
        let index: Int
        if let existing = rows.firstIndex(where: { $0.group == group && $0.standalone == nil }) {
            index = existing
        } else {
            index = rows.count
            rows.append(.init(id: "group:" + group, group: group))
        }
        switch period {
        case .fiveHours: rows[index].fiveHours = window
        case .weekly: rows[index].weekly = window
        }
    }
    return rows
}

private struct QuotaSnapshot: Decodable {
    let updatedAt: String
    let agents: [QuotaAgent]
}

private struct Snapshot: Decodable {
    let version: Int
    // Optional for decoding pre-commit v1 files; their two block timestamps
    // cannot prove that a refresh was complete.
    let updatedAt: String?
    let usage: UsageSnapshot?
    let quota: QuotaSnapshot?

    var isComplete: Bool {
        guard version == 1, let updatedAt, parseDate(updatedAt) != nil,
              let usage, let quota, usage.updatedAt == updatedAt, quota.updatedAt == updatedAt,
              usage.agents.count == Agent.allCases.count,
              quota.agents.count == Agent.allCases.count,
              Set(usage.agents.map(\.id)) == Set(Agent.allCases),
              Set(quota.agents.map(\.id)) == Set(Agent.allCases),
              usage.days.count == 7, usage.days.last?.day == usage.day,
              Set(usage.days.map(\.day)).count == 7 else { return false }
        return usage.days.allSatisfy { row in
            guard let date = parseDay(row.day), let tokens = row.tokens else { return false }
            return dayKey(date) == row.day && tokens >= 0
        } && usage.agents.allSatisfy { row in
            guard let tokens = row.tokens, let input = row.input, let cached = row.cached else { return false }
            return cached >= 0 && cached <= input && input <= tokens
        } && quota.agents.allSatisfy { row in
            row.stale != true && !row.windows.isEmpty && row.windows.count <= (row.id == .antigravity ? 24 : 2) &&
                Set(row.windows.map(\.label)).count == row.windows.count && row.windows.allSatisfy { window in
                    window.label.utf16.count <= 120 && window.percent.isFinite &&
                        (0...1).contains(window.percent) && (window.resetsAt == nil || parseDate(window.resetsAt) != nil)
                }
        }
    }

    static func load() -> Self? {
        guard let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        return load(from: directory.appending(path: "CodeBurn Widgets/snapshot.json"))
    }

    static func load(from file: URL) -> Self? {
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 32 * 1024,
              let data = try? Data(contentsOf: file),
              let snapshot = try? JSONDecoder().decode(Self.self, from: data),
              snapshot.isComplete else { return nil }
        return snapshot
    }

    static func sample(now: Date) -> Self {
        let updated = now.ISO8601Format()
        let counts = [29_400_000, 12_800_000, 760_000]
        let agents = zip(Agent.allCases, counts).map { id, tokens in
            UsageAgent(id: id, tokens: tokens, input: tokens - 1_000, cached: tokens * 9 / 10)
        }
        let days = [16_500_000, 37_900_000, 31_300_000, 48_000_000, 25_600_000, 34_800_000, 42_960_000]
        let week = days.enumerated().map { index, tokens in
            let day = Calendar.current.date(byAdding: .day, value: index - 6, to: now) ?? now
            return UsageDay(day: dayKey(day), tokens: tokens)
        }
        let quotas = [
            QuotaAgent(id: .codex, windows: [
                QuotaWindow(label: "Weekly", percent: 0.55, resetsAt: nil),
            ]),
            QuotaAgent(id: .zcode, windows: [
                QuotaWindow(label: "Weekly", percent: 0.66, resetsAt: nil),
                QuotaWindow(label: "5-hour", percent: 0.01, resetsAt: nil),
            ]),
            QuotaAgent(id: .antigravity, windows: [
                QuotaWindow(label: "Claude and GPT models · Five Hour Limit Remaining", percent: 1, resetsAt: nil),
                QuotaWindow(label: "Claude and GPT models · Weekly Limit Remaining", percent: 0.69, resetsAt: nil),
                QuotaWindow(label: "Gemini 4 Argon · Gemini 4 Argon Weekly Limit Remaining", percent: 0.68, resetsAt: nil),
                QuotaWindow(label: "Gemini Models · Five Hour Limit Remaining", percent: 0.24, resetsAt: nil),
                QuotaWindow(label: "Gemini Models · Weekly Limit Remaining", percent: 0.25, resetsAt: nil),
            ]),
        ]
        return .init(version: 1, updatedAt: updated, usage: .init(day: dayKey(now), updatedAt: updated, agents: agents, days: week),
                     quota: .init(updatedAt: updated, agents: quotas))
    }
}

private var civilCalendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .autoupdatingCurrent
    return calendar
}

private func dayKey(_ date: Date) -> String {
    let civil = civilCalendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", civil.year ?? 0, civil.month ?? 0, civil.day ?? 0)
}

private func parseDay(_ day: String) -> Date? {
    let parts = day.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return nil }
    return civilCalendar.date(from: .init(year: parts[0], month: parts[1], day: parts[2], hour: 12))
}

private func parseDate(_ value: String?) -> Date? {
    guard let value else { return nil }
    return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
        ?? (try? Date.ISO8601FormatStyle().parse(value))
}

private func sum(_ values: [Int?]) -> Int? {
    let known = values.compactMap { $0 }
    return known.count == values.count ? known.reduce(0, +) : nil
}

private func tokenParts(_ value: Int?) -> (number: String, unit: String) {
    guard let value, value >= 0 else { return ("—", "") }
    let units = ["", "K", "M", "B"]
    var index = 0
    var amount = Double(value)
    while amount >= 1_000 && index < units.count - 1 {
        amount /= 1_000
        index += 1
    }
    let decimals = index == 0 ? 0 : amount < 10 ? 2 : amount < 100 ? 1 : 0
    let scale = pow(10.0, Double(decimals))
    var rounded = (amount * scale).rounded() / scale
    if rounded >= 1_000 && index < units.count - 1 {
        rounded /= 1_000
        index += 1
    }
    let number = rounded.formatted(.number.precision(.fractionLength(0...decimals)).grouping(.never))
    return (number, units[index])
}

private func compact(_ value: Int?) -> String {
    let parts = tokenParts(value)
    return parts.unit.isEmpty ? parts.number : parts.number + " " + parts.unit
}

private func percent(_ value: Double) -> String {
    value.formatted(.percent.precision(.fractionLength(0)))
}

private enum Card: String {
    case today, trend, quota

    var title: String {
        switch self {
        case .today: copy("今日用量", "Today’s usage")
        case .trend: copy("7 天趋势", "7-day trend")
        case .quota: copy("套餐额度", "Plan quota")
        }
    }

    var description: String {
        switch self {
        case .today: copy("三款 Agent 的用量和缓存命中率。", "Tokens and cache hits for your three agents.")
        case .trend: copy("最近 7 天的用量。", "Tokens used over the last seven days.")
        case .quota: copy("各 Agent 的套餐窗口及剩余比例。", "Remaining percentage for each agent’s plan windows.")
        }
    }

    var symbol: String {
        switch self {
        case .today: "flame.fill"
        case .trend: "chart.bar.xaxis"
        case .quota: "gauge.with.dots.needle.33percent"
        }
    }
}

private enum VinylFinish: String {
    case silver, dark, walnut, system

    func resolved(for colorScheme: ColorScheme) -> Self {
        guard self == .system else { return self }
        return colorScheme == .dark ? .walnut : .silver
    }

    static func load() -> Self {
        guard let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return .system
        }
        let file = directory.appending(path: "CodeBurn Widgets/vinyl-finish")
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 16,
              let value = try? String(contentsOf: file, encoding: .utf8),
              let finish = Self(rawValue: value.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return .system
        }
        return finish
    }

    var assets: String {
        switch self {
        case .silver, .system: "light"
        case .dark: "dark"
        case .walnut: "walnut"
        }
    }

    var light: Bool { self == .silver }

    var chassis: [Color] {
        switch self {
        case .silver, .system: [Color(rgb: 0xf6f4ef), Color(rgb: 0xece8e0), Color(rgb: 0xe3ded4)]
        case .dark: [Color(rgb: 0x22201f), Color(rgb: 0x161514), Color(rgb: 0x100f0f)]
        case .walnut: [Color(rgb: 0x3c281d), Color(rgb: 0x271a12), Color(rgb: 0x1b120d)]
        }
    }

    var ink: Color {
        light ? Color(rgb: 0x181614) : self == .walnut ? Color(rgb: 0xfaf2e6) : Color(rgb: 0xf6f1ea)
    }

    var subtitle: Color {
        light ? Color(rgb: 0x5b554e) : self == .walnut ? Color(rgb: 0xc9b096) : Color(rgb: 0xa39a92)
    }

    var orange: Color {
        light ? Color(rgb: 0xd14114) : self == .walnut ? Color(rgb: 0xf68646) : Color(rgb: 0xf9671e)
    }

    var eject: Color { light ? Color(rgb: 0xb51d44) : Color(rgb: 0xfb7185) }
    var well: Color { light ? Color(rgb: 0xcec7bc).opacity(0.7) : Color.black.opacity(0.5) }
    var cassetteWell: Color {
        light ? Color(rgb: 0xd1b6a4).opacity(0.46) : Color(rgb: 0x402c24).opacity(0.68)
    }
    var usedTape: Color {
        light ? Color(rgb: 0x998375).opacity(0.48) : Color(rgb: 0xa38476).opacity(0.29)
    }

    var sleeves: [UInt32] {
        switch self {
        case .silver, .system: [0xdcd4c8, 0xd2c9bc, 0xd9cdc0, 0xcfc4b4, 0xd7ccbe, 0xcec6ba]
        case .dark: [0x837168, 0x716159, 0x998579, 0xa7917f, 0x7f6c62, 0x957f70]
        case .walnut: [0xb88d60, 0xaf805a, 0xc6a586, 0xc89454, 0xae917e, 0xc7a78b]
        }
    }
}

private struct Entry: TimelineEntry {
    let date: Date
    let snapshot: Snapshot?
    var finish: VinylFinish = .system

    var historicalUsageDay: String? {
        guard let day = snapshot?.usage?.day, day != dayKey(date) else { return nil }
        return day
    }
}

private struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> Entry {
        let now = Date()
        return .init(date: now, snapshot: .sample(now: now), finish: .load())
    }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : .init(date: Date(), snapshot: .load(), finish: .load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let snapshot = Snapshot.load()
        completion(Self.timeline(now: Date(), snapshot: snapshot, finish: .load()))
    }

    static func timeline(now: Date, snapshot: Snapshot?, finish: VinylFinish) -> Timeline<Entry> {
        let entry = Entry(date: now, snapshot: snapshot, finish: finish)
        let windows = snapshot?.quota?.agents.flatMap(\.windows) ?? []
        let waitingForQuota = windows.contains { !$0.isActive(at: now) }
        let waitingForUsage = snapshot == nil || entry.historicalUsageDay != nil
        let interval: TimeInterval = waitingForUsage || waitingForQuota ? 5 * 60 : 15 * 60
        let midnight = civilCalendar.dateInterval(of: .day, for: now)?.end
        let reset = windows.compactMap { parseDate($0.resetsAt) }.filter { $0 > now }.min()
        let next = min(now.addingTimeInterval(interval), midnight ?? .distantFuture, reset ?? .distantFuture)
        var entries = [entry]
        // WidgetKit can advance this entry even if it defers the reload request.
        if let midnight, snapshot?.usage != nil, entry.historicalUsageDay == nil {
            entries.append(.init(date: midnight, snapshot: snapshot, finish: finish))
        }
        return Timeline(entries: entries, policy: .after(next))
    }
}

private struct QuotaGridMetrics {
    let rowHeight: CGFloat
    let dividerHeight: CGFloat
    let spacing: CGFloat
    let headingHeight: CGFloat
    let modelLimit: Int

    init(height: CGFloat, large: Bool, accountRows: Int, modelRows: Int, hasAntigravity: Bool) {
        headingHeight = large ? 17 : 12
        let budget = max(0, height - headingHeight)
        let providerRow = hasAntigravity ? 1 : 0
        let dividerCount = hasAntigravity && modelRows > 0 ? 1 : 0
        let dividerBudget = CGFloat(dividerCount) * (large ? 19 : 9)
        let fixedDataRows = accountRows + providerRow - dividerCount
        let capacity = max(0, Int(max(0, budget - dividerBudget) / (large ? 19 : 11)) - fixedDataRows)
        let limit = min(modelRows, capacity)
        modelLimit = limit
        let dataRows = CGFloat(max(1, fixedDataRows + limit))
        let rowCount = dataRows + CGFloat(dividerCount)
        let pitch = budget / rowCount
        let gap: CGFloat = large && pitch >= 24 ? 4 : pitch >= 16 ? 2 : 1
        spacing = gap
        let divider = max(0, min(large ? 24 : 12, floor(pitch - gap)))
        dividerHeight = divider
        let remaining = budget - rowCount * gap - CGFloat(dividerCount) * divider
        rowHeight = max(0, min(large ? 43 : 24, floor(remaining / dataRows)))
    }

    var valueSize: CGFloat { min(18, max(7, floor(rowHeight * 0.84))) }
    var valueWidth: CGFloat { max(32, ceil(valueSize * 2.5 + 3)) }
    var iconSize: CGFloat { min(21, max(7, rowHeight - 2)) }
    var barHeight: CGFloat { min(max(1, rowHeight - 2), round(valueSize * 1.2)) }
}

private struct WidgetCard: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let card: Card
    let entry: Entry

    private var wide: Bool { family != .systemSmall }
    private var large: Bool { family == .systemLarge }
    private var finish: VinylFinish { entry.finish.resolved(for: colorScheme) }
    private var secondaryColor: Color { finish.subtitle }
    private var ruleColor: Color { finish.ink.opacity(finish.light ? 0.16 : 0.18) }
    private var quotaIconSize: CGFloat { large ? 17 : 12 }
    private let quotaProviderAxis: CGFloat = 11
    private let quotaIconGap: CGFloat = 3
    private var quotaIdentityWidth: CGFloat { large ? 48 : 38 }
    private var quotaValueGap: CGFloat { large ? 7 : 4 }
    private var inset: CGFloat { wide ? 14 : 11 }
    private var updateAnimation: Animation? { reduceMotion ? nil : .easeOut(duration: 0.32) }
    private var usage: UsageSnapshot? { entry.snapshot?.usage }

    private var cardTitle: String {
        guard card != .quota, let day = entry.historicalUsageDay else { return card.title }
        let date = String(day.suffix(5))
        return card == .today ? copy("用量 " + date, "Usage " + date)
            : copy("趋势截至 " + date, "Trend to " + date)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: large ? 9 : 5) {
            header
            panelContent.frame(maxWidth: .infinity, maxHeight: .infinity)
            refreshTime
        }
        .foregroundStyle(finish.ink)
        .padding(inset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(alignment: .bottomTrailing) {
            if card == .today, let usage { platter(usage) }
        }
        .containerBackground(for: .widget) { chassis }
    }

    private var chassis: some View {
        LinearGradient(colors: finish.chassis, startPoint: .topLeading, endPoint: .bottomTrailing)
            .overlay {
                Canvas { context, size in
                    var path = Path()
                    for x in stride(from: 0.0, to: size.width, by: 3) {
                        path.move(to: .init(x: x, y: 0))
                        path.addLine(to: .init(x: x, y: size.height))
                    }
                    context.stroke(path, with: .color(.white.opacity(finish.light ? 0.34 : 0.033)), lineWidth: 0.65)
                }
            }
            .accessibilityHidden(true)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 4) {
            VStack(alignment: .leading, spacing: 2) {
                Text(cardTitle)
                    .font(.system(size: large ? 16 : 12, weight: .bold))
                    .foregroundStyle(finish.orange)
                    .lineLimit(1).layoutPriority(1)
                    .accessibilityAddTraits(.isHeader)
                equipmentLabel
                    .frame(height: large ? 12 : 9)
            }
            Spacer(minLength: 0)
            if let status = headerStatus {
                HStack(spacing: 4) {
                    Circle().fill(finish.orange).frame(width: 4, height: 4).accessibilityHidden(true)
                    HStack(alignment: .lastTextBaseline, spacing: 2) {
                        Text(status.label)
                            .monospacedDigit()
                            .contentTransition(reduceMotion ? .identity : .numericText())
                            .animation(updateAnimation, value: status.label)
                        if !status.unit.isEmpty {
                            Text(status.unit)
                                .font(.system(size: large ? 8 : 6.5, weight: .medium))
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(card == .today
                        ? status.label.replacingOccurrences(of: "Cache", with: copy("缓存命中率", "Cache hit rate"))
                        : (status.unit.isEmpty ? status.label : status.label + " " + status.unit))
                }
                .font(.system(size: large ? 10.5 : 8.5, weight: .medium))
                .foregroundStyle(secondaryColor)
                .lineLimit(1)
                .padding(.trailing, card == .quota ? (wide ? 10 : 6) : 0)
            }
        }
    }

    private var equipmentLabel: some View {
        let name = switch card {
        case .today: "TURNTABLE"
        case .trend: "LP CRATE"
        case .quota: "DUAL CASSETTE DECK"
        }
        return Text(name)
            .font(.system(size: large ? 9 : 7.5, weight: .medium, design: .monospaced))
            .tracking(0.5).foregroundStyle(secondaryColor)
            .lineLimit(1).minimumScaleFactor(0.68)
            .accessibilityHidden(true)
    }

    private var headerStatus: (label: String, unit: String)? {
        switch card {
        case .quota: (copy("剩余", "Remaining"), "")
        case .today: usage?.cacheRate.map { ("Cache " + percent($0), "") }
        case .trend: usage?.days.compactMap(\.tokens).max().map {
            let parts = tokenParts($0)
            return ("Max " + parts.number, parts.unit)
        }
        }
    }

    @ViewBuilder
    private var panelContent: some View {
        switch card {
        case .today:
            if let usage { today(usage) }
            else { empty(copy("打开 CodeBurn 同步", "Open CodeBurn to sync")) }
        case .trend:
            if let usage { trend(usage) }
            else { empty(copy("等待用量同步", "Waiting for usage")) }
        case .quota:
            if let quota = entry.snapshot?.quota { quotas(quota) }
            else { empty(copy("等待额度同步", "Waiting for quota")) }
        }
    }

    private func empty(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(secondaryColor)
            .multilineTextAlignment(.center)
    }

    private var refreshTime: some View {
        let updated = parseDate(entry.snapshot?.updatedAt)
        return HStack(spacing: 4) {
            Text(copy("上次刷新", "Updated"))
            if let updated {
                if civilCalendar.isDate(updated, inSameDayAs: entry.date) {
                    Text(updated, style: .time)
                } else {
                    Text(updated, format: .dateTime.month(.defaultDigits).day().hour().minute())
                }
                if entry.date.timeIntervalSince(updated) > 20 * 60 {
                    Text(copy("· 待更新", "· Pending"))
                }
            } else {
                Text("—")
            }
        }
        .font(.system(size: large ? 11 : 9, weight: .medium))
        .monospacedDigit().foregroundStyle(secondaryColor).lineLimit(1).minimumScaleFactor(0.8)
        .accessibilityElement(children: .combine)
    }

    private func today(_ usage: UsageSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            usageTotal(usage.total).frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
            GeometryReader { geometry in
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(usage.rankedAgents, id: \.id) { row in
                        HStack(spacing: 4) {
                            quotaLogo("provider-" + row.id.rawValue, fallback: "terminal", size: 10)
                                .foregroundStyle(finish.ink)
                            if !wide { Spacer(minLength: 2) }
                            tokenValue(row.tokens, numberSize: wide ? 10 : 9, unitSize: 7, detail: true)
                            if wide, let rate = row.cacheRate {
                                Text(percent(rate)).foregroundStyle(secondaryColor)
                            }
                        }
                        .font(.system(size: wide ? 10 : 9, weight: .semibold, design: .monospaced))
                        .monospacedDigit().lineLimit(1)
                        .frame(width: wide ? min(geometry.size.width, 150) : geometry.size.width * 0.48, alignment: .leading)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(row.id.name + " " + compact(row.tokens) + " Tokens"
                            + (row.cacheRate.map { " · " + copy("缓存命中", "Cache hit") + " " + percent($0) } ?? ""))
                    }
                }
            }
            .frame(height: CGFloat(max(1, usage.rankedAgents.count)) * 13)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func platter(_ usage: UsageSnapshot) -> some View {
        let groove = max(2, min(36, Int((36 * min(1, Double(usage.total ?? 0) / 1_000_000_000)).rounded())))
        let imageURL = Bundle.main.url(forResource: finish.assets + "-\(groove)", withExtension: "png", subdirectory: "Vinyl")
        let image = imageURL.flatMap(NSImage.init(contentsOf:))
        return GeometryReader { geometry in
            let size = min(geometry.size.width, geometry.size.height)
            let scale = size / 222
            let total = Double(usage.total ?? 0)
            ZStack(alignment: .topLeading) {
                if let image {
                    Image(nsImage: image).resizable().interpolation(.high)
                        .id(groove).transition(reduceMotion ? .identity : .opacity)
                }
                Canvas { context, _ in
                    guard total > 0 else { return }
                    var offset = -90.0
                    for agent in Agent.allCases {
                        let tokens = Double(usage.agents.first { $0.id == agent }?.tokens ?? 0)
                        let amount = 360 * tokens / total
                        if amount > 0 {
                            var path = Path()
                            path.addArc(center: .init(x: 178 * scale, y: 168 * scale), radius: 22.6 * scale,
                                        startAngle: .degrees(offset), endAngle: .degrees(offset + amount), clockwise: false)
                            context.stroke(path, with: .color(agent.color), lineWidth: max(1, 2.4 * scale))
                            offset += amount
                        }
                    }
                }
            }
            .frame(width: size, height: size)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            .animation(updateAnimation, value: groove)
        }
        .accessibilityHidden(true)
    }

    private func tokenValue(_ total: Int?, numberSize: CGFloat, unitSize: CGFloat, detail: Bool = false) -> some View {
        let parts = tokenParts(total)
        return HStack(alignment: .lastTextBaseline, spacing: detail ? 2 : 3) {
            Text(parts.number)
                .font(.system(size: numberSize, weight: detail ? .semibold : .black,
                              design: detail ? .monospaced : .default))
                .tracking(detail ? 0 : -0.75)
                .foregroundStyle(detail ? finish.orange : finish.ink)
                .monospacedDigit().lineLimit(1).minimumScaleFactor(detail ? 0.72 : 0.62)
                .contentTransition(reduceMotion ? .identity : .numericText())
                .animation(updateAnimation, value: total)
            if !parts.unit.isEmpty {
                Text(parts.unit)
                    .font(.system(size: unitSize, weight: .semibold))
                    .foregroundStyle(detail ? finish.orange : secondaryColor)
            }
            if !detail {
                Text("Tokens")
                    .font(.system(size: wide ? 8 : 7, weight: .medium))
                    .foregroundStyle(secondaryColor)
                    .lineLimit(1).fixedSize(horizontal: true, vertical: false)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func usageTotal(_ total: Int?) -> some View {
        tokenValue(total, numberSize: wide ? 30 : 26, unitSize: wide ? 11 : 9.5)
    }

    private func trend(_ usage: UsageSnapshot) -> some View {
        let maximum = max(1, usage.days.compactMap(\.tokens).max() ?? 0)
        let peakId = usage.days.first { ($0.tokens ?? 0) == maximum }?.id
        return VStack(alignment: .leading, spacing: 4) {
            usageTotal(sum(usage.days.map(\.tokens)))
            GeometryReader { geometry in
                let gap: CGFloat = wide ? 7 : 3.5
                let deck: CGFloat = 10.5
                let axisWidth = geometry.size.width * (wide ? 0.88 : 0.86)
                let columns = max(1, usage.days.count)
                let column = max(0, (axisWidth - CGFloat(columns - 1) * gap) / CGFloat(columns))
                let coverHeight = max(0, geometry.size.height - deck - 2)
                VStack(spacing: 2) {
                    HStack(alignment: .bottom, spacing: gap) {
                        ForEach(Array(usage.days.enumerated()), id: \.element.id) { index, row in
                            sleeve(row, index: index, maximum: maximum, height: coverHeight,
                                   today: row.day == usage.day, peak: peakId == row.id)
                                .frame(width: column)
                        }
                    }
                    .frame(width: axisWidth, height: coverHeight, alignment: .bottom)
                    HStack(spacing: gap) {
                        ForEach(usage.days) { row in
                            Text(parseDay(row.day)?.formatted(.dateTime.weekday(.narrow)) ?? "—")
                                .font(.system(size: 7.75, weight: .semibold, design: .monospaced))
                                .foregroundStyle(row.day == usage.day ? finish.orange : finish.ink)
                                .lineLimit(1).minimumScaleFactor(0.8)
                                .frame(width: column)
                        }
                    }
                    .frame(width: axisWidth, height: deck)
                    .overlay(alignment: .top) { Rectangle().fill(ruleColor).frame(height: 0.5) }
                    .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            }
        }
    }

    private func sleeve(_ day: UsageDay, index: Int, maximum: Int, height: CGFloat, today: Bool, peak: Bool) -> some View {
        let palette = finish.sleeves[index % finish.sleeves.count]
        let ratio = CGFloat(day.tokens ?? 0) / CGFloat(maximum)
        let diskHeight: CGFloat = today ? 9 : 2
        let maxCover = max(1, height - diskHeight - 9)
        return VStack(spacing: 0) {
            if peak && !today {
                Text(copy("峰值", "PEAK")).font(.system(size: 5.5, weight: .black, design: .monospaced))
                    .lineLimit(1).minimumScaleFactor(0.65)
                    .foregroundStyle(Color(rgb: 0x251911))
                    .padding(.horizontal, 2).padding(.vertical, 0.65)
                    .background(Color(rgb: 0xf8cc6a), in: RoundedRectangle(cornerRadius: 2))
            }
            if day.tokens != nil && ratio > 0 {
                ZStack {
                    UnevenRoundedRectangle(topLeadingRadius: 8, topTrailingRadius: 8)
                        .fill(today ? LinearGradient(colors: [Color(rgb: 0xffe5ab), finish.orange],
                                                     startPoint: .top, endPoint: .bottom)
                                    : LinearGradient(colors: [.black.opacity(0.65), .black.opacity(0.65)],
                                                     startPoint: .top, endPoint: .bottom))
                    if today { Capsule().strokeBorder(.white.opacity(0.28), lineWidth: 0.5).padding(1.5) }
                }
                .frame(height: diskHeight)
                .transition(.offset(y: 4).combined(with: .opacity))
            }
            if let value = day.tokens {
                let coverHeight = value == 0 ? 1 : max(2, maxCover * ratio)
                UnevenRoundedRectangle(topLeadingRadius: 2.5, topTrailingRadius: 2.5)
                    .fill(today ? finish.orange : Color(rgb: palette))
                    .overlay { UnevenRoundedRectangle(topLeadingRadius: 2.5, topTrailingRadius: 2.5).strokeBorder(ruleColor, lineWidth: 0.55) }
                    .frame(height: coverHeight)
            } else {
                Rectangle().fill(ruleColor).frame(height: 1)
            }
        }
        .frame(maxWidth: .infinity)
        .animation(updateAnimation, value: ratio)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(day.day + ", " + compact(day.tokens) + " Tokens")
    }

    @ViewBuilder
    private func quotas(_ quota: QuotaSnapshot) -> some View {
        if wide {
            quotaTable(quota)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(quota.agents, id: \.id) { row in
                    if row.id != quota.agents.first?.id { Spacer(minLength: 2) }
                    if let window = row.preferredWindow(atCommit: parseDate(quota.updatedAt)) {
                        let expired = !window.isActive(at: entry.date)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 4) {
                                quotaSourceIcon(row)
                                if row.id == .antigravity {
                                    Rectangle().fill(Color.secondary.opacity(0.26)).frame(width: 1, height: 10)
                                        .accessibilityHidden(true)
                                    modelIcon(window.modelGroup, size: quotaIconSize)
                                }
                                Spacer(minLength: 0)
                                if row.id == .antigravity {
                                    if let period = window.modelPeriod { periodLabel(period) }
                                } else if let period = window.accountPeriod {
                                    periodLabel(period)
                                } else {
                                    Text(window.name).font(.system(size: 9)).foregroundStyle(secondaryColor).lineLimit(1)
                                }
                                if expired { expiredQuotaBadge }
                                remainingValue(window, expired: expired)
                            }
                            .font(.system(size: 11.5, weight: .medium))
                            quotaBar(window).opacity(expired ? 0.55 : 1)
                        }
                        .accessibilityElement(children: .combine)
                    } else {
                        HStack {
                            quotaSourceIcon(row)
                            Spacer(minLength: 0)
                            unavailableQuotaValue
                        }
                    }
                }
            }
        }
    }

    private func quotaTable(_ quota: QuotaSnapshot) -> some View {
        let accounts = quota.agents.filter { $0.id != .antigravity }
        let antigravity = quota.agents.first { $0.id == .antigravity }
        let models = modelQuotaRows(antigravity?.windows ?? [])
        let accountRowCount = accounts.reduce(0) { count, agent in
            let other = agent.windows.count { $0.accountPeriod == nil }
            return count + max(1, other + (other < agent.windows.count ? 1 : 0))
        }
        return GeometryReader { geometry in
            let metrics = QuotaGridMetrics(height: geometry.size.height, large: large, accountRows: accountRowCount,
                                           modelRows: models.count, hasAntigravity: antigravity != nil)
            let gap: CGFloat = large ? 10 : 7
            let column = max(0, (geometry.size.width - quotaIdentityWidth - 2 * gap) / 2)
            Grid(alignment: .leading, horizontalSpacing: gap, verticalSpacing: metrics.spacing) {
                GridRow {
                    Color.clear.frame(width: quotaIdentityWidth, height: 1).accessibilityHidden(true)
                    quotaColumnHeading(.fiveHours, column: column, metrics: metrics)
                    quotaColumnHeading(.weekly, column: column, metrics: metrics)
                }
                .frame(height: metrics.headingHeight)
                ForEach(accounts, id: \.id) { account in
                    accountQuotaRows(account, metrics: metrics, column: column, gap: gap)
                }
                if let antigravity, models.isEmpty {
                    unavailableQuotaRow(antigravity, metrics: metrics)
                } else if let antigravity {
                    GridRow {
                        quotaIconCell(quotaSourceIcon(antigravity, size: min(19, max(7, metrics.dividerHeight - 1))),
                                      height: metrics.dividerHeight)
                        HStack(spacing: 6) {
                            Rectangle().fill(ruleColor).frame(height: 1).accessibilityHidden(true)
                            if models.count > metrics.modelLimit {
                                let extra = models.count - metrics.modelLimit
                                Text("+\(extra)").font(.system(size: 9)).foregroundStyle(secondaryColor)
                                    .accessibilityLabel(copy("另有 \(extra) 条额度", "\(extra) more quota rows"))
                            }
                        }
                        .frame(width: column * 2 + gap)
                        .gridCellColumns(2)
                    }
                    ForEach(models.prefix(metrics.modelLimit)) { model in
                        GridRow {
                            modelQuotaIconCell(model.group, height: metrics.rowHeight)
                            if let standalone = model.standalone {
                                quotaCell(standalone, metrics: metrics)
                                    .frame(width: column * 2 + gap).gridCellColumns(2)
                            } else {
                                quotaCell(model.fiveHours, metrics: metrics, period: .fiveHours).frame(width: column)
                                quotaCell(model.weekly, metrics: metrics, period: .weekly).frame(width: column)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private func accountQuotaRows(_ account: QuotaAgent, metrics: QuotaGridMetrics, column: CGFloat, gap: CGFloat) -> some View {
        let windows = account.windows
        let fiveHours = windows.first { $0.accountPeriod == .fiveHours }
        let weekly = windows.first { $0.accountPeriod == .weekly }
        if windows.isEmpty { unavailableQuotaRow(account, metrics: metrics) }
        if fiveHours != nil || weekly != nil {
            GridRow {
                quotaIconCell(quotaSourceIcon(account, size: metrics.iconSize), height: metrics.rowHeight)
                quotaCell(fiveHours, metrics: metrics, period: .fiveHours).frame(width: column)
                quotaCell(weekly, metrics: metrics, period: .weekly).frame(width: column)
            }
        }
        ForEach(windows.filter { $0.accountPeriod == nil }, id: \.label) { window in
            GridRow {
                quotaIconCell(quotaSourceIcon(account, size: metrics.iconSize), height: metrics.rowHeight)
                HStack(spacing: 5) {
                    Text(window.name).font(.system(size: 9)).foregroundStyle(secondaryColor).lineLimit(1)
                    quotaCell(window, metrics: metrics)
                }
                .frame(width: column * 2 + gap)
                .gridCellColumns(2)
            }
        }
    }

    private func quotaIconCell<Icon: View>(_ icon: Icon, height: CGFloat) -> some View {
        icon.frame(width: quotaIdentityWidth, height: height, alignment: .leading)
    }

    private var unavailableQuotaValue: some View {
        Text(copy("额度暂不可用", "Quota unavailable"))
            .font(.system(size: large ? 12 : 10, weight: .medium))
            .foregroundStyle(secondaryColor)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

    private func unavailableQuotaRow(_ agent: QuotaAgent, metrics: QuotaGridMetrics) -> some View {
        GridRow {
            quotaIconCell(quotaSourceIcon(agent, size: metrics.iconSize), height: metrics.rowHeight)
            unavailableQuotaValue
                .frame(maxWidth: .infinity, alignment: .trailing)
                .gridCellColumns(2)
        }
    }

    private func quotaSourceIcon(_ agent: QuotaAgent, size: CGFloat? = nil) -> some View {
        HStack(spacing: 4) {
            quotaLogo("provider-" + agent.id.rawValue, fallback: "terminal", size: size ?? quotaIconSize)
                .frame(width: quotaProviderAxis * 2)
                .accessibilityLabel(agent.id.name)
                .help(agent.id.name)
            if agent.stale == true {
                let title = copy("显示上次取得的额度", "Showing last known quota")
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: large ? 10 : 8))
                    .foregroundStyle(secondaryColor)
                    .accessibilityLabel(title)
                    .help(title)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func modelQuotaIconCell(_ group: String, height: CGFloat) -> some View {
        quotaIconCell(
            HStack(spacing: quotaIconGap) {
                Rectangle().fill(ruleColor).frame(width: 1, height: height).accessibilityHidden(true)
                modelIcon(group, size: min(quotaIconSize - 2, max(7, height - 2)))
            }
            .padding(.leading, quotaProviderAxis - 0.5), height: height)
    }

    private func periodLabel(_ period: QuotaPeriod) -> some View {
        Text(period.title)
            .font(.system(size: large ? 11.5 : 9.5, weight: .medium)).foregroundStyle(secondaryColor)
            .lineLimit(1)
    }

    private func quotaColumnHeading(_ period: QuotaPeriod, column: CGFloat, metrics: QuotaGridMetrics) -> some View {
        periodLabel(period)
            .frame(width: max(0, column - metrics.valueWidth - quotaValueGap))
            .frame(width: column, alignment: .leading)
    }

    private func modelIcon(_ group: String, size: CGFloat) -> some View {
        let name = group.lowercased()
        let claude = name.contains("claude")
        let gpt = name.contains("gpt")
        let gemini = name.contains("gemini")
        return HStack(spacing: quotaIconGap) {
            Group {
                if claude {
                    quotaLogo("provider-claude", fallback: "sun.max", size: size)
                } else if gpt {
                    quotaLogo("provider-codex", fallback: "circle.hexagongrid", size: size)
                } else if gemini {
                    quotaLogo("provider-gemini", fallback: "sparkle", size: size)
                } else {
                    Image(systemName: "cpu").font(.system(size: size))
                }
            }
            .frame(width: size, height: size)
            Group {
                if claude && gpt {
                    quotaLogo("provider-codex", fallback: "circle.hexagongrid", size: size)
                } else if gemini && name.contains("argon") {
                    Text("Ar")
                        .font(.system(size: min(8, size * 0.7), weight: .semibold, design: .monospaced))
                        .fixedSize()
                        .padding(.horizontal, large ? 2 : 1).padding(.vertical, 1)
                        .background(Color.secondary.opacity(0.2), in: RoundedRectangle(cornerRadius: 3))
                } else {
                    Color.clear
                }
            }
            .frame(width: size, height: size)
        }
        .foregroundStyle(finish.ink)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(group)
        .help(group)
    }

    @ViewBuilder
    private func quotaLogo(_ name: String, fallback: String, size: CGFloat) -> some View {
        if let url = Bundle.main.url(forResource: name, withExtension: "svg"),
           let image = NSImage(contentsOf: url) {
            Image(nsImage: image).renderingMode(.template).resizable().scaledToFit()
                .frame(width: size, height: size)
                .scaleEffect(name == "provider-zcode" ? 1.3 : 1)

        } else {
            Image(systemName: fallback).font(.system(size: size))
                .frame(width: size, height: size)
        }
    }

    private func remainingValue(_ window: QuotaWindow, expired: Bool = false) -> some View {
        let rate = percent(window.remaining)
        return Text(rate)
            .monospacedDigit().lineLimit(1).fixedSize()
            .contentTransition(reduceMotion ? .identity : .numericText(value: window.remaining * 100))
            .animation(updateAnimation, value: window.remaining)
            .opacity(expired ? 0.65 : 1)
            .accessibilityLabel(quotaAccessibilityTitle(window, expired: expired))
    }

    private var expiredQuotaBadge: some View {
        Text(copy("已过期", "Expired"))
            .font(.system(size: large ? 9 : 8, weight: .medium))
            .foregroundStyle(secondaryColor)
            .lineLimit(1)
            .fixedSize()
    }

    private func quotaAccessibilityTitle(_ window: QuotaWindow, expired: Bool) -> String {
        (expired ? copy("已过期，历史剩余", "Expired, last known remaining") : copy("剩余", "Remaining"))
            + " " + percent(window.remaining)
    }

    @ViewBuilder
    private func quotaCell(_ window: QuotaWindow?, metrics: QuotaGridMetrics, period: QuotaPeriod? = nil) -> some View {
        if let window {
            let expired = !window.isActive(at: entry.date)
            HStack(spacing: quotaValueGap) {
                cassette(window, height: metrics.barHeight).opacity(expired ? 0.55 : 1)
                if expired { expiredQuotaBadge }
                remainingValue(window, expired: expired).frame(width: metrics.valueWidth, alignment: .trailing)
            }
            .font(.system(size: metrics.valueSize, weight: .semibold, design: .monospaced))
            .frame(height: metrics.rowHeight)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel((period?.title ?? window.name) + " " + quotaAccessibilityTitle(window, expired: expired))
        } else {
            Color.clear.frame(height: metrics.rowHeight)
                .gridCellUnsizedAxes(.horizontal)
                .accessibilityHidden(true)
        }
    }

    private func cassette(_ window: QuotaWindow, height: CGFloat) -> some View {
        let proportion = window.remaining
        let tint = finish.orange
        return GeometryReader { geometry in
            let spoolSize = min(geometry.size.height - 2, geometry.size.width * 0.21)
            ZStack {
                RoundedRectangle(cornerRadius: 3).fill(finish.cassetteWell)
                RoundedRectangle(cornerRadius: 3).strokeBorder(proportion == 0 ? finish.eject.opacity(0.64) : ruleColor, lineWidth: 0.7)
                if proportion == 0 {
                    Text(copy("耗尽", "EJECT")).font(.system(size: height > 14 ? 8 : 6.5, weight: .bold, design: .monospaced))
                        .tracking(0.55).foregroundStyle(finish.eject)
                } else {
                    HStack(spacing: 2) {
                        if spoolSize >= 5 {
                            spool(remaining: proportion, tint: tint, side: spoolSize)
                        }
                        tapeProgress(proportion, tint: tint, height: min(6, height * 0.36), ticks: true)
                        if spoolSize >= 5 {
                            spool(remaining: 1 - proportion, tint: secondaryColor.opacity(0.65), side: spoolSize)
                        }
                    }
                    .padding(.horizontal, 3)
                }
            }
            .animation(updateAnimation, value: proportion)
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }

    private func spool(remaining: Double, tint: Color, side: CGFloat) -> some View {
        let diameter = side * (0.4 + 0.54 * remaining)
        return ZStack {
            Circle().fill(tint.opacity(0.28)).frame(width: diameter, height: diameter)
            Circle().strokeBorder(tint.opacity(0.8), lineWidth: 0.75)
                .frame(width: side * 0.41, height: side * 0.41)
            Canvas { context, size in
                var spokes = Path()
                for index in 0..<6 {
                    let angle = Double(index) * .pi / 3
                    let center = size.width / 2
                    spokes.move(to: .init(x: center + cos(angle) * side * 0.09, y: center + sin(angle) * side * 0.09))
                    spokes.addLine(to: .init(x: center + cos(angle) * side * 0.17, y: center + sin(angle) * side * 0.17))
                }
                context.stroke(spokes, with: .color(tint), style: .init(lineWidth: 0.55, lineCap: .round))
            }
        }
        .frame(width: side, height: side)
        .animation(updateAnimation, value: remaining)
    }

    private func quotaBar(_ window: QuotaWindow, height: CGFloat = 4) -> some View {
        tapeProgress(window.remaining, tint: finish.orange, height: height)
    }

    private func tapeProgress(_ remaining: Double, tint: Color, height: CGFloat, ticks: Bool = false) -> some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(finish.usedTape)
                Capsule().fill(tint).frame(width: geometry.size.width * remaining)
                    .animation(updateAnimation, value: remaining)
                if ticks {
                    ForEach([0.25, 0.5, 0.75], id: \.self) { value in
                        Rectangle().fill(finish.ink.opacity(value == 0.5 ? 0.36 : 0.22))
                            .frame(width: 0.55, height: height).offset(x: geometry.size.width * value)
                    }
                }
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }

}


private extension Color {
    init(rgb: UInt32) {
        self.init(red: Double((rgb >> 16) & 0xff) / 255,
                  green: Double((rgb >> 8) & 0xff) / 255,
                  blue: Double(rgb & 0xff) / 255)
    }
}

@MainActor
private func configuration(for card: Card) -> some WidgetConfiguration {
    StaticConfiguration(kind: "codeburn." + card.rawValue, provider: SnapshotProvider()) { entry in
        WidgetCard(card: card, entry: entry)
    }
    .contentMarginsDisabled()
    .configurationDisplayName(card.title)
    .description(card.description)
    .supportedFamilies(card == .quota ? [.systemSmall, .systemMedium, .systemLarge] : [.systemSmall, .systemMedium])
}

private struct TodayWidget: Widget {
    var body: some WidgetConfiguration { configuration(for: .today) }
}

private struct TrendWidget: Widget {
    var body: some WidgetConfiguration { configuration(for: .trend) }
}

private struct QuotaWidget: Widget {
    var body: some WidgetConfiguration { configuration(for: .quota) }
}

@main
struct CodeBurnWidgets: WidgetBundle {
    var body: some Widget {
        TodayWidget()
        TrendWidget()
        QuotaWidget()
    }
}
