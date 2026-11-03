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
// `glob:reason` entries. One parent-owned draft keeps complete and incomplete
// values alive across disclosure/popover lifecycle; the send path projects it
// through the pure, unit-tested `ComposerOptionParser` wire grammar.

/// A single parent-owned approval row (stable identity for in-place editing).
struct ComposerApprovalDraft: Identifiable, Equatable {
    let id: UUID
    var path: String = ""
    var reason: String = ""

    init(id: UUID = UUID(), path: String = "", reason: String = "") {
        self.id = id
        self.path = path
        self.reason = reason
    }
}

/// Complete Advanced draft. Invalid structured values stay represented here
/// even though they intentionally contribute nothing to the wire projection.
struct ComposerReviewDraft: Equatable {
    var reviewerText: String = ""
    var pickerHarness: String = ""
    var pickerModel: String = ""
    var pickerEffort: String = ""
    var approvals: [ComposerApprovalDraft] = []

    var reviewerPickerIncomplete: Bool {
        pickerHarness.isEmpty && (!pickerModel.trimmed.isEmpty || !pickerEffort.isEmpty)
    }

    var approvalRowsInvalid: Bool {
        approvals.contains { $0.path.trimmed.isEmpty }
    }

    var hasIncompleteRows: Bool { reviewerPickerIncomplete || approvalRowsInvalid }

    /// A valid JSON panel carrying what the compact grammar cannot spell: a
    /// strict account pin or a processing preference.
    var hasStructuredOnlyReviewerJSON: Bool {
        ComposerOptionParser.parseReviewerPanelJSON(reviewerText)?.contains {
            $0.credentialProfileId != nil || $0.processingPreference != nil
        } == true
    }

    var hasValidReviewerJSON: Bool {
        ComposerOptionParser.parseReviewerPanelJSON(reviewerText) != nil
    }

    var reviewerWireToken: String? {
        ComposerOptionParser.reviewerWireToken(
            harness: pickerHarness,
            model: pickerModel,
            effort: pickerEffort.isEmpty ? nil : pickerEffort
        )
    }

    var approvalWireText: String {
        ComposerOptionParser.joinApprovalTokens(
            approvals.map {
                ProtectedPathApproval(
                    path: $0.path,
                    reason: $0.reason.isEmpty ? nil : $0.reason
                )
            }
        )
    }
}

struct AdvancedReviewControls: View {
    /// Parent-owned SSOT for complete and incomplete structured draft state.
    @Binding var draft: ComposerReviewDraft
    /// Available harnesses the reviewer dropdown offers.
    let harnessChoices: [HarnessFamily]
    /// Union of the pool's declared effort ladders (for the effort segment).
    let effortLevels: [String]
    /// Whether the raw reviewer string currently fails to parse (owner of the
    /// verdict is the composer; this view only surfaces it).
    let reviewerRawInvalid: Bool

    @State private var expanded = false
    var body: some View {
        DisclosureRow("Advanced", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                reviewersSection
                Divider()
                approvalsSection
            }
            .padding(.top, Theme.Spacing.sm)
        }
        .font(.callout.weight(.medium))
    }

    // MARK: Reviewers

    @ViewBuilder private var reviewersSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Reviewers").font(.subheadline.weight(.semibold))
            HStack(spacing: Theme.Spacing.sm) {
                Picker("", selection: $draft.pickerHarness) {
                    Text("Auto").tag("")
                    ForEach(harnessChoices) { family in
                        Text(family.label).tag(family.rawValue)
                    }
                }
                .labelsHidden()
                .fixedSize()
                .onChange(of: draft.pickerHarness) { _, _ in writeReviewerToken() }
                TextField("model (optional, e.g. opus)", text: $draft.pickerModel)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .frame(maxWidth: 150)
                    .onChange(of: draft.pickerModel) { _, _ in writeReviewerToken() }
            }
            if !effortLevels.isEmpty {
                Picker("Effort", selection: $draft.pickerEffort) {
                    Text("Default").tag("")
                    ForEach(effortLevels, id: \.self) { Text($0.capitalized).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .onChange(of: draft.pickerEffort) { _, _ in writeReviewerToken() }
            }
            if draft.reviewerPickerIncomplete {
                inlineError("Pick a harness — a model or effort alone is not a reviewer.")
            }
            // Power syntax: multi-reviewer strings, prefilled from the picker.
            HStack(spacing: Theme.Spacing.xs) {
                TextField("claude=opus:max, cursor (or pinned JSON)", text: $draft.reviewerText)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.caption, design: .monospaced))
                    .help("Comma or newline entries: harness[=model[:effort]] or harness[:effort]. For a strict account pin or a processing preference, paste a JSON array with credentialProfileId or processingPreference (standard, fast or economy).")
                if reviewerRawInvalid {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange).font(.caption)
                        .help("Reviewer entries need harness[=model[:effort]] or harness[:effort]; supported effort values come from each harness manifest. Pinned entries and processing preferences use a JSON array with credentialProfileId or processingPreference (standard, fast or economy).")
                }
            }
            Text("An explicit panel enables review. Leave empty to use automatic reviewers when Review changes is on.")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    /// Build the single reviewer token from the picker and publish it into the
    /// raw SSOT (the common single-reviewer case). An unchosen harness leaves the
    /// raw string untouched so a hand-typed multi-reviewer string is not clobbered.
    private func writeReviewerToken() {
        // The compact picker grammar has no place for a profile id or a
        // processing preference. Preserve a pasted structured panel rather than
        // silently changing the account or service when a picker callback fires
        // while the raw JSON remains the source of truth.
        guard !draft.hasStructuredOnlyReviewerJSON else { return }
        guard let token = draft.reviewerWireToken else { return }
        draft.reviewerText = token
    }

    // MARK: Approvals

    @ViewBuilder private var approvalsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text("Approvals").font(.subheadline.weight(.semibold))
                Spacer()
                Button {
                    draft.approvals.append(ComposerApprovalDraft())
                } label: { Label("Add", systemImage: "plus") }
                    .buttonStyle(.borderless).controlSize(.small)
                    .help("Approve changes under one more protected path glob.")
            }
            ForEach($draft.approvals) { $row in
                HStack(spacing: Theme.Spacing.xs) {
                    TextField("path glob (e.g. test/**)", text: $row.path)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                    TextField("reason (optional)", text: $row.reason)
                        .textFieldStyle(.roundedBorder)
                        .font(.caption)
                    Button(role: .destructive) {
                        draft.approvals.removeAll { $0.id == row.id }
                    } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless).controlSize(.small)
                }
            }
            if draft.approvalRowsInvalid {
                inlineError("Each approval needs a non-empty path glob.")
            }
            Text("Approvals let this run change auto-protected gate/test paths; they never bypass the built-in critical/security path human gates.")
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func inlineError(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.caption2).foregroundStyle(Theme.status(.negative))
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
