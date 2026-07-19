import Foundation

// v3 control-plane wire DTOs (M5a foundation catch-up). These mirror the Zod
// SSOT in packages/schema and are exercised by the generated wire fixtures'
// round-trip test (Tests/.../Fixtures/wire, driven by manifest.json). No
// legacy decode paths and no compatibility shims: the fresh v3 data root means
// nothing pre-v3 is ever decoded. Optional in Swift ONLY where the Zod schema
// is `.nullable()`/`.optional()`.

// MARK: - Handshake / engine build identity (D20)

/// Build identity of the serving engine, disclosed at the handshake so a
/// stale-daemon skew is visible instead of guessed later.
public struct EngineBuildIdentity: Codable, Sendable, Equatable {
    /// Lockstep workspace version.
    public let version: String
    /// Git commit SHA of the build; "unknown" outside a stamped package/git checkout.
    public let sha: String
    /// Resolved entry path of the serving process.
    public let entry: String

    public init(version: String, sha: String, entry: String) {
        self.version = version
        self.sha = sha
        self.entry = entry
    }
}

/// Successful control-plane negotiation (POST /v2/handshake). The negotiated
/// `protocolMajor` is the ONLY compatibility signal; the `/v2` URL prefix is a
/// frozen path spelling, not the contract.
public struct ControlHandshakeResponse: Codable, Sendable, Equatable {
    public let protocolMajor: Int
    public let compatible: Bool
    public let operationsPath: String
    public let engine: EngineBuildIdentity

    public init(protocolMajor: Int, compatible: Bool, operationsPath: String, engine: EngineBuildIdentity) {
        self.protocolMajor = protocolMajor
        self.compatible = compatible
        self.operationsPath = operationsPath
        self.engine = engine
    }
}

// MARK: - Terminal outcome axes (D8/D18)

/// The v3 terminal truth: independent axes instead of one mixed enum.
/// `lifecycle` says how far the PROCESS got; `noChanges`/`checks`/`review` say
/// what the work amounted to; `reason` qualifies a non-clean terminal (null on
/// a clean success). RunStatus/DecisionOutcome are dead.
public struct RunOutcomeFacts: Codable, Sendable, Equatable {
    /// succeeded | failed | cancelled | interrupted
    public let lifecycle: String
    /// True when the run finished without changing any files (the ex `no_op`).
    public let noChanges: Bool
    /// ChecksState: not_configured | passed | failed | ...
    public let checks: String
    /// ReviewState: not_run | approved | blocked | ...
    public let review: String
    /// Typed reason qualifying a non-clean terminal; null on a clean success.
    public let reason: String?

    public init(lifecycle: String, noChanges: Bool, checks: String, review: String, reason: String?) {
        self.lifecycle = lifecycle
        self.noChanges = noChanges
        self.checks = checks
        self.review = review
        self.reason = reason
    }
}

// MARK: - Apply eligibility (delivery gate, single producer)

/// Derived "can this run's WorkProduct be applied RIGHT NOW, and if not what
/// unblocks it" verdict, projected identically on every surface.
public struct ApplyEligibility: Codable, Sendable, Equatable {
    /// True when the apply gate would accept this run's patch right now.
    public let eligible: Bool
    /// The gate's apply-eligibility classification (needs_review | not_verified
    /// | no_changes | ok | ...) when known.
    public let state: String?
    /// The gate's refusal text when not eligible (null when eligible).
    public let reason: String?
    /// Honest guidance for what actually unblocks apply (null when nothing to do).
    public let requiredAction: String?

    public init(eligible: Bool, state: String?, reason: String?, requiredAction: String?) {
        self.eligible = eligible
        self.state = state
        self.reason = reason
        self.requiredAction = requiredAction
    }
}

// MARK: - Plan lifecycle v3 (D17/D31)

/// Server-derived readiness of a plan run (one derivation owner).
public struct PlanReadiness: Codable, Sendable, Equatable {
    /// ready | needs_answers | unverified
    public let state: String
    public let questionCount: Int

    public init(state: String, questionCount: Int) {
        self.state = state
        self.questionCount = questionCount
    }
}

/// One selectable option of a plan question.
public struct PlanQuestionOption: Codable, Sendable, Equatable, Hashable, Identifiable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

/// One open question surfaced by a plan revision. `allow_text` is snake_case on
/// the wire (the engine parser's tagged-block vocabulary).
public struct PlanQuestion: Codable, Sendable, Equatable, Hashable, Identifiable {
    public let id: String
    /// single | multi | text
    public let kind: String
    public let prompt: String
    public let options: [PlanQuestionOption]
    public let allowText: Bool

    enum CodingKeys: String, CodingKey {
        case id, kind, prompt, options
        case allowText = "allow_text"
    }

    public init(id: String, kind: String, prompt: String, options: [PlanQuestionOption], allowText: Bool) {
        self.id = id
        self.kind = kind
        self.prompt = prompt
        self.options = options
        self.allowText = allowText
    }
}

/// Engine-parsed open questions of one plan run (final/questions.json).
/// `parse` discloses `none_found` — never silently equated with "ready".
public struct PlanQuestionsArtifact: Codable, Sendable, Equatable {
    /// found | none_found
    public let parse: String
    public let questions: [PlanQuestion]

    public init(parse: String, questions: [PlanQuestion]) {
        self.parse = parse
        self.questions = questions
    }
}
