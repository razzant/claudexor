import SwiftUI
import ClaudexorKit

// MARK: - Advanced review controls (UI cut 3, §3)
//
// Owner round-3: the Reviewers + Approvals text fields were opaque ("непонятны
// поля"). They now live under a collapsed "Advanced" DisclosureGroup with a
// humane UX: Reviewers is a STRUCTURED picker (harness dropdown + model text +
// effort segment) that generates the `harness=model:effort` wire token, with a
// raw power-syntax field kept inside Advanced for multi-reviewer strings;
// Approvals is a small LIST EDITOR (path-glob + reason rows) that generates the
// `glob:reason` entries. Both bind to the existing SSOT strings the send path
// already reads (`reviewerText` / `approvalsText`) — the mapping is the pure,
// unit-tested `ComposerOptionParser` grammar, so this view carries no wire logic.

/// A single editable approval row (stable identity for in-place list editing).
private struct ApprovalDraft: Identifiable, Equatable {
    let id = UUID()
    var path: String = ""
    var reason: String = ""
}

struct AdvancedReviewControls: View {
    /// SSOT the send path reads (raw `harness=model:effort` power syntax).
    @Binding var reviewerText: String
    /// SSOT the send path reads (raw `glob:reason` entries).
    @Binding var approvalsText: String
    /// Available harnesses the reviewer dropdown offers.
    let harnessChoices: [HarnessFamily]
    /// Union of the pool's declared effort ladders (for the effort segment).
    let effortLevels: [String]
    /// Whether the raw reviewer string currently fails to parse (owner of the
    /// verdict is the composer; this view only surfaces it).
    let reviewerRawInvalid: Bool

    @State private var expanded = false
    // Reviewer structured picker state.
    @State private var pickerHarness = ""
    @State private var pickerModel = ""
    @State private var pickerEffort = ""
    // Approvals list-editor state.
    @State private var approvals: [ApprovalDraft] = []
    @State private var hydrated = false

    private var validHarnessIds: Set<String> { Set(harnessChoices.map(\.rawValue)) }

    /// The reviewer picker is incomplete when a model/effort is set but no
    /// harness is chosen — the token then contributes nothing, so we say why.
    private var reviewerPickerIncomplete: Bool {
        pickerHarness.isEmpty && (!pickerModel.trimmed.isEmpty || !pickerEffort.isEmpty)
    }

    private var approvalRowsInvalid: Bool {
        approvals.contains { $0.path.trimmed.isEmpty && !$0.reason.trimmed.isEmpty }
    }

    var body: some View {
        DisclosureGroup("Advanced", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                reviewersSection
                Divider()
                approvalsSection
            }
            .padding(.top, Theme.Spacing.sm)
        }
        .font(.callout.weight(.medium))
        .onAppear(perform: hydrateOnce)
    }

    // MARK: Reviewers

    @ViewBuilder private var reviewersSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Reviewers").font(.subheadline.weight(.semibold))
            HStack(spacing: Theme.Spacing.sm) {
                Picker("", selection: $pickerHarness) {
                    Text("Auto").tag("")
                    ForEach(harnessChoices) { family in
                        Text(family.label).tag(family.rawValue)
                    }
                }
                .labelsHidden()
                .fixedSize()
                .onChange(of: pickerHarness) { _, _ in writeReviewerToken() }
                TextField("model (optional, e.g. opus)", text: $pickerModel)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .frame(maxWidth: 150)
                    .onChange(of: pickerModel) { _, _ in writeReviewerToken() }
            }
            if !effortLevels.isEmpty {
                Picker("Effort", selection: $pickerEffort) {
                    Text("Default").tag("")
                    ForEach(effortLevels, id: \.self) { Text($0.capitalized).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .onChange(of: pickerEffort) { _, _ in writeReviewerToken() }
            }
            if reviewerPickerIncomplete {
                inlineError("Pick a harness — a model or effort alone is not a reviewer.")
            }
            // Power syntax: multi-reviewer strings, prefilled from the picker.
            HStack(spacing: Theme.Spacing.xs) {
                TextField("claude=opus:max, cursor", text: $reviewerText)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .help("Comma or newline entries: harness[=model[:effort]] or harness[:effort]")
                if reviewerRawInvalid {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange).font(.caption)
                        .help("Reviewer entries need harness[=model[:effort]] or harness[:effort]; supported effort values come from each harness manifest.")
                }
            }
            Text("Empty = automatic cross-family review panel.")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    /// Build the single reviewer token from the picker and publish it into the
    /// raw SSOT (the common single-reviewer case). An unchosen harness leaves the
    /// raw string untouched so a hand-typed multi-reviewer string is not clobbered.
    private func writeReviewerToken() {
        guard let token = ComposerOptionParser.reviewerWireToken(
            harness: pickerHarness,
            model: pickerModel,
            effort: pickerEffort.isEmpty ? nil : pickerEffort
        ) else { return }
        reviewerText = token
    }

    // MARK: Approvals

    @ViewBuilder private var approvalsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text("Approvals").font(.subheadline.weight(.semibold))
                Spacer()
                Button {
                    approvals.append(ApprovalDraft())
                } label: { Label("Add", systemImage: "plus") }
                    .buttonStyle(.borderless).controlSize(.small)
                    .help("Approve changes under one more protected path glob.")
            }
            ForEach($approvals) { $row in
                HStack(spacing: Theme.Spacing.xs) {
                    TextField("path glob (e.g. test/**)", text: $row.path)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .onChange(of: row.path) { _, _ in writeApprovals() }
                    TextField("reason (optional)", text: $row.reason)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                        .onChange(of: row.reason) { _, _ in writeApprovals() }
                    Button(role: .destructive) {
                        approvals.removeAll { $0.id == row.id }
                        writeApprovals()
                    } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless).controlSize(.small)
                }
            }
            if approvalRowsInvalid {
                inlineError("Each approval needs a non-empty path glob.")
            }
            Text("Approvals let this run change auto-protected gate/test paths; they never bypass the built-in critical/security path human gates.")
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Serialize the list editor back into the raw SSOT (skipping incomplete rows).
    private func writeApprovals() {
        approvalsText = ComposerOptionParser.joinApprovalTokens(
            approvals.map { ProtectedPathApproval(path: $0.path, reason: $0.reason.isEmpty ? nil : $0.reason) })
    }

    // MARK: Hydration

    /// Seed the structured editors from any existing raw strings (a thread draft
    /// or a prior turn), ONCE, so re-opening the popover doesn't wipe them.
    private func hydrateOnce() {
        guard !hydrated else { return }
        hydrated = true
        if let first = ComposerOptionParser.splitOptionTokens(reviewerText).first,
           let entry = ComposerOptionParser.parseReviewerPanelEntry(first, effortLevels: Set(effortLevels)) {
            pickerHarness = validHarnessIds.contains(entry.harness) ? entry.harness : ""
            pickerModel = entry.model ?? ""
            pickerEffort = entry.effort ?? ""
        }
        approvals = ComposerOptionParser.splitOptionTokens(approvalsText)
            .compactMap(ComposerOptionParser.parseProtectedPathApproval)
            .map { ApprovalDraft(path: $0.path, reason: $0.reason ?? "") }
    }

    private func inlineError(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.caption2).foregroundStyle(Theme.status(.negative))
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
