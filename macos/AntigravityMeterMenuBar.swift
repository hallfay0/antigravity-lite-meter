import Cocoa
import WebKit
import Foundation

// ============================================================================
// Antigravity Lite Meter — macOS 原生菜单栏状态条应用 (零改盘、零外联、零依赖)
// 仅使用系统内置 Cocoa / WebKit / Foundation，只读扫描 ~/.gemini/antigravity 日志。
// ============================================================================

struct ModelPricing {
    let key: String
    let label: String
    let input: Double
    let output: Double
    let cacheRead: Double
}

struct UsageRecord {
    let dedupeKey: String
    let cascadeId: String
    let stepIndex: Int
    let source: String
    let tsMs: Double
    let dateKey: String
    let modelKey: String
    let modelLabel: String
    let inputTokens: Int
    let cacheReadTokens: Int
    let outputTokens: Int
    let thinkingTokens: Int
    let totalTokens: Int
    let contextTokens: Int
    let costUsd: Double
}

struct CachedFileEntry {
    let size: UInt64
    let mtime: TimeInterval
    let records: [UsageRecord]
}

private final class ModelAcc {
    let modelKey: String
    let modelLabel: String
    var input = 0, cache = 0, output = 0, total = 0, calls = 0
    var cost = 0.0
    init(_ k: String, _ l: String) { modelKey = k; modelLabel = l }
}

private final class BucketAcc {
    var input = 0, cache = 0, output = 0, thinking = 0, total = 0, calls = 0
    var cost = 0.0
    var sessions = Set<String>()
    var models: [String: ModelAcc] = [:]

    func add(_ r: UsageRecord) {
        input += r.inputTokens
        cache += r.cacheReadTokens
        output += r.outputTokens
        thinking += r.thinkingTokens
        total += r.totalTokens
        calls += 1
        cost += r.costUsd
        if !r.cascadeId.isEmpty { sessions.insert(r.cascadeId) }
        let m = models[r.modelKey] ?? {
            let created = ModelAcc(r.modelKey, r.modelLabel)
            models[r.modelKey] = created
            return created
        }()
        m.input += r.inputTokens
        m.cache += r.cacheReadTokens
        m.output += r.outputTokens
        m.total += r.totalTokens
        m.calls += 1
        m.cost += r.costUsd
    }

    func toDict() -> [String: Any] {
        let promptTot = input + cache
        let hitRate = promptTot > 0 ? ((Double(cache) / Double(promptTot)) * 1000.0).rounded() / 10.0 : 0.0
        let modelList: [[String: Any]] = models.values
            .sorted { $0.total > $1.total }
            .map { m in
                [
                    "modelKey": m.modelKey,
                    "modelLabel": m.modelLabel,
                    "inputTokens": m.input,
                    "cacheReadTokens": m.cache,
                    "outputTokens": m.output,
                    "totalTokens": m.total,
                    "calls": m.calls,
                    "estimatedCostUsd": (m.cost * 10000.0).rounded() / 10000.0
                ]
            }
        return [
            "inputTokens": input,
            "cacheReadTokens": cache,
            "outputTokens": output,
            "thinkingTokens": thinking,
            "totalTokens": total,
            "calls": calls,
            "sessions": sessions.count,
            "cacheHitRate": hitRate,
            "estimatedCostUsd": (cost * 10000.0).rounded() / 10000.0,
            "models": modelList
        ]
    }
}

final class LocalTranscriptScanner {
    private let skipDirs: Set<String> = ["node_modules", ".git", "scratch", "steps", "artifacts"]
    private var fileCache: [String: CachedFileEntry] = [:]

