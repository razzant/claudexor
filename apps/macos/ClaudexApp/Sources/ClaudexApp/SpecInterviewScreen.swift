import SwiftUI

struct SpecInterviewScreen: View {
    @Environment(AppModel.self) private var model
    @State private var index = 0
    @State private var singleChoice: [String: UUID] = [:]
    @State private var multiChoice: [String: Set<UUID>] = [:]
    @State private var textAnswers: [String: String] = [:]

    private var questions: [InterviewQuestion] { model.interviewQuestions }
    private var current: InterviewQuestion? { questions.indices.contains(index) ? questions[index] : nil }

    var body: some View {
        ScreenScaffold(title: "Spec Interview",
                       subtitle: "Turn a vague task into a frozen, versioned ТЗ",
                       maxWidth: Theme.Layout.readableMaxWidth) {
            if questions.isEmpty {
                notWiredCard
            } else {
                progress
                if let q = current {
                    QuestionCard(question: q,
                                 single: binding(forSingle: q.id),
                                 multi: binding(forMulti: q.id),
                                 text: binding(forText: q.id))
                    navButtons
                } else {
                    freezeCard
                }
            }
        }
    }

    private var progress: some View {
        let tiers = Set(questions.map(\.tier)).sorted()
        let answered = answeredCount
        return VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text("Tier \(current?.tier ?? tiers.last ?? 1) of \(tiers.count)").font(.caption.weight(.medium))
                Spacer()
                Text("\(answered)/\(questions.count) answered").font(.caption).foregroundStyle(.secondary)
                if hasClarifications {
                    Label("\(clarificationCount) need clarification", systemImage: "questionmark.circle.fill")
                        .font(.caption2.weight(.medium)).foregroundStyle(Theme.status(.blocked))
                }
            }
            MeterBar(fraction: questions.isEmpty ? 0 : Double(answered) / Double(questions.count), tint: Theme.accent, height: 8)
        }
    }

    private var navButtons: some View {
        HStack {
            Button { withAnimation { index = max(0, index - 1) } } label: { Label("Back", systemImage: "chevron.left") }
                .buttonStyle(.bordered).disabled(index == 0)
            Spacer()
            Text("\(min(index + 1, questions.count)) / \(questions.count)").font(.caption).foregroundStyle(.secondary)
            Spacer()
            Button { withAnimation { index += 1 } } label: {
                Label(index >= questions.count - 1 ? "Review & Freeze" : "Next", systemImage: "chevron.right")
            }
            .buttonStyle(.borderedProminent).tint(Theme.accent)
        }
    }

    private var freezeCard: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Label("Ready to freeze", systemImage: "lock.doc").font(.title3.weight(.semibold)).foregroundStyle(Theme.accent)
                Text("All tiers answered. Freezing produces a versioned, diffable SpecPack and projects it to a TaskContract (acceptance criteria + deterministic gates).")
                    .font(.callout).foregroundStyle(.secondary)
                if hasClarifications {
                    Label("\(clarificationCount) item(s) still marked NEEDS_CLARIFICATION — resolve before freeze.", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption).foregroundStyle(Theme.status(.blocked))
                }
                HStack {
                    Button { withAnimation { index = 0 } } label: { Label("Edit answers", systemImage: "pencil") }.buttonStyle(.bordered)
                    Spacer()
                    Button { model.composerPresented = true } label: { Label("Freeze → SpecPack v1", systemImage: "snowflake") }
                        .buttonStyle(.borderedProminent).tint(Theme.accent).disabled(hasClarifications)
                }
            }
        }
    }

    private var notWiredCard: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Label("Interview not wired to the engine yet", systemImage: "bubble.left.and.text.bubble.right")
                    .font(.title3.weight(.semibold)).foregroundStyle(Theme.accent)
                Text("The hierarchical spec interview (claudex spec) runs in the CLI today. The GUI flow is previewable with Sample data (Settings → Show sample data) and will drive a real, frozen SpecPack once wired over the control-api.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private var answeredCount: Int {
        questions.reduce(0) { acc, q in
            switch q.kind {
            case .single: return acc + (singleChoice[q.id] != nil ? 1 : 0)
            case .multi: return acc + ((multiChoice[q.id]?.isEmpty == false) ? 1 : 0)
            case .text: return acc + ((textAnswers[q.id]?.isEmpty == false) ? 1 : 0)
            }
        }
    }
    private var hasClarifications: Bool { clarificationCount > 0 }
    private var clarificationCount: Int { questions.filter(\.needsClarification).count }

    private func binding(forSingle id: String) -> Binding<UUID?> { Binding(get: { singleChoice[id] }, set: { singleChoice[id] = $0 }) }
    private func binding(forMulti id: String) -> Binding<Set<UUID>> { Binding(get: { multiChoice[id] ?? [] }, set: { multiChoice[id] = $0 }) }
    private func binding(forText id: String) -> Binding<String> { Binding(get: { textAnswers[id] ?? "" }, set: { textAnswers[id] = $0 }) }
}

// MARK: - Spec detail (selected from the sidebar; distinct identity from its runs)

