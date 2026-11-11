import SwiftUI
import ClaudexorKit

// MARK: - Harness doctor

enum HarnessHealth: String { case ok, degraded, unavailable
    var color: Color {
        switch self {
        case .ok: return Theme.status(.positive)
        case .degraded: return Theme.status(.caution)
        case .unavailable: return Theme.status(.negative)
        }
    }
    var glyph: String {
        switch self {
        case .ok: return "checkmark.circle.fill"
        case .degraded: return "exclamationmark.triangle.fill"
        case .unavailable: return "minus.circle"
        }
    }
}

struct HarnessInfo: Identifiable, Hashable {
    var family: HarnessFamily
    var health: HarnessHealth
    var version: String
    var auth: String
    var authSources: [HarnessAuthSource] = []
    var intents: [String]
    /// Server-side doctor-gated routability truth (R8/W14): the intents this
    /// harness will ACTUALLY route right now. Empty = routes nothing. The app
    /// formats this field; it never re-derives availability from health+intents.
    var routableIntents: [String] = []
    var reasons: [String] = []
    var readiness: [ReadinessCheck] = []
    /// Full finite attachment declaration. Composer admission preserves kind,
    /// MIME, byte/count limits, and transport rather than collapsing to vision.
    var attachmentInputs: [HarnessAttachmentInput] = []
    /// Manifest `browser_tool` capability — drives the composer's
    /// agent-browser toggle (only offered where Playwright MCP can inject).
    var acceptsBrowser: Bool = false
    /// Manifest `read_files` capability, verbatim; nil when the manifest does
    /// not declare it. The engine refuses project-scoped Ask on a harness that
    /// declares `false` (#133), so the composer says so before sending.
    var readsFiles: Bool? = nil
    /// Engine-owned Delegate readiness for this exact harness/runtime route.
    /// nil means a legacy runtime and fails closed in the composer.
    var delegation: HarnessDelegationCapability? = nil
    var setupLogin: HarnessSetupLoginCapability = .legacyAbsent
    /// Adapter-declared effort ladder. Empty means the control must stay hidden.
    var effortLevels: [String] = []
    /// Per-model advertised effort ladders (manifest `model_effort_levels`),
    /// each in the vendor's own order. A model absent here falls back to the
    /// harness-wide `effortLevels` — same rule as the engine's
    /// `effortLevelsForModel`.
    var modelEffortLevels: [String: [String]] = [:]
    var id: String { family.rawValue }
    var nativeSessionReady: Bool {
        authSources.first { $0.source == "native_session" }?.isVerifiedNativeSession == true
    }
}

struct HarnessAvailability: Hashable {
    var family: HarnessFamily
    var available: Bool
    var reason: String
    var intent: String
    var info: HarnessInfo?
}
