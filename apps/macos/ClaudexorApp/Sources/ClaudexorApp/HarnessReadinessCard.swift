import SwiftUI
import AppKit
import ClaudexorKit

/// ONE readiness presentation for the three surfaces that used to carry
/// verbatim copies of the harness row (Settings, Onboarding, AuthSheet —
/// W4.7/W4.9, sol #19). Pure derivation from HarnessInfo: identity, the
/// server's routability truth, the daemon-normalized typed check rows, the
/// configured-model verdict, and the raw evidence for "copy raw". Surfaces
/// render it through HarnessReadinessCard and pass their OWN actions as a
/// caller slot — three workflows never centralize into one conditional.
struct HarnessReadinessPresentation: Equatable {
    var family: HarnessFamily
    /// Server routability truth (R8): routes at least one intent right now.
    var available: Bool
    var health: HarnessHealth
    var summary: String
    var rows: [ReadinessCheck]
    /// The un-normalized evidence (reasons + raw probe ids) for "copy raw".
    var rawEvidence: String

    static func from(family: HarnessFamily, info: HarnessInfo?) -> HarnessReadinessPresentation {
        // M5c: the daemon can emit the same finding more than once (aggregated
        // across probes) — dedupe here, the ONE readiness render owner, so a
        // repeated check/reason never shows twice (owner-reported).
        // QA-005 applies ONLY where the api-key is a genuine FALLBACK — i.e. the
        // family's PRIMARY credential is a native/subscription session (codex/
        // claude/cursor). For api-key-PRIMARY families (opencode, raw-api) the
        // stored_key IS the primary credential, so a failure there is real and must
        // stay red — pass no fallback source so the rewrite never fires.
        let apiKeyIsFallback = family.defaultAuthReadinessRequest?.authRequest == .subscription
        let rows = neutralizeAbsentOptionalKey(
            dedupeChecks(info?.readiness ?? []),
            authSources: info?.authSources ?? [],
            apiKeyFallbackSource: apiKeyIsFallback ? family.apiKeyAuthReadinessRequest?.source : nil)
        let reasons = dedupeOrdered(info?.reasons ?? [])
        return HarnessReadinessPresentation(
            family: family,
            available: !(info?.routableIntents.isEmpty ?? true),
            health: info?.health ?? .unavailable,
            summary: info?.auth ?? "Harness Doctor has not loaded this harness.",
            rows: rows,
            rawEvidence: (
                reasons
                    + rows.map { row in
                        "\(row.id): \(row.status)\(row.detail.map { " — \($0)" } ?? "")"
                    }
            ).joined(separator: "\n")
        )
    }

    /// QA-005: an ABSENT OPTIONAL API-key fallback must read neutral, never a red
    /// failure. The native adapters emit a presence-only `stored_key` conformance
    /// check that flips to `fail` merely because no key is configured — but on a
    /// healthy native harness the API key is an unused fallback, not a failure.
    /// The authority is the TYPED auth-source verdict, not the row's status
    /// string (ARCHITECTURE §5). The fallback does NOT live at one hard-coded
    /// source: the native-first CLIs read the key from `api_key_env`, but Codex's
    /// fallback is `provider_auth_file` — `HarnessFamily.apiKeyAuthReadinessRequest`
    /// is the authority for which TYPED source each family's api-key fallback uses.
    /// When THAT source is `unavailable + not_run` the fallback is simply not
    /// configured, so the `stored_key` fail is rewritten to a neutral `skip`
    /// ("not configured"). This is what keeps the DEFAULT Codex subscription case
    /// (provider_auth_file absent + not_run) from rendering a red `stored_key`.
    /// A present-but-broken key never reaches this rewrite (its `stored_key` is
    /// `pass`; the real failure surfaces via the `isolated_api_smoke` row), so
    /// genuine failures still render red. A family without an api-key fallback
    /// (`apiKeyFallbackSource == nil`) is never neutralized.
    static func neutralizeAbsentOptionalKey(
        _ checks: [ReadinessCheck], authSources: [HarnessAuthSource],
        apiKeyFallbackSource: AuthSourceKind?
    ) -> [ReadinessCheck] {
        guard let apiKeyFallbackSource else { return checks }
        let keyAbsent = authSources.contains {
            AuthSourceKind(rawValue: $0.source) == apiKeyFallbackSource
                && $0.availability == AuthAvailability.unavailable.rawValue
                && $0.verification == AuthVerification.notRun.rawValue
        }
        guard keyAbsent else { return checks }
        return checks.map { row in
            guard row.id == "stored_key", row.status == "fail" else { return row }
            return ReadinessCheck(
                kind: row.kind, id: row.id, title: row.title,
                status: "skip", detail: "not configured (optional API-key fallback)")
        }
    }

    /// Order-preserving de-duplication of readiness checks by id (first wins).
    static func dedupeChecks(_ checks: [ReadinessCheck]) -> [ReadinessCheck] {
        var seen = Set<String>()
        return checks.filter { seen.insert($0.id).inserted }
    }

    /// Order-preserving de-duplication of identical reason strings.
    static func dedupeOrdered(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }
}

/// The shared card (W4.7-UI): identity + health + the typed check rows +
/// model verdict + "copy raw", with the CALLER's action row slotted in.
/// Fixed geometry: the health capsule and row glyph columns have fixed
/// widths so the card never drifts with text length (DESIGN_SYSTEM).
struct HarnessReadinessCard<Actions: View>: View {
    let presentation: HarnessReadinessPresentation
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                HarnessChip(family: presentation.family, selected: true,
                            available: presentation.available)
                Text(presentation.summary)
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer(minLength: Theme.Spacing.md)
                Label(presentation.health.rawValue.capitalized,
                      systemImage: presentation.health.glyph)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(presentation.health.color)
                    .padding(.horizontal, Theme.Spacing.sm)
                    .padding(.vertical, Theme.Spacing.xxs)
                    .frame(minWidth: 96) // fixed anchor — text length never moves the row
                    .background(presentation.health.color.opacity(0.14), in: Capsule())
            }
            if !presentation.rows.isEmpty {
                // Ported to the shared AlignedListRow component (UI cut 3 §1):
                // status glyph + check title + SINGLE-LINE detail (full text via
                // `.help`), so a long probe detail can never wrap into fragments.
                AlignedList(verticalSpacing: Theme.Spacing.xxs) {
                    ForEach(presentation.rows, id: \.id) { row in
                        AlignedListRow(identity: AlignedRowIdentity(
                            dotColor: Self.rowColor(row.status),
                            dotSystemImage: Self.rowGlyph(row.status),
                            dotHelp: row.status,
                            title: row.title,
                            titleFont: .caption,
                            details: (row.detail?.isEmpty == false)
                                ? [AlignedRowDetail(0, row.detail!)] : []
                        )) { EmptyView() }
                    }
                }
            }
            HStack(spacing: Theme.Spacing.sm) {
                actions()
                if !presentation.rawEvidence.isEmpty {
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(presentation.rawEvidence, forType: .string)
                    } label: {
                        Label("Copy raw", systemImage: "doc.on.doc")
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .help("Copy the raw doctor reasons and probe ids for a bug report.")
                }
            }
        }
    }

    static func rowGlyph(_ status: String) -> String {
        switch status {
        case "pass": return "checkmark.circle.fill"
        case "fail": return "xmark.circle.fill"
        default: return "minus.circle"
        }
    }

    static func rowColor(_ status: String) -> Color {
        switch status {
        case "pass": return Theme.status(.positive)
        case "fail": return Theme.status(.negative)
        default: return .secondary
        }
    }
}
