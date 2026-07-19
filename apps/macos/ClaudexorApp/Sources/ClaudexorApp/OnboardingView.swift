import SwiftUI

struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    /// The user's explicit dismissal bit (W15/R18): setting it is the ONLY
    /// way this sheet closes — whether onboarding is NEEDED stays derived
    /// from the server routability projection in RootView.
    @Binding var dismissed: Bool

    private var routableHarnesses: Set<HarnessFamily> {
        Set(model.selectableHarnesses.filter { $0 != .fake && $0 != .raw })
    }
    @State private var step = 0

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
        .task {
            await model.refreshHarnesses()
            await model.refreshSecrets()
        }
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.md) {
            Image(systemName: "sparkles").font(.title2).foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Set Up Claudexor").font(.title3.weight(.semibold))
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
                Button { Task { await model.refreshHarnesses(fresh: true) } } label: {
                    Label("Recheck", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .help("Refresh harness install/auth status after running a native setup command.")
            }
            Text("Claudexor does not broker SaaS OAuth. It reuses each CLI's native login/subscription session first, then API-key refs only as fallback.")
                .font(.callout).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                ForEach(model.selectableHarnesses.filter { $0 != .raw }) { family in
                    nativeAuthRow(family)
                }
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
            Text("Optional. Open a harness auth sheet to store fallback refs through the local secret store; raw values are never written into run params, jobs, patches, or summaries.")
                .font(.callout).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                FlowLayout(spacing: Theme.Spacing.sm) {
                    ForEach(model.selectableHarnesses) { family in
                        Button { model.authSheetTarget = AuthSheetTarget(family: family) } label: {
                            Label(family.label, systemImage: family.glyph)
                        }
                        .buttonStyle(.bordered)
                        .help("Open \(family.label) Auth for native setup and API-key fallback.")
                    }
                }
                if !model.storedSecrets.isEmpty {
                    Text("Stored refs: \(model.storedSecrets.map { $0.name }.joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
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
                .foregroundStyle(Theme.status(.positive))
            Text("Everything happens in one chat. Pick your project in the composer's project chip (the only place projects are selected); the composer opens in Agent for direct edits (Ask is the fallback with no project); switch to Best-of to run the harness pool against each other, or Plan to draft an approach you can then implement in the same thread.")
                .font(.callout).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                KeyValueRow(key: "Settings", value: "Cmd+,")
                KeyValueRow(key: "Budget & Doctor", value: "Settings tabs")
                KeyValueRow(key: "Review & apply", value: "On each chat turn")
                Button {
                    Task {
                        let harnesses = model.availableHarnesses(for: .ask, selected: routableHarnesses)
                        await model.startRun(
                            prompt: "2+2?",
                            mode: .ask,
                            harnesses: harnesses,
                            primary: harnesses.first,
                            routingGoal: "auto",
                            model: nil,
                            n: 1,
                            capUsd: 0.25,
                            access: "readonly"
                        )
                        dismissed = true
                    }
                } label: {
                    Label("Smoke Test Ask", systemImage: "checkmark.seal")
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(model.availableHarnesses(for: .ask, selected: routableHarnesses).isEmpty)
                .help("Run a no-project read-only Ask smoke test with the first ready harness.")
            }
            .padding(Theme.Spacing.lg)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).stroke(Theme.separator, lineWidth: 1))
        }
    }

    private var footer: some View {
        HStack {
            Button("Skip") { dismissed = true }
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
        if step >= 2 { dismissed = true }
        else { step += 1 }
    }

    /// W4.9: onboarding renders the SAME readiness card as Settings/AuthSheet
    /// (the verbatim copy is gone); only the action slot is its own.
    private func nativeAuthRow(_ family: HarnessFamily) -> some View {
        let presentation = HarnessReadinessPresentation.from(
            family: family, info: model.harnessInfo(for: family))
        return HarnessReadinessCard(presentation: presentation) {
            Button { model.authSheetTarget = AuthSheetTarget(family: family) } label: {
                Label(presentation.available ? "Manage" : "Setup",
                      systemImage: presentation.available ? "slider.horizontal.3" : "person.crop.circle.badge.checkmark")
            }
            .buttonStyle(.bordered)
            .tint(Theme.accent)
            .help(presentation.available ? "Open \(family.label) auth details and fallback key management." : "Open native login and API-key fallback setup for \(family.label).")
            Button { Task { await model.refreshHarnesses(fresh: true) } } label: {
                Label("Recheck", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .help("Refresh \(family.label) install/auth/capability status.")
        }
    }

}