struct SpecDetailScreen: View {
    @Environment(AppModel.self) private var model
    let specId: String

    private var spec: Spec? { model.projects.flatMap(\.specs).first { $0.id == specId } }
    private var runs: [TaskRun] { (spec?.runIds ?? []).compactMap { model.task($0) } }

    var body: some View {
        if let spec {
            ScreenScaffold(title: spec.title,
                           subtitle: model.project(forSpec: specId)?.name) {
                Panel {
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        HStack(spacing: Theme.Spacing.sm) {
                            Label(spec.frozen ? "Frozen" : "Draft",
                                  systemImage: spec.frozen ? "lock.doc.fill" : "doc.text")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(spec.frozen ? Theme.accent : .secondary)
                            if spec.frozen {
                                Text("v\(spec.version)").font(.caption.weight(.semibold))
                                    .padding(.horizontal, Theme.Spacing.sm).padding(.vertical, 2)
                                    .background(Theme.accent.opacity(0.15), in: Capsule())
                                    .foregroundStyle(Theme.accent)
                            }
                            Spacer()
                            Text("\(runs.count) run\(runs.count == 1 ? "" : "s")")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Text("A frozen SpecPack projects to a TaskContract (acceptance criteria + deterministic gates). Runs below were launched against this spec.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }

                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    SectionLabel("Runs", systemImage: "play.rectangle.on.rectangle")
                    if runs.isEmpty {
                        Text("No runs yet for this spec.")
                            .font(.callout).foregroundStyle(.secondary)
                    } else {
                        Panel(padding: 0) {
                            VStack(spacing: 0) {
                                ForEach(Array(runs.enumerated()), id: \.element.id) { idx, task in
                                    Button { model.route = .task(task.id) } label: {
                                        TaskRowView(task: task).padding(.horizontal, Theme.Spacing.md)
                                    }
                                    .buttonStyle(.plain)
                                    if idx < runs.count - 1 {
                                        Divider().overlay(Theme.hairline).padding(.leading, Theme.Metrics.rowDividerInset)
                                    }
                                }
                            }
                            .padding(.vertical, Theme.Spacing.xs)
                        }
                    }
                }
            }
        } else {
            EmptyStateView(title: "Spec not found",
                           message: "This spec is no longer available.",
                           systemImage: "doc.text.magnifyingglass")
                .glowBackdrop()
        }
    }
}

// MARK: - Question card (solid)

private struct QuestionCard: View {
    let question: InterviewQuestion
    @Binding var single: UUID?
    @Binding var multi: Set<UUID>
    @Binding var text: String

    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(spacing: Theme.Spacing.sm) {
                    Text("Tier \(question.tier)").font(.caption2.weight(.bold))
                        .padding(.horizontal, Theme.Spacing.sm).padding(.vertical, 2)
                        .background(Theme.accent.opacity(0.18), in: Capsule()).foregroundStyle(Theme.accent)
                    if question.needsClarification {
                        Label("NEEDS_CLARIFICATION", systemImage: "questionmark.circle.fill")
                            .font(.caption2.weight(.medium)).foregroundStyle(Theme.status(.blocked))
                            .padding(.horizontal, Theme.Spacing.sm).padding(.vertical, 2)
                            .background(Theme.status(.blocked).opacity(0.15), in: Capsule())
                    }
                    Spacer()
                }
                Text(question.prompt).font(.title3.weight(.semibold))
                if let r = question.rationale { Text(r).font(.caption).foregroundStyle(.secondary) }
                if let file = question.citationFile {
                    Label(file, systemImage: "link").font(.system(.caption2, design: .monospaced)).foregroundStyle(Theme.link)
                }
                Divider().overlay(Theme.separator)
                switch question.kind {
                case .single:
                    VStack(spacing: Theme.Spacing.sm) {
                        ForEach(question.options) { opt in optionRow(opt, selected: single == opt.id, multi: false) { single = opt.id } }
                    }
                case .multi:
                    VStack(spacing: Theme.Spacing.sm) {
                        ForEach(question.options) { opt in
                            optionRow(opt, selected: multi.contains(opt.id), multi: true) {
                                if multi.contains(opt.id) { multi.remove(opt.id) } else { multi.insert(opt.id) }
                            }
                        }
                    }
                case .text:
                    TextEditor(text: $text)
                        .font(.callout).scrollContentBackground(.hidden).padding(Theme.Spacing.sm)
                        .frame(height: 92).codeSurface(10)
                }
            }
        }
    }

    private func optionRow(_ opt: InterviewOption, selected: Bool, multi: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: Theme.Spacing.md) {
                Image(systemName: multi ? (selected ? "checkmark.square.fill" : "square") : (selected ? "largecircle.fill.circle" : "circle"))
                    .foregroundStyle(selected ? Theme.accent : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(opt.text).font(.callout).foregroundStyle(.primary)
                    if let d = opt.detail { Text(d).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 0)
            }
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Theme.accent.opacity(0.10) : Theme.surfaceRaisedHi, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(selected ? Theme.accent.opacity(0.5) : Theme.separator, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