    private let isoWithFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private let isoBasic: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private let dateKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private let pricingTable: [String: ModelPricing] = [
        "gemini-4-hydrogen": ModelPricing(key: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", input: 1.50, output: 7.50, cacheRead: 0.075),
        "gemini-4-argon": ModelPricing(key: "gemini-4-argon", label: "Gemini 4 Argon", input: 2.00, output: 10.00, cacheRead: 0.10),
        "gemini-4-carbon": ModelPricing(key: "gemini-4-carbon", label: "Gemini 4 Carbon", input: 2.00, output: 10.00, cacheRead: 0.10),
        "gemini-3.8-flash": ModelPricing(key: "gemini-3.8-flash", label: "Gemini 3.8 Flash", input: 0.75, output: 3.75, cacheRead: 0.075),
        "gemini-3.5-flash-lite": ModelPricing(key: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", input: 0.30, output: 2.50, cacheRead: 0.03),
        "gemini-3.1-pro": ModelPricing(key: "gemini-3.1-pro", label: "Gemini 3.1 Pro", input: 2.00, output: 12.00, cacheRead: 0.20),
        "gemini-2.5-pro": ModelPricing(key: "gemini-2.5-pro", label: "Gemini 2.5 Pro", input: 1.25, output: 10.00, cacheRead: 0.125),
        "gemini-2.5-flash": ModelPricing(key: "gemini-2.5-flash", label: "Gemini 2.5 Flash", input: 0.30, output: 2.50, cacheRead: 0.03),
        "claude-opus-5-5": ModelPricing(key: "claude-opus-5-5", label: "Claude Opus 5.5", input: 4.00, output: 20.00, cacheRead: 0.20),
        "claude-sonnet-5-5": ModelPricing(key: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", input: 2.00, output: 10.00, cacheRead: 0.10),
        "claude-sonnet-4": ModelPricing(key: "claude-sonnet-4", label: "Claude Sonnet 4", input: 3.00, output: 15.00, cacheRead: 0.30),
        "claude-opus-4": ModelPricing(key: "claude-opus-4", label: "Claude Opus 4", input: 15.00, output: 75.00, cacheRead: 1.50)
    ]

    private func resolveModel(_ raw: String) -> ModelPricing {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let key: String
        if s.isEmpty { key = "unknown" }
        else if s.contains("hydrogen") { key = "gemini-4-hydrogen" }
        else if s.contains("argon") { key = "gemini-4-argon" }
        else if s.contains("carbon") { key = "gemini-4-carbon" }
        else if s.contains("3.8") && s.contains("flash") { key = "gemini-3.8-flash" }
        else if s.contains("3.5") && s.contains("flash") { key = "gemini-3.5-flash-lite" }
        else if s.contains("3.1") && s.contains("pro") { key = "gemini-3.1-pro" }
        else if s.contains("2.5") && s.contains("pro") { key = "gemini-2.5-pro" }
        else if s.contains("2.5") && s.contains("flash") { key = "gemini-2.5-flash" }
        else if s.contains("opus") && (s.contains("5.5") || s.contains("5-5")) { key = "claude-opus-5-5" }
        else if s.contains("sonnet") && (s.contains("5.5") || s.contains("5-5")) { key = "claude-sonnet-5-5" }
        else if s.contains("opus") { key = "claude-opus-4" }
        else if s.contains("sonnet") || s.contains("claude") { key = "claude-sonnet-4" }
        else if s.contains("flash") { key = "gemini-3.8-flash" }
        else if s.contains("gemini") { key = "gemini-4-hydrogen" }
        else { key = s }

        if let known = pricingTable[key] { return known }
        let label = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return ModelPricing(key: key, label: label.isEmpty ? "未知模型" : label, input: 1.50, output: 7.50, cacheRead: 0.10)
    }

    private func parseTimestampMs(_ val: Any?) -> Double? {
        if let str = val as? String {
            if let d = isoWithFrac.date(from: str) ?? isoBasic.date(from: str) {
                return d.timeIntervalSince1970 * 1000.0
            }
        } else if let num = val as? NSNumber {
            let v = num.doubleValue
            if v > 1e12 { return v }
            if v > 1e9 { return v * 1000.0 }
        }
        return nil
    }

    private func intVal(_ any: Any?) -> Int {
        if let n = any as? NSNumber { return n.intValue }
        if let s = any as? String, let v = Int(s) { return v }
        return 0
    }

    private func collectFiles() -> [(path: String, source: String, hint: String)] {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        let roots: [(dir: String, source: String)] = [
            (home + "/.gemini/antigravity/brain", "desktop"),
            (home + "/.gemini/antigravity-cli/brain", "cli")
        ]
        var results: [(String, String, String)] = []
        var visited = Set<String>()

        func walk(_ dir: String, _ source: String, _ depth: Int) {
            if depth > 4 { return }
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else { return }
            let real = (dir as NSString).resolvingSymlinksInPath
            if visited.contains(real) { return }
            visited.insert(real)

            guard let items = try? fm.contentsOfDirectory(atPath: dir) else { return }
            for name in items {
                if skipDirs.contains(name) { continue }
                let full = dir + "/" + name
                var subIsDir: ObjCBool = false
                guard fm.fileExists(atPath: full, isDirectory: &subIsDir) else { continue }
                if subIsDir.boolValue {
                    if depth == 0 {
                        let std = full + "/.system_generated/logs/transcript.jsonl"
                        let direct = full + "/transcript.jsonl"
                        var matched = false
                        if fm.fileExists(atPath: std) {
                            results.append((std, source, name))
                            matched = true
                        }
                        if fm.fileExists(atPath: direct) {
                            results.append((direct, source, name))
                            matched = true
                        }
                        if matched { continue }
                    }
                    walk(full, source, depth + 1)
                } else if name == "transcript.jsonl" {
                    let hint = URL(fileURLWithPath: dir).lastPathComponent
                    results.append((full, source, hint))
                }
            }
        }

        for r in roots {
            walk(r.dir, r.source, 0)
        }
        return results
    }

    private func parseFile(_ filePath: String, source: String, hint: String) -> [UsageRecord] {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: filePath) else { return [] }
        let size = (attrs[.size] as? NSNumber)?.uint64Value ?? 0
        let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0

        if let cached = fileCache[filePath], cached.size == size, cached.mtime == mtime {
            return cached.records
        }

        guard let rawData = try? Data(contentsOf: URL(fileURLWithPath: filePath)),
              let content = String(data: rawData, encoding: .utf8) else {
            return []
        }

        var records: [UsageRecord] = []
        let lines = content.split(whereSeparator: \.isNewline)
        for (idx, lineSub) in lines.enumerated() {
            if lineSub.isEmpty { continue }
            guard let lineData = lineSub.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else {
                continue
            }
            guard let tsMs = parseTimestampMs(obj["created_at"] ?? obj["createdAt"] ?? obj["timestamp"]),
                  tsMs > 0 else {
                continue
            }

            let chatModel = obj["chatModel"] as? [String: Any]
            let usage = chatModel?["usage"] as? [String: Any]

            let inp: Int
            let out: Int
            let cap: Int
            let thk: Int
            if obj["input_tokens"] != nil || obj["output_tokens"] != nil || obj["cache_read_tokens"] != nil
                || obj["inputTokens"] != nil || obj["outputTokens"] != nil || obj["cacheReadTokens"] != nil {
                inp = intVal(obj["input_tokens"] ?? obj["inputTokens"])
                out = intVal(obj["output_tokens"] ?? obj["outputTokens"])
                cap = intVal(obj["cache_read_tokens"] ?? obj["cacheReadTokens"])
                thk = intVal(obj["thinking_output_tokens"] ?? obj["thinkingOutputTokens"])
            } else if let u = usage {
                inp = intVal(u["inputTokens"] ?? u["input_tokens"])
                out = intVal(u["outputTokens"] ?? u["output_tokens"])
                cap = intVal(u["cacheReadTokens"] ?? u["cache_read_tokens"])
                thk = intVal(u["thinkingOutputTokens"] ?? u["thinking_output_tokens"])
            } else {
                continue
            }

            let tot = inp + cap + out
            if tot <= 0 { continue }

            let rawModel = (chatModel?["modelDisplayName"] as? String)
                ?? (chatModel?["responseModel"] as? String)
                ?? (chatModel?["model"] as? String)
                ?? (obj["modelDisplayName"] as? String)
                ?? (obj["model"] as? String)
                ?? (obj["modelId"] as? String)
                ?? ""

            let cid = ((obj["cascadeId"] as? String) ?? (obj["cascade_id"] as? String) ?? hint)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let stepIdx = (obj["step_index"] != nil || obj["stepIndex"] != nil)
                ? intVal(obj["step_index"] ?? obj["stepIndex"])
                : idx
            let respId = ((obj["responseId"] as? String)
                ?? (obj["response_id"] as? String)
                ?? (chatModel?["responseId"] as? String)
                ?? (obj["id"] as? String)
                ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

            let dedupeKey = respId.isEmpty ? "step:\(cid):\(stepIdx):\(Int64(tsMs))" : "resp:\(respId)"
            let model = resolveModel(rawModel)
            let cost = (Double(max(0, inp)) / 1_000_000.0) * model.input
                + (Double(max(0, cap)) / 1_000_000.0) * model.cacheRead
                + (Double(max(0, out)) / 1_000_000.0) * model.output
            let dateKey = dateKeyFormatter.string(from: Date(timeIntervalSince1970: tsMs / 1000.0))

            records.append(UsageRecord(
                dedupeKey: dedupeKey,
                cascadeId: cid,
                stepIndex: stepIdx,
                source: source,
                tsMs: tsMs,
                dateKey: dateKey,
                modelKey: model.key,
                modelLabel: model.label,
                inputTokens: inp,
                cacheReadTokens: cap,
                outputTokens: out,
                thinkingTokens: thk,
                totalTokens: tot,
                contextTokens: inp + cap,
                costUsd: cost
            ))
        }

        if fileCache.count > 1200 { fileCache.removeAll() }
        fileCache[filePath] = CachedFileEntry(size: size, mtime: mtime, records: records)
        return records
    }

    func scan(displayWindow: Int, selectedSessionId: String) -> (payload: [String: Any], activeContext: Int, todayTokens: Int, hasActive: Bool) {
        let now = Date()
        let cal = Calendar.current
        let startToday = cal.startOfDay(for: now)
        let todayKey = dateKeyFormatter.string(from: startToday)
        let weekCutoffMs = (cal.date(byAdding: .day, value: -6, to: startToday) ?? startToday).timeIntervalSince1970 * 1000.0
        let monthCutoffMs = (cal.date(byAdding: .day, value: -29, to: startToday) ?? startToday).timeIntervalSince1970 * 1000.0

        let files = collectFiles()
        var desktopFiles = 0
        var cliFiles = 0
        var dedup: [String: UsageRecord] = [:]

        for f in files {
            if f.source == "cli" { cliFiles += 1 } else { desktopFiles += 1 }
            let recs = parseFile(f.path, source: f.source, hint: f.hint)
            for r in recs {
                if let prev = dedup[r.dedupeKey], prev.totalTokens > r.totalTokens { continue }
                dedup[r.dedupeKey] = r
            }
        }

        let bToday = BucketAcc()
        let bWeek = BucketAcc()
        let bMonth = BucketAcc()
        let bAll = BucketAcc()
        var daily: [String: (tokens: Int, calls: Int)] = [:]
        var bySession: [String: [UsageRecord]] = [:]

        for r in dedup.values {
            bAll.add(r)
            if r.tsMs >= monthCutoffMs { bMonth.add(r) }
            if r.tsMs >= weekCutoffMs { bWeek.add(r) }
            if r.dateKey == todayKey { bToday.add(r) }

            let cur = daily[r.dateKey] ?? (0, 0)
            daily[r.dateKey] = (cur.tokens + r.totalTokens, cur.calls + 1)

            if !r.cascadeId.isEmpty {
                bySession[r.cascadeId, default: []].append(r)
            }
        }

        // 构建最近 15 个活跃会话
        var sessionSummaries: [(lastTs: Double, cascadeId: String, context: Int, dict: [String: Any])] = []
        for (cid, listRaw) in bySession {
            let list = listRaw.sorted { ($0.tsMs != $1.tsMs) ? ($0.tsMs < $1.tsMs) : ($0.stepIndex < $1.stepIndex) }
            guard let latest = list.last else { continue }
            var totTok = 0
            var totCost = 0.0
            for item in list {
                totTok += item.totalTokens
                totCost += item.costUsd
            }
            let promptTot = latest.inputTokens + latest.cacheReadTokens
            let hitRate = promptTot > 0 ? ((Double(latest.cacheReadTokens) / Double(promptTot)) * 1000.0).rounded() / 10.0 : 0.0
            let recentTurns: [[String: Any]] = list.suffix(12).reversed().map { t in
                [
                    "ts": t.tsMs,
                    "stepIndex": t.stepIndex,
                    "modelLabel": t.modelLabel,
                    "inputTokens": t.inputTokens,
                    "cacheReadTokens": t.cacheReadTokens,
                    "outputTokens": t.outputTokens,
                    "contextTokens": t.contextTokens,
                    "costUsd": (t.costUsd * 10000.0).rounded() / 10000.0
                ]
            }
            let dict: [String: Any] = [
                "cascadeId": cid,
                "lastTs": latest.tsMs,
                "modelLabel": latest.modelLabel,
                "contextTokens": latest.contextTokens,
                "inputTokens": latest.inputTokens,
                "cacheReadTokens": latest.cacheReadTokens,
                "outputTokens": latest.outputTokens,
                "thinkingTokens": latest.thinkingTokens,
                "cacheHitRate": hitRate,
                "turnCount": list.count,
                "totalTokens": totTok,
                "estimatedCostUsd": (totCost * 10000.0).rounded() / 10000.0,
                "recentTurns": recentTurns
            ]
            sessionSummaries.append((latest.tsMs, cid, latest.contextTokens, dict))
        }
        sessionSummaries.sort { $0.lastTs > $1.lastTs }
        let topSessions = Array(sessionSummaries.prefix(15))

        // 构建 52 周热力图 (364 天)
        let totalDays = 52 * 7
        var rawDays: [(date: String, tokens: Int, calls: Int)] = []
        var activeDays = 0
        var maxDaily = 0
        for i in stride(from: totalDays - 1, through: 0, by: -1) {
            let d = cal.date(byAdding: .day, value: -i, to: startToday) ?? startToday
            let key = dateKeyFormatter.string(from: d)
            let st = daily[key] ?? (0, 0)
            if st.tokens > 0 { activeDays += 1 }
            if st.tokens > maxDaily { maxDaily = st.tokens }
            rawDays.append((key, st.tokens, st.calls))
        }
        let nonZero = rawDays.map(\.tokens).filter { $0 > 0 }.sorted()
        let q1 = nonZero.isEmpty ? 1 : nonZero[Int(Double(nonZero.count) * 0.25)]
        let q2 = nonZero.isEmpty ? 1 : nonZero[Int(Double(nonZero.count) * 0.50)]
        let q3 = nonZero.isEmpty ? 1 : nonZero[Int(Double(nonZero.count) * 0.75)]
        let heatDays: [[String: Any]] = rawDays.map { d in
            let level: Int
            if d.tokens <= 0 { level = 0 }
            else if d.tokens <= q1 { level = 1 }
            else if d.tokens <= q2 { level = 2 }
            else if d.tokens <= q3 { level = 3 }
            else { level = 4 }
            return ["date": d.date, "tokens": d.tokens, "calls": d.calls, "level": level]
        }
        var streak = 0
        for i in stride(from: rawDays.count - 1, through: 0, by: -1) {
            if rawDays[i].tokens > 0 { streak += 1 }
            else if i == rawDays.count - 1 { continue }
            else { break }
        }

        let activeItem = topSessions.first(where: { !selectedSessionId.isEmpty && $0.cascadeId == selectedSessionId }) ?? topSessions.first

        let payload: [String: Any] = [
            "ok": true,
            "displayWindow": displayWindow,
            "selectedSessionId": activeItem?.cascadeId ?? "",
            "sources": ["desktopFiles": desktopFiles, "cliFiles": cliFiles],
            "periods": [
                "today": bToday.toDict(),
                "week": bWeek.toDict(),
                "month": bMonth.toDict(),
                "all": bAll.toDict()
            ],
            "heatmap": [
                "totalDays": totalDays,
                "activeDays": activeDays,
                "currentStreak": streak,
                "maxDailyTokens": maxDaily,
                "days": heatDays
            ],
            "sessions": topSessions.map(\.dict)
        ]

        return (payload, activeItem?.context ?? 0, bToday.total, activeItem != nil)
    }
}

final class DashboardViewController: NSViewController, WKScriptMessageHandler, WKNavigationDelegate {
    private var webView: WKWebView!
    private var isLoaded = false
    private var pendingJson: String?
    var onAction: (([String: Any]) -> Void)?

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "meter")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 450, height: 570), configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        self.view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if let url = Bundle.main.url(forResource: "dashboard", withExtension: "html"),
           let html = try? String(contentsOf: url, encoding: .utf8) {
            webView.loadHTMLString(html, baseURL: nil)
        } else {
            webView.loadHTMLString("<html><body style='font-family:-apple-system;padding:20px;'>未找到 dashboard.html 资源</body></html>", baseURL: nil)
        }
    }

