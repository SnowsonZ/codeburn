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
    let usage: UsageSnapshot?
    let quota: QuotaSnapshot?

    static func load() -> Self? {
        guard let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        let file = directory.appending(path: "CodeBurn Widgets/snapshot.json")
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 32 * 1024,
              let data = try? Data(contentsOf: file),
              let snapshot = try? JSONDecoder().decode(Self.self, from: data),
              snapshot.version == 1 else { return nil }
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
        return .init(version: 1, usage: .init(day: dayKey(now), updatedAt: updated, agents: agents, days: week),
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
        case .today: copy("三款 Agent 的 Token 和缓存命中率。", "Tokens and cache hits for your three agents.")
        case .trend: copy("最近 7 天的 Token 消耗。", "Token usage over the last seven days.")
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

    var tape: Color { light ? Color(rgb: 0x0d9668) : self == .walnut ? Color(rgb: 0x34d399) : Color(rgb: 0x10b981) }
    var lowTape: Color { light ? Color(rgb: 0xd97706) : self == .walnut ? Color(rgb: 0xfbbf24) : Color(rgb: 0xf59e0b) }
    var eject: Color { light ? Color(rgb: 0xb51d44) : Color(rgb: 0xfb7185) }
    var well: Color { light ? Color(rgb: 0xcec7bc).opacity(0.7) : Color.black.opacity(0.5) }
    var cassetteWell: Color {
        light ? Color(rgb: 0xd1b6a4).opacity(0.46) : Color(rgb: 0x402c24).opacity(0.68)
    }
    var usedTape: Color {
        light ? Color(rgb: 0x998375).opacity(0.48) : Color(rgb: 0xa38476).opacity(0.29)
    }

    var sleeves: [(UInt32, UInt32)] {
        switch self {
        case .silver, .system: [(0xdcd4c8, 0x9e8f7e), (0xd2c9bc, 0x6f7c85), (0xd9cdc0, 0xb87f62),
                               (0xcfc4b4, 0x566b65), (0xd7ccbe, 0x8f7b6a), (0xcec6ba, 0x6c6862)]
        case .dark: [(0x342f2c, 0x6f8594), (0x2c2826, 0x9c785c), (0x38312c, 0xb86846),
                     (0x40362f, 0xc99749), (0x322d2a, 0x5f8a7a), (0x2b2725, 0x7d756e)]
        case .walnut: [(0x523a2c, 0xb8845c), (0x483327, 0x6c858c), (0x5b4030, 0xc97b55),
                       (0x644533, 0xd4a359), (0x50392c, 0x7a9483), (0x443025, 0x9e8470)]
        }
    }

    var crate: [Color] {
        switch self {
        case .silver, .system: [Color(rgb: 0xd3c8b9), Color(rgb: 0xa69682)]
        case .dark: [Color(rgb: 0x3f352e), Color(rgb: 0x1e1916)]
        case .walnut: [Color(rgb: 0x734d33), Color(rgb: 0x3b2416)]
        }
    }
}

private struct Entry: TimelineEntry {
    let date: Date
    let snapshot: Snapshot?
    var finish: VinylFinish = .system
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
        let now = Date()
        let snapshot = Snapshot.load()
        let windows = snapshot?.quota?.agents.flatMap(\.windows) ?? []
        let waitingForQuota = windows.contains { !$0.isActive(at: now) }
        let interval: TimeInterval = snapshot == nil || waitingForQuota ? 5 * 60 : 15 * 60
        let midnight = civilCalendar.nextDate(after: now, matching: .init(hour: 0, minute: 0), matchingPolicy: .nextTime)
        let reset = windows.compactMap { parseDate($0.resetsAt) }.filter { $0 > now }.min()
        let next = min(now.addingTimeInterval(interval), midnight ?? .distantFuture, reset ?? .distantFuture)
        completion(Timeline(entries: [.init(date: now, snapshot: snapshot, finish: .load())], policy: .after(next)))
    }
}

private struct QuotaGridMetrics {
    let rowHeight: CGFloat
    let spacing: CGFloat
    let headingHeight: CGFloat
    let modelLimit: Int

