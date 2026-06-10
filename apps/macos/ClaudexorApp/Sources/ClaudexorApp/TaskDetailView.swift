import AppKit
import SwiftUI

struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    let taskId: String
    @State private var tab: Tab = .answer
    @State private var verbosity: Verbosity = .normal
    @State private var userSelectedTab = false

    enum Tab: String, CaseIterable, Identifiable {
        case answer, plan, activity, candidates, diff, review, diagnostics
        var id: String { rawValue }
        var label: String {
            switch self {
            case .answer: return "Outcome"
            case .plan: return "Plan"
            case .activity: return "Timeline"
            case .candidates: return "Candidates"
            case .diff: return "Diff"
            case .review: return "Review"
            case .diagnostics: return "Diagnostics"
            }
        }
        var glyph: String {
            switch self {
            case .answer: return "text.bubble"
            case .plan: return "checklist"
            case .activity: return "waveform"
            case .candidates: return "flag.checkered.2.crossed"
            case .diff: return "plusminus.circle"
            case .review: return "person.2.badge.gearshape"
            case .diagnostics: return "stethoscope"
            }
        }
    }

    private var task: TaskRun? { model.task(taskId) }

    private func defaultTab(for task: TaskRun) -> Tab {
        if task.status.isActive {
            return .activity
        }
        // A blocked run's deliverable IS the findings that need a human.
        if task.status == .blocked {
            return task.findings.isEmpty ? .diagnostics : .review
        }
        if task.status == .failed || task.status == .unknown || task.status == .notConverged || task.status == .exhausted {
            return task.answerText == nil ? .diagnostics : .answer
        }
        return .answer
    }

    private func autoSelectDefaultTab(for task: TaskRun) {
        guard !userSelectedTab else { return }
        tab = defaultTab(for: task)
    }

    var body: some View {
        if let task {
            VStack(alignment: .leading, spacing: 0) {
                header(task)
                tabBar(task)
                Divider().overlay(Theme.separator)
                ScrollView {
                    content(task)
                        .padding(Theme.Spacing.xxl)
                        .frame(maxWidth: Theme.Layout.contentMaxWidth, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollContentBackground(.hidden)
            }
            .glowBackdrop()
            .onAppear {
                tab = defaultTab(for: task)
                userSelectedTab = false
            }
            .onChange(of: task.status) { _, _ in autoSelectDefaultTab(for: task) }
            .onChange(of: task.engineError ?? "") { _, _ in autoSelectDefaultTab(for: task) }
            .onChange(of: task.answerText ?? "") { _, _ in autoSelectDefaultTab(for: task) }
            .task(id: task.id) { if task.isLive { await model.loadRunDetail(task.id) } }
        } else {
            EmptyStateView(title: "Run not found", message: "This run is no longer available.", systemImage: "questionmark.folder")
                .glowBackdrop()
        }
    }

    // MARK: Header

    private func header(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ScreenHeader(title: task.title,
                         subtitle: task.prompt.isEmpty ? nil : task.prompt,
                         subtitleLineLimit: 2,
                         accessory: AnyView(StatusPill(status: task.status)))

            FlowLayout(spacing: Theme.Spacing.md) {
                ProvenanceTag(isLive: task.isLive)
                Label(task.mode.label, systemImage: task.mode.glyph).font(.caption).foregroundStyle(.secondary)
                if let spec = task.specTitle {
                    Label(spec, systemImage: "doc.text.fill").font(.caption).foregroundStyle(Theme.accent)
                }
                RouteProofBadge(proof: task.routeProof)
                if let access = task.accessLabel {
                    Label(access, systemImage: "lock.shield")
                        .font(.caption).foregroundStyle(.secondary)
                        .help("Access profile the engine enforced (requested vs effective).")
                }
                if let outputReady = task.outputReadyState, outputReady != "ready" {
                    // Honest output state; the "ready" case is the norm and stays quiet.
                    Label(Self.outputReadyLabel(outputReady), systemImage: outputReady == "diagnostic" ? "exclamationmark.triangle" : "clock")
                        .font(.caption)
                        .foregroundStyle(outputReady == "diagnostic" ? Theme.status(.failed) : .secondary)
                        .help("Output ready state from Control API.")
                }
                if let web = task.webEvidenceStatus, web != "none" {
                    Label(Self.webEvidenceLabel(web), systemImage: Self.webEvidenceGlyph(web))
                        .font(.caption)
                        .foregroundStyle(Self.webEvidenceColor(web))
                        .help(task.webEvidenceDetail ?? "Web evidence status.")
                }
                ForEach(task.harnesses) { HarnessChip(family: $0) }
                BudgetMini(spend: task.spendUsd, cap: task.capUsd, spendKnown: task.spendKnown, capKnown: task.capKnown, spendEstimated: task.spendEstimated)
                if task.isLive && task.status.isActive {
                    Button(role: .destructive) { Task { await model.cancel(task.id) } } label: {
                        Label("Cancel", systemImage: "stop.circle")
                    }
                    .buttonStyle(.bordered)
                    .help("Request cancel/interrupt for the active harness process.")
                }
            }

            Panel(padding: Theme.Spacing.md) { PhasePipelineView(active: task.activePhase, status: task.status) }
        }
        .padding(.horizontal, Theme.Spacing.xxl)
        .padding(.top, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.md)
    }

    // MARK: Tab bar (solid segmented; horizontally scrollable so it never forces a min)

    private func tabBar(_ task: TaskRun) -> some View {
        // Canonical segmented control (shared with the rest of the app); kept inside a
        // horizontal ScrollView so a long tab set never forces a wide minimum window.
        ScrollView(.horizontal, showsIndicators: false) {
            SegmentedTabs(items: Tab.allCases.map { ($0, $0.label, $0.glyph) },
                          selection: Binding(get: { tab }, set: { newValue in
                              userSelectedTab = true
                              tab = newValue
                          }),
                          badge: { badge(for: $0, task: task) })
                .padding(.horizontal, Theme.Spacing.xxl)
                .padding(.vertical, Theme.Spacing.sm)
        }
    }

    private func badge(for t: Tab, task: TaskRun) -> Int? {
        switch t {
        case .answer: return task.answerText == nil ? nil : 1
        case .plan: return task.plan.isEmpty ? nil : task.plan.count
        case .candidates: return task.candidates.isEmpty ? nil : task.candidates.count
        case .diff: return task.diff.isEmpty ? nil : task.diff.count
        case .review: return task.findings.isEmpty ? nil : task.findings.count
        case .diagnostics: return task.engineError == nil && task.diagnosticText == nil ? nil : 1
        case .activity: return nil
        }
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ task: TaskRun) -> some View {
        switch tab {
        case .answer:
            answerContent(task)
        case .plan:
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Plan", systemImage: "checklist",
                             accessory: AnyView(Text("\(task.planDone)/\(task.plan.count) done").font(.caption).foregroundStyle(.secondary)))
                Panel { PlanListView(items: task.plan) }
            }
        case .activity:
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionLabel("Timeline", systemImage: "waveform", accessory: AnyView(verbosityMenu))
                Panel { ActivityFeedView(events: task.activity.reversed(), verbosity: verbosity) }
            }
        case .candidates:
            candidatesContent(task)
        case .diff:
            DiffView(files: task.diff)
        case .review:
            reviewContent(task)
        case .diagnostics:
            diagnosticsContent(task)
        }
    }

    private func answerContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel(task.mode == .ask ? "Answer" : "Outcome", systemImage: "text.bubble")
            Panel {
                if let answer = task.answerText, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    MarkdownOutputView(markdown: answer)
                } else {
                    Text(task.outputReadyState == "finalizing" ? "Run is terminal; output is still finalizing. Open Diagnostics for events and artifact paths." : "No answer artifact yet. Open Diagnostics for engine state, events, and artifact paths.")
                        .font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    // MARK: Badge label/glyph mappers (no raw wire strings in the UI)

    static func outputReadyLabel(_ state: String) -> String {
        switch state {
        case "pending": return "Output pending"
        case "finalizing": return "Output finalizing"
        case "diagnostic": return "Diagnostic output"
        case "ready": return "Output ready"
        default: return state
        }
    }

    static func webEvidenceLabel(_ status: String) -> String {
        switch status {
        case "satisfied": return "Web verified"
        case "failed": return "Web failed"
        case "attempted": return "Web attempted"
        case "unverified": return "Web unverified"
        default: return status
        }
    }

    static func webEvidenceGlyph(_ status: String) -> String {
        switch status {
        case "satisfied": return "network"
        case "failed": return "exclamationmark.icloud"
        case "unverified": return "questionmark.diamond" // a policy gap, not a benign attempt
        default: return "icloud"
        }
    }

    static func webEvidenceColor(_ status: String) -> Color {
        switch status {
        case "satisfied": return Theme.status(.succeeded)
        case "failed": return Theme.status(.failed)
        case "unverified": return Theme.status(.blocked)
        default: return .secondary
        }
    }

    private var verbosityMenu: some View {
        Menu {
            Picker("Verbosity", selection: $verbosity) {
                ForEach(Verbosity.allCases) { Text($0.label).tag($0) }
            }
        } label: {
            Label(verbosity.label, systemImage: "slider.horizontal.3").font(.caption)
        }
        .menuStyle(.borderlessButton).fixedSize()
        .help("Choose how much timeline detail to show.")
    }

    private func candidatesContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Candidates", systemImage: "flag.checkered.2.crossed")
            if task.candidates.isEmpty {
                Panel { Text("No candidates yet — this mode runs a single envelope or hasn't spawned candidates.").font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading) }
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: Theme.Spacing.md) {
                        ForEach(task.candidates) { CandidateCard(candidate: $0) }
                    }
                    .padding(.bottom, Theme.Spacing.xs)
                }
                if let winner = task.candidates.first(where: { $0.reviewState == .winner }) {
                    Panel(padding: Theme.Spacing.md) {
                        HStack(spacing: Theme.Spacing.sm) {
                            Image(systemName: "trophy.fill").foregroundStyle(Theme.accent)
                            Text("Arbitration: \(winner.family.label) (\(winner.id)) selected on evidence — gates \(winner.gatesPassed)/\(winner.gatesTotal), clean final review.")
                                .font(.caption).foregroundStyle(.secondary)
                            Spacer()
                        }
                    }
                }
            }
        }
    }

    private func reviewContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Cross-family review", systemImage: "person.2.badge.gearshape")
            if task.findings.isEmpty {
                Panel { Label("No findings — final review clean.", systemImage: "checkmark.seal.fill").foregroundStyle(Theme.status(.succeeded)) }
            } else {
                ForEach(task.findings) { FindingCard(finding: $0) }
            }
        }
    }

    private func diagnosticsContent(_ task: TaskRun) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionLabel("Diagnostics", systemImage: "stethoscope")
            HStack(spacing: Theme.Spacing.sm) {
                Button {
                    copyDiagnostics(task)
                } label: {
                    Label("Copy Diagnostics", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .help("Copy the visible diagnostics text and run metadata.")
                Button {
                    if let runDir = task.runDir { NSWorkspace.shared.open(URL(fileURLWithPath: runDir)) }
                } label: {
                    Label("Open Run Folder", systemImage: "folder")
                }
                .buttonStyle(.bordered)
                .disabled(task.runDir == nil)
                .help(task.runDir ?? "Run folder is not available yet.")
                Button {
                    NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".claudexor/daemon/claudexord.log"))
                } label: {
                    Label("Open Daemon Log", systemImage: "terminal")
                }
                .buttonStyle(.bordered)
                .help("Open ~/.claudexor/daemon/claudexord.log.")
                Button {
                    Task {
                        // Retry preserves the ORIGINAL run's policy contract
                        // (access + web); silently resetting to defaults would
                        // change privacy/safety semantics between attempts.
                        await model.startRun(
                            prompt: task.prompt,
                            mode: task.mode,
                            harnesses: task.harnesses,
                            primary: task.harnesses.first,
                            portfolio: model.defaultPortfolio,
                            model: nil,
                            n: task.n,
                            capUsd: task.capKnown ? task.capUsd : model.defaultMaxUsdPerRun,
                            access: task.requestedAccess ?? (task.mode.isReadOnly ? "readonly" : "workspace_write"),
                            web: task.externalContextPolicy ?? "auto",
                            repoRootOverride: task.repoRoot
                        )
                    }
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .help("Start a new run with the same prompt, mode, harness pool, budget, access, and web policy.")
            }
            if let error = task.engineError, !error.isEmpty {
                Panel(padding: Theme.Spacing.md) {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(Theme.status(.failed))
                        .textSelection(.enabled)
                }
            }
            Panel {
                Text(task.diagnosticText ?? "Diagnostics are not loaded yet. Refresh this run or reconnect the engine.")
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !task.artifactPaths.isEmpty {
                Panel {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        SectionLabel("Artifacts", systemImage: "folder")
                        ForEach(task.artifactPaths, id: \.self) { path in
                            Text(path)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
        }
    }

    private func copyDiagnostics(_ task: TaskRun) {
        var text = [
            "run: \(task.id)",
            "mode: \(task.mode.apiValue)",
            "status: \(task.status.label)",
            "project: \(task.project)",
        ].joined(separator: "\n")
        if let runDir = task.runDir { text += "\nrunDir: \(runDir)" }
        if let engineError = task.engineError { text += "\n\n# Engine Error\n\(engineError)" }
        if let diagnostics = task.diagnosticText { text += "\n\n# Diagnostics\n\(diagnostics)" }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// Block-aware markdown rendering: headings, paragraphs, list items, and fenced
/// code render as separate views. `AttributedString(markdown:)` alone collapses
/// every newline into one run-on line, which made multi-paragraph answers unreadable.
private struct MarkdownOutputView: View {
    let markdown: String

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ForEach(blocks) { block in
                switch block.kind {
                case .heading(let level):
                    inline(block.text, font: level == 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                case .paragraph:
                    inline(block.text, font: .callout)
                case .list:
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        ForEach(Array(block.text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                                Text("•").font(.callout).foregroundStyle(.secondary)
                                inline(String(item.dropFirst(2)), font: .callout)
                            }
                        }
                    }
                case .code:
                    ScrollView(.horizontal, showsIndicators: true) {
                        Text(block.text)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .padding(Theme.Spacing.md)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .codeSurface(Theme.Radius.control)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func inline(_ raw: String, font: Font) -> some View {
        Text((try? AttributedString(markdown: raw, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(raw))
            .font(font)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var blocks: [MarkdownBlock] {
        var out: [MarkdownBlock] = []
        var paragraph: [String] = []
        var list: [String] = []
        var code: [String] = []
        var inCode = false

        func flushParagraph() {
            let text = paragraph.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            if !text.isEmpty { out.append(MarkdownBlock(id: out.count, kind: .paragraph, text: text)) }
            paragraph.removeAll()
        }
        func flushList() {
            if !list.isEmpty { out.append(MarkdownBlock(id: out.count, kind: .list, text: list.joined(separator: "\n"))) }
            list.removeAll()
        }

        for line in markdown.components(separatedBy: .newlines) {
            if line.hasPrefix("```") {
                if inCode {
                    out.append(MarkdownBlock(id: out.count, kind: .code, text: code.joined(separator: "\n")))
                    code.removeAll()
                    inCode = false
                } else {
                    flushParagraph(); flushList()
                    inCode = true
                }
                continue
            }
            if inCode { code.append(line); continue }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { flushParagraph(); flushList(); continue }
            if let headingLevel = headingLevel(trimmed) {
                flushParagraph(); flushList()
                out.append(MarkdownBlock(id: out.count, kind: .heading(headingLevel.level), text: headingLevel.text))
            } else if isListItem(trimmed) {
                flushParagraph()
                list.append("• \(listItemText(trimmed))")
            } else {
                flushList()
                paragraph.append(trimmed)
            }
        }
        if !code.isEmpty { out.append(MarkdownBlock(id: out.count, kind: .code, text: code.joined(separator: "\n"))) }
        flushParagraph(); flushList()
        return out.isEmpty ? [MarkdownBlock(id: 0, kind: .paragraph, text: markdown)] : out
    }

    private func headingLevel(_ line: String) -> (level: Int, text: String)? {
        guard line.hasPrefix("#") else { return nil }
        let hashes = line.prefix(while: { $0 == "#" })
        let text = line.dropFirst(hashes.count).trimmingCharacters(in: .whitespaces)
        guard hashes.count <= 6, !text.isEmpty else { return nil }
        return (min(hashes.count, 3), text)
    }

    private func isListItem(_ line: String) -> Bool {
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") { return true }
        // ordered list: "1. text"
        let head = line.prefix(while: { $0.isNumber })
        return !head.isEmpty && line.dropFirst(head.count).hasPrefix(". ")
    }

    private func listItemText(_ line: String) -> String {
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
            return String(line.dropFirst(2))
        }
        let head = line.prefix(while: { $0.isNumber })
        return String(line.dropFirst(head.count + 2))
    }

    private struct MarkdownBlock: Identifiable {
        enum Kind { case heading(Int), paragraph, list, code }
        let id: Int
        let kind: Kind
        let text: String
    }
}