    func pushJson(_ jsonStr: String) {
        pendingJson = jsonStr
        guard isLoaded else { return }
        webView.evaluateJavaScript("window.__onMeterData && window.__onMeterData(\(jsonStr));", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoaded = true
        if let json = pendingJson {
            webView.evaluateJavaScript("window.__onMeterData && window.__onMeterData(\(json));", completionHandler: nil)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? [String: Any] {
            onAction?(body)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var dashboardVC: DashboardViewController!
    private let scanner = LocalTranscriptScanner()
    private let scanQueue = DispatchQueue(label: "local.antigravity.lite-meter.scan", qos: .utility)
    private var timer: Timer?

    private var displayWindow: Int {
        get {
            let v = UserDefaults.standard.integer(forKey: "displayWindow")
            return v > 0 ? v : 256000
        }
        set { UserDefaults.standard.set(newValue, forKey: "displayWindow") }
    }

    private var compactMode: Bool {
        get { UserDefaults.standard.bool(forKey: "compactMode") }
        set { UserDefaults.standard.set(newValue, forKey: "compactMode") }
    }

    private var selectedSessionId: String = ""
    private var lastContextTokens: Int = 0
    private var lastTodayTokens: Int = 0
    private var lastHasActive: Bool = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            btn.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
            btn.title = "⚡ -- · 今日 --"
            btn.target = self
            btn.action = #selector(handleStatusClick(_:))
            btn.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        dashboardVC = DashboardViewController()
        dashboardVC.onAction = { [weak self] msg in
            self?.handleJsAction(msg)
        }

        popover = NSPopover()
        popover.contentSize = NSSize(width: 450, height: 570)
        popover.behavior = .transient
        popover.contentViewController = dashboardVC

        refreshNow()
        timer = Timer.scheduledTimer(withTimeInterval: 4.0, repeats: true) { [weak self] _ in
            self?.refreshNow()
        }
    }

    private func fmtTokens(_ n: Int) -> String {
        let v = Double(n)
        if v >= 1_000_000_000 { return String(format: "%.2fB", v / 1_000_000_000) }
        if v >= 1_000_000 { return String(format: "%.2fM", v / 1_000_000) }
        if v >= 10_000 { return String(format: "%.1fK", v / 1_000) }
        if v >= 1_000 { return String(format: "%.2fK", v / 1_000) }
        return "\(n)"
    }

    private func updateMenuBarTitle() {
        guard let btn = statusItem.button else { return }
        let denom = max(1, displayWindow)
        let pct = min(100, Int((Double(lastContextTokens) / Double(denom) * 100.0).rounded()))
        let icon = pct >= 85 ? "⚠️" : "⚡"

        if !lastHasActive {
            btn.title = lastTodayTokens > 0 ? "⚡ 今日 \(fmtTokens(lastTodayTokens))" : "⚡ AG Meter"
        } else if compactMode {
            btn.title = "\(icon) \(pct)% · \(fmtTokens(lastTodayTokens))"
        } else {
            btn.title = "\(icon) \(fmtTokens(lastContextTokens))/\(fmtTokens(denom)) (\(pct)%) · 今日 \(fmtTokens(lastTodayTokens))"
        }
    }

    @objc private func refreshNow() {
        let win = displayWindow
        let sel = selectedSessionId
        scanQueue.async { [weak self] in
            guard let self = self else { return }
            let result = self.scanner.scan(displayWindow: win, selectedSessionId: sel)
            let jsonStr: String?
            if let data = try? JSONSerialization.data(withJSONObject: result.payload, options: []),
               let str = String(data: data, encoding: .utf8) {
                jsonStr = str
            } else {
                jsonStr = nil
            }
            DispatchQueue.main.async {
                self.lastContextTokens = result.activeContext
                self.lastTodayTokens = result.todayTokens
                self.lastHasActive = result.hasActive
                self.updateMenuBarTitle()
                if let js = jsonStr {
                    self.dashboardVC.pushJson(js)
                }
            }
        }
    }

    private func handleJsAction(_ msg: [String: Any]) {
        guard let action = msg["action"] as? String else { return }
        switch action {
        case "ready", "refresh":
            refreshNow()
        case "setWindow":
            if let num = msg["displayWindow"] as? NSNumber {
                let w = num.intValue
                if w >= 16384 {
                    displayWindow = w
                    updateMenuBarTitle()
                }
            }
        case "selectSession":
            selectedSessionId = (msg["cascadeId"] as? String) ?? ""
            refreshNow()
        case "toggleCompact":
            compactMode.toggle()
            updateMenuBarTitle()
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    @objc private func handleStatusClick(_ sender: NSStatusBarButton) {
        if let event = NSApp.currentEvent, event.type == .rightMouseUp {
            showContextMenu(sender)
            return
        }
        togglePopover(sender)
    }

    @objc private func togglePopover(_ sender: Any?) {
        guard let btn = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(sender)
        } else {
            refreshNow()
            popover.show(relativeTo: btn.bounds, of: btn, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func showContextMenu(_ btn: NSStatusBarButton) {
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "打开上下文与 Token 看板", action: #selector(togglePopover(_:)), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "立即刷新", action: #selector(refreshNow), keyEquivalent: "r"))
        let compactItem = NSMenuItem(title: "精简状态栏显示", action: #selector(toggleCompactMenu), keyEquivalent: "")
        compactItem.state = compactMode ? .on : .off
        menu.addItem(compactItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "退出 Antigravity Meter", action: #selector(quitApp), keyEquivalent: "q"))

        statusItem.menu = menu
        btn.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func toggleCompactMenu() {
        compactMode.toggle()
        updateMenuBarTitle()
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