    init(height: CGFloat, large: Bool, accountRows: Int, modelRows: Int, hasAntigravity: Bool) {
        headingHeight = large ? 17 : 12
        let budget = max(0, height - headingHeight)
        let fixedRows = accountRows + (hasAntigravity ? 1 : 0)
        let capacity = max(0, Int(budget / (large ? 19 : 11)) - fixedRows)
        modelLimit = min(modelRows, large ? 8 : 3, capacity)
        let rowCount = CGFloat(max(1, fixedRows + modelLimit))
        let pitch = budget / rowCount
        rowHeight = min(large ? 43 : 16, floor(max(0, pitch - (large ? 5 : 1))))
        spacing = min(large ? 13 : 4, max(0, pitch - rowHeight))
    }

    var valueSize: CGFloat { rowHeight >= 28 ? 16 : rowHeight >= 18 ? 13 : 10.5 }
    var valueWidth: CGFloat { ceil(valueSize * 2.5 + 2) }
}

private struct WidgetCard: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let card: Card
    let entry: Entry

    private var wide: Bool { family != .systemSmall }
    private var large: Bool { family == .systemLarge }
    private var finish: VinylFinish { entry.finish == .system ? (colorScheme == .dark ? .dark : .silver) : entry.finish }
    private var secondaryColor: Color { finish.subtitle }
    private var ruleColor: Color { finish.ink.opacity(finish.light ? 0.16 : 0.18) }
    private var quotaIconSize: CGFloat { large ? 17 : 12 }
    private let quotaIconGap: CGFloat = 4
    private var quotaIdentityWidth: CGFloat { large ? 43 : 33 }
    private var inset: CGFloat { wide ? 14 : 11 }
    private var updateAnimation: Animation? { reduceMotion ? nil : .easeOut(duration: 0.32) }
    private var usage: UsageSnapshot? {
        guard let snapshot = entry.snapshot?.usage, snapshot.day == dayKey(entry.date) else { return nil }
        return snapshot
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
        HStack(spacing: 5) {
            Text(card.title)
                .font(.system(size: large ? 15 : 11.5, weight: .bold))
                .foregroundStyle(finish.orange)
                .lineLimit(1).layoutPriority(1)
                .accessibilityAddTraits(.isHeader)
            if card == .quota && wide {
                Text("DUAL CASSETTE DECK")
                    .font(.system(size: large ? 8 : 6.5, weight: .medium, design: .monospaced))
                    .tracking(0.6).foregroundStyle(secondaryColor).lineLimit(1)
                    .accessibilityHidden(true)
            }
            Spacer(minLength: 1)
            if card == .quota {
                HStack(spacing: 4) {
                    Circle().fill(finish.orange).frame(width: 4, height: 4).accessibilityHidden(true)
                    Text(copy("剩余", "Remaining"))
                }
                .font(.system(size: large ? 10 : 8.5, weight: .medium))
                .foregroundStyle(secondaryColor)
                .lineLimit(1).minimumScaleFactor(0.8)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(finish.cassetteWell, in: Capsule())
            } else if card == .trend {
                Text("LP CRATE").font(.system(size: 7, design: .monospaced))
                    .tracking(0.6).foregroundStyle(secondaryColor).accessibilityHidden(true)
            } else if let rate = usage?.cacheRate {
                HStack(spacing: 3) {
                    Circle().fill(rate >= 0.9 ? finish.tape : finish.lowTape).frame(width: 4, height: 4)
                    Text(percent(rate)).monospacedDigit().contentTransition(reduceMotion ? .identity : .numericText(value: rate * 100))
                    Text(rate >= 0.9 ? "LOCK" : "DRIFT")
                }
                .font(.system(size: 7, weight: .semibold, design: .monospaced))
                .padding(.horizontal, 5).padding(.vertical, 3)
                .background(finish.well, in: Capsule())
                .overlay(Capsule().strokeBorder(ruleColor, lineWidth: 0.6))
                .animation(updateAnimation, value: rate)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(copy("缓存命中率", "Cache hit rate") + " " + percent(rate))
            }
        }
    }

    @ViewBuilder
    private var panelContent: some View {
        switch card {
        case .today:
            if let usage = entry.snapshot?.usage, usage.day == dayKey(entry.date) { today(usage) }
            else { empty(copy("打开 CodeBurn 同步", "Open CodeBurn to sync")) }
        case .trend:
            if let usage = entry.snapshot?.usage, usage.day == dayKey(entry.date) { trend(usage) }
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
        let raw = card == .quota ? entry.snapshot?.quota?.updatedAt : entry.snapshot?.usage?.updatedAt
        let updated = parseDate(raw)
        return HStack(spacing: 4) {
            Text(copy("上次刷新", "Updated"))
            if let updated {
                if civilCalendar.isDate(updated, inSameDayAs: entry.date) {
                    Text(updated, style: .time)
                } else {
                    Text(updated, format: .dateTime.month(.defaultDigits).day().hour().minute())
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
            VStack(alignment: .leading, spacing: 2) {
                usageTotal(usage.total)
                Text("Token" + (usage.cacheRate.map { " · " + copy("缓存", "Cache") + " " + percent($0) } ?? ""))
                    .font(.system(size: 8, weight: .medium, design: .monospaced)).foregroundStyle(secondaryColor)
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
                        .accessibilityLabel(row.id.name + " " + compact(row.tokens) + " Token"
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
                .monospacedDigit().lineLimit(1).minimumScaleFactor(detail ? 0.72 : 0.62)
                .contentTransition(reduceMotion ? .identity : .numericText())
                .animation(updateAnimation, value: total)
            if !parts.unit.isEmpty {
                Text(parts.unit)
                    .font(.system(size: unitSize, weight: .semibold))
                    .foregroundStyle(secondaryColor)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func usageTotal(_ total: Int?) -> some View {
        tokenValue(total, numberSize: wide ? 30 : 26, unitSize: 9)
    }

    private func trend(_ usage: UsageSnapshot) -> some View {
        let maximum = max(1, usage.days.compactMap(\.tokens).max() ?? 0)
        let peakId = usage.days.first { ($0.tokens ?? 0) == maximum }?.id
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .lastTextBaseline, spacing: 4) {
                usageTotal(sum(usage.days.map(\.tokens)))
                Text("Token").font(.system(size: 9, weight: .medium)).foregroundStyle(secondaryColor)
            }
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
                    .background(LinearGradient(colors: finish.crate, startPoint: .top, endPoint: .bottom),
                                in: RoundedRectangle(cornerRadius: 3))
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
                    .fill(today ? finish.orange : Color(rgb: palette.0))
                    .overlay(alignment: .top) {
                        if coverHeight >= 13 {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(String(format: "%02d", index + 1)).font(.system(size: 5.5, weight: .bold, design: .monospaced))
                                if coverHeight >= 24 {
                                    Image(systemName: ["rectangle.fill", "circle.fill", "diamond.fill"][index % 3])
                                        .font(.system(size: 4.5)).foregroundStyle(today ? Color(rgb: 0xffd883) : Color(rgb: palette.1))
                                }
                            }
                            .foregroundStyle(today ? Color(rgb: 0xffeed2) : finish.ink.opacity(0.76)).padding(.top, 2)
                        }
                    }
                    .overlay { UnevenRoundedRectangle(topLeadingRadius: 2.5, topTrailingRadius: 2.5).strokeBorder(ruleColor, lineWidth: 0.55) }
                    .frame(height: coverHeight)
            } else {
                Rectangle().fill(ruleColor).frame(height: 1)
            }
        }
        .frame(maxWidth: .infinity)
        .animation(updateAnimation, value: ratio)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(day.day + ", " + compact(day.tokens) + " Token")
    }

    @ViewBuilder
    private func quotas(_ quota: QuotaSnapshot) -> some View {
        if wide {
            quotaTable(quota)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(quota.agents, id: \.id) { row in
                    if row.id != quota.agents.first?.id { Spacer(minLength: 2) }
                    let windows = row.windows.filter { $0.isActive(at: entry.date) }
                    let preferred = row.id == .antigravity ? windows.min { $0.remaining < $1.remaining } : windows.first
                    if let window = preferred ?? row.windows.first {
                        let active = window.isActive(at: entry.date)
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
                                if active {
                                    remainingValue(window)
                                } else {
                                    pendingQuotaValue(window.name)
                                }
                            }
                            .font(.system(size: 11.5, weight: .medium))
                            if active { quotaBar(window) }
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
                    periodLabel(.fiveHours).frame(width: column, alignment: .trailing)
                    periodLabel(.weekly).frame(width: column, alignment: .trailing)
                }
                .frame(height: metrics.headingHeight)
                ForEach(accounts, id: \.id) { account in
                    accountQuotaRows(account, metrics: metrics, column: column, gap: gap)
                }
                if let antigravity, models.isEmpty {
                    unavailableQuotaRow(antigravity, metrics: metrics)
                } else if let antigravity {
                    GridRow {
                        quotaIconCell(quotaSourceIcon(antigravity), height: metrics.rowHeight)
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
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
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
                quotaIconCell(quotaSourceIcon(account), height: metrics.rowHeight)
                quotaCell(fiveHours, metrics: metrics, period: .fiveHours).frame(width: column)
                quotaCell(weekly, metrics: metrics, period: .weekly).frame(width: column)
            }
        }
        ForEach(windows.filter { $0.accountPeriod == nil }, id: \.label) { window in
            GridRow {
                quotaIconCell(quotaSourceIcon(account), height: metrics.rowHeight)
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
            quotaIconCell(quotaSourceIcon(agent), height: metrics.rowHeight)
            unavailableQuotaValue
                .frame(maxWidth: .infinity, alignment: .trailing)
                .gridCellColumns(2)
        }
    }

    private func quotaSourceIcon(_ agent: QuotaAgent) -> some View {
        HStack(spacing: 4) {
            harnessIcon(agent.id)
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
            HStack(spacing: 4) {
                Rectangle().fill(ruleColor).frame(width: 1, height: height).accessibilityHidden(true)
                modelIcon(group, size: quotaIconSize - 2)
            }
            .padding(.leading, 6), height: height)
    }

    private func periodLabel(_ period: QuotaPeriod) -> some View {
        Text(period.title)
            .font(.system(size: large ? 11 : 9, weight: .medium)).foregroundStyle(secondaryColor)
            .lineLimit(1)
    }

    private func harnessIcon(_ agent: Agent) -> some View {
        quotaLogo("provider-" + agent.rawValue, fallback: "terminal", size: quotaIconSize)
            .accessibilityLabel(agent.name)
            .help(agent.name)
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

    private func remainingValue(_ window: QuotaWindow) -> some View {
        let rate = percent(window.remaining)
        return Text(rate)
            .monospacedDigit().lineLimit(1).fixedSize()
            .contentTransition(reduceMotion ? .identity : .numericText(value: window.remaining * 100))
            .animation(updateAnimation, value: window.remaining)
            .accessibilityLabel(copy("剩余", "Remaining") + " " + rate)
    }

    private func pendingQuotaValue(_ label: String) -> some View {
        Text(copy("待更新", "Pending"))
            .font(.system(size: large ? 12 : 10, weight: .medium))
            .foregroundStyle(secondaryColor)
            .lineLimit(1)
            .accessibilityLabel(label + " " + copy("已到重置时间，等待额度更新", "reset reached; waiting for updated quota"))
    }

    @ViewBuilder
    private func quotaCell(_ window: QuotaWindow?, metrics: QuotaGridMetrics, period: QuotaPeriod? = nil) -> some View {
        if let window, window.isActive(at: entry.date) {
            HStack(spacing: large ? 7 : 4) {
                cassette(window, height: min(large ? 20 : 13, metrics.rowHeight))
                remainingValue(window).frame(width: large ? metrics.valueWidth : 32, alignment: .trailing)
            }
            .font(.system(size: metrics.valueSize, weight: .semibold, design: .monospaced))
            .frame(height: metrics.rowHeight)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel((period?.title ?? window.name) + " " + copy("剩余", "Remaining") + " " + percent(window.remaining))
        } else if let window {
            pendingQuotaValue(period?.title ?? window.name)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .frame(height: metrics.rowHeight)
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
