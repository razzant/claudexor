import SwiftUI

struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @Binding var completed: Bool
    @State private var step = 0
    @State private var openAIKey = ""
    @State private var anthropicKey = ""
    @State private var status = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Theme.separator)
            Group {
                switch step {
                case 0: nativeAuth
                case 1: apiKeys
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
            Label("Use native logins", systemImage: "person.crop.circle.badge.checkmark")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.accent)
            Text("Codex, Claude Code, Cursor, and OpenCode keep their own subscription/login state. Claudex mirrors those sessions by default and only uses stored keys as fallback.")
                .font(.callout).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                KeyValueRow(key: "Default mode", value: "Ask")
                KeyValueRow(key: "Default portfolio", value: "subscription-first")
                KeyValueRow(key: "Env inheritance", value: "mirror-native")
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
                Label(step == 2 ? "Finish" : "Continue", systemImage: step == 2 ? "checkmark" : "chevron.right")
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
        }
        .padding(Theme.Spacing.lg)
    }

    private func advance() async {
        if step == 1 {
            var stored: [String] = []
            if !openAIKey.isEmpty, await model.storeSecret(name: "openai", value: openAIKey) { stored.append("OpenAI") }
            if !anthropicKey.isEmpty, await model.storeSecret(name: "anthropic", value: anthropicKey) { stored.append("Anthropic") }
            if !stored.isEmpty { status = "Stored: \(stored.joined(separator: ", "))" }
        }
        if step >= 2 { completed = true }
        else { step += 1 }
    }
}
