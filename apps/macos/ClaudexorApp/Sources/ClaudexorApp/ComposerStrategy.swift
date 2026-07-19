import Foundation

/// Agent execution strategy knob (D24): Agent mode offers these as KNOBS
/// (Single is the default), replacing the old distinct Best-of / Create /
/// Until-clean INTENTS. Plan mode has its own Council knob; Ask carries none.
enum AgentStrategy: String, CaseIterable, Identifiable, Hashable {
    case single, bestOf, untilClean, create
    var id: String { rawValue }
    var label: String {
        switch self {
        case .single: return "Single"
        case .bestOf: return "Best-of"
        case .untilClean: return "Until clean"
        case .create: return "Create"
        }
    }
    var glyph: String {
        switch self {
        case .single: return "bolt.fill"
        case .bestOf: return "flag.checkered.2.crossed"
        case .untilClean: return "arrow.triangle.2.circlepath"
        case .create: return "plus.square.on.square"
        }
    }
    var blurb: String {
        switch self {
        case .single: return "One primary-biased envelope; apply explicitly after review."
        case .bestOf: return "N candidates in isolated envelopes, cross-reviewed, best wins."
        case .untilClean: return "One envelope repaired until gates/review are clean."
        case .create: return "Scaffold a brand-new repo or component."
        }
    }
}

/// The composer's per-turn strategy selection resolved into the wire-shaped
/// facts a thread turn actually carries. PURE (no SwiftUI, no model) so the
/// mapping — Agent's Delegate/strategy and Plan's Council + member count — is
/// unit-tested without a running app (item 8: composer mode/strategy mapping).
///
/// `mode` is the effective `RunMode` `sendTurn` routes on (Best-of / Create
/// keep their historical enum cases so the pool/`n` logic there is unchanged);
/// the boolean/`n` facts ride alongside as the delegation belt (D32) and
/// Council (D31) request fields.
struct ComposerStrategyResolution: Equatable {
    var mode: RunMode
    /// Agent delegation belt (D32); only ever true on an agent-family mode.
    var delegate: Bool
    /// Plan council (D31); only ever true on `.plan`.
    var council: Bool
    /// Council membership width (2..4) when `council`; nil otherwise (Best-of
    /// width stays pool-derived in `sendTurn`, never carried here).
    var councilN: Int?
    /// Agent "until clean" repair strategy.
    var untilClean: Bool
}

/// Resolve (intent, knobs) → the request-relevant strategy facts. Meaningless
/// combinations are made unrepresentable: Delegate is dropped off non-agent
/// intents, Council off non-plan, member count clamped to the wire's 2..4.
func resolveComposerStrategy(
    intent: RunMode,
    agentStrategy: AgentStrategy,
    delegate: Bool,
    councilEnabled: Bool,
    councilMembers: Int
) -> ComposerStrategyResolution {
    switch intent {
    case .plan:
        guard councilEnabled else {
            return .init(mode: .plan, delegate: false, council: false, councilN: nil, untilClean: false)
        }
        return .init(mode: .plan, delegate: false, council: true,
                     councilN: min(max(councilMembers, 2), 4), untilClean: false)
    case .agent:
        switch agentStrategy {
        case .single:
            return .init(mode: .agent, delegate: delegate, council: false, councilN: nil, untilClean: false)
        case .untilClean:
            return .init(mode: .agent, delegate: delegate, council: false, councilN: nil, untilClean: true)
        case .bestOf:
            return .init(mode: .bestOfN, delegate: delegate, council: false, councilN: nil, untilClean: false)
        case .create:
            return .init(mode: .create, delegate: delegate, council: false, councilN: nil, untilClean: false)
        }
    default:
        // Ask (and any other read-only intent) carries no strategy.
        return .init(mode: intent, delegate: false, council: false, councilN: nil, untilClean: false)
    }
}
