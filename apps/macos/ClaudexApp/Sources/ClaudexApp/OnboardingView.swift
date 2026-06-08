import SwiftUI
import AppKit

struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @Binding var completed: Bool
    @State private var step = 0
    @State private var projectRootDraft = ""
    @State private var openAIKey = ""
    @State private var anthropicKey = ""
    @State private var status = ""
    @State private var copiedCommand: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Theme.separator)
            Group {
                switch step {
                case 0: nativeAuth
                case 1: projectRoot
                case 2: apiKeys
                default: defaults
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(Theme.Spacing.xl)
            Divider().overlay(Theme.separator)
            footer
        }
        .frame(width: 620, height: 520)
        .background(Theme.surfaceBase)
        .task {
            projectRootDraft = model.projectRoot
            await model.refreshHarnesses()
            await model.refreshSecrets()
        }
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.md) {
            Image(systemName: "sparkles").font(.title2).foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Set Up Claudex").font(.title3.weight(.semibold))
                Text("Native harness auth first, API-key fallback when needed.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(Theme.Spacing.lg)
    }

    private var nativeAuth: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            HStack {
                Label("Native login setup", systemImage: "person.crop.circle.badge.checkmark")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.accent)
                Spacer()
                Button { Task { await model.refreshHarnesses() } } label: {
                    Label("Recheck", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .help("Refresh harness install/auth status after running a native setup command.")
            }
            Text("Claudex does not broker SaaS OAuth. It reuses each CLI's native login/subscription session first, then API-key refs only as fallback.")
                .font(.callout).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                ForEach(HarnessFamily.allCases.filter { $0 != .fake && $0 != .raw }) { family in
                    nativeAuthRow(family)
                }
                if let copiedCommand {
                    Text("Copied: \(copiedCommand)")
                        .font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            .padding(Theme.Spacing.lg)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).stroke(Theme.separator, lineWidth: 1))
        }
    }

    private var projectRoot: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            Label("Current project", systemImage: "folder")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.accent)
            Text("Pick the repo Claudex should read and mutate. Ask can run without a project; Agent, Plan, Create, Audit, Benchmark, and Explore require a Current Project.")
                .font(.callout).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                HStack(spacing: Theme.Spacing.sm) {
                    TextField("Project root", text: $projectRootDraft)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.callout, design: .monospaced))
                    Button { chooseProjectRoot() } label: { Label("Choose", systemImage: "folder") }
                        .buttonStyle(.bordered)
                }
                KeyValueRow(key: "Config", value: ".claudex/config.yaml", mono: true)
                KeyValueRow(key: "Docs", value: "CLAUDEX_BIBLE.md, docs/ARCHITECTURE.md", mono: true)
            }
            .padding(Theme.Spacing.lg)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).stroke(Theme.separator, lineWidth: 1))
        }
    }

    private var apiKeys: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            Label("API-key fallback", systemImage: "key")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.accent)
            Text("Optional. Values are sent to the local secret store and are never written into run params, jobs, patches, or summaries.")
                .font(.callout).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SecureField("OpenAI API key", text: $openAIKey)
                    .textFieldStyle(.roundedBorder)
                    .help("Stored as secret ref: openai")
                SecureField("Anthropic API key", text: $anthropicKey)
                    .textFieldStyle(.roundedBorder)
                    .help("Stored as secret ref: anthropic")
                if !status.isEmpty { Text(status).font(.caption).foregroundStyle(.secondary) }
            }
            .padding(Theme.Spacing.lg)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).stroke(Theme.separator, lineWidth: 1))
        }
    }

    private var defaults: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            Label("Ready", systemImage: "checkmark.seal")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.status(.succeeded))
            Text("The composer opens in Ask. Switch to Agent for direct edits, Best-of-N for tournament runs, or Plan when you need a draft spec interview.")
                .font(.callout).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                KeyValueRow(key: "Settings", value: "Cmd+,")
                KeyValueRow(key: "Live operations", value: "Budget, Harness Doctor, Benchmarks")
                KeyValueRow(key: "Review", value: "Table-first queue")
                Button {
                    Task {
                        let harnesses = model.availableHarnesses(for: .ask, selected: [.codex, .claude, .cursor, .opencode])
                        await model.startRun(
                            prompt: "2+2?",
                            mode: .ask,
                            harnesses: harnesses,
                            primary: harnesses.first,
                            portfolio: "subscription-first",
                            model: nil,
                            n: 1,
                            capUsd: 0.25,
                            access: "readonly"
                        )
                        completed = true
                    }
                } label: {
                    Label("Smoke Test Ask", systemImage: "checkmark.seal")
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(model.availableHarnesses(for: .ask, selected: [.codex, .claude, .cursor, .opencode]).isEmpty)
                .help("Run a no-project read-only Ask smoke test with the first ready harness.")
            }
            .padding(Theme.Spacing.lg)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).stroke(Theme.separator, lineWidth: 1))
        }
    }

    private var footer: some View {
        HStack {
            Button("Skip") { completed = true }
                .buttonStyle(.bordered)
            Spacer()
            Button { step = max(0, step - 1) } label: { Label("Back", systemImage: "chevron.left") }
                .buttonStyle(.bordered)
                .disabled(step == 0)
            Button {
                Task { await advance() }
            } label: {
                Label(step == 3 ? "Finish" : "Continue", systemImage: step == 3 ? "checkmark" : "chevron.right")
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
        }
        .padding(Theme.Spacing.lg)
    }

    private func advance() async {
        if step == 1 {
            model.projectRoot = projectRootDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if step == 2 {
            var stored: [String] = []
            if !openAIKey.isEmpty, await model.storeSecret(name: "openai", value: openAIKey) { stored.append("OpenAI") }
            if !anthropicKey.isEmpty, await model.storeSecret(name: "anthropic", value: anthropicKey) { stored.append("Anthropic") }
            if !stored.isEmpty { status = "Stored: \(stored.joined(separator: ", "))" }
        }
        if step >= 3 { completed = true }
        else { step += 1 }
    }

    private func nativeAuthRow(_ family: HarnessFamily) -> some View {
        let info = model.harnessInfo(for: family)
        let available = info?.health == .ok
        return HStack(spacing: Theme.Spacing.sm) {
            HarnessChip(family: family, selected: true, available: available)
            Text(info?.auth ?? "Not checked yet.")
                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
            Spacer()
            Button { openInstallGuide(family) } label: {
                Label("Install guide", systemImage: "arrow.down.circle")
            }
            .buttonStyle(.bordered)
            .help("Open the official install/login guide for \(family.label). Claudex does not bundle third-party CLIs.")
            Button {
                copy(nativeLoginCommand(family), label: "\(family.label) login command")
            } label: {
                Label("Copy Login", systemImage: "person.crop.circle.badge.checkmark")
            }
            .buttonStyle(.bordered)
            .help("Copy the native login command. Run it in Terminal, then Recheck.")
        }
    }

    private func nativeLoginCommand(_ family: HarnessFamily) -> String {
        switch family {
        case .codex: return "codex login && claudex doctor --harness codex"
        case .claude: return "claude /login && claudex doctor --harness claude"
        case .cursor: return "cursor-agent login && claudex doctor --harness cursor"
        case .opencode: return "opencode auth login && claudex doctor --harness opencode"
        case .raw: return "claudex secrets set openai --from-env OPENAI_API_KEY"
        case .fake: return "claudex doctor --all"
        }
    }

    private func openInstallGuide(_ family: HarnessFamily) {
        guard let url = URL(string: installGuideURL(family)) else { return }
        NSWorkspace.shared.open(url)
    }

    private func installGuideURL(_ family: HarnessFamily) -> String {
        switch family {
        case .codex: return "https://developers.openai.com/codex"
        case .claude: return "https://docs.anthropic.com/en/docs/claude-code"
        case .cursor: return "https://docs.cursor.com/cli"
        case .opencode: return "https://opencode.ai/docs"
        case .raw: return "https://platform.openai.com/docs"
        case .fake: return "https://github.com/joi-lab/claudex"
        }
    }

    private func chooseProjectRoot() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use Project"
        if panel.runModal() == .OK, let url = panel.url {
            projectRootDraft = url.path
            model.projectRoot = url.path
        }
    }

    private func copy(_ text: String, label: String? = nil) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copiedCommand = label.map { "\($0): \(text)" } ?? text
    }
}
