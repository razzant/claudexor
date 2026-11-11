import Foundation

public enum HarnessSetupLoginCapability: Sendable, Equatable, Hashable, Codable {
    case legacyAbsent
    case unavailable
    case inApp
    case externalTerminal

    private struct Wire: Codable {
        let mode: String

        private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
            case mode
        }

        init(mode: String) { self.mode = mode }

        init(from decoder: Decoder) throws {
            try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
            let container = try decoder.container(keyedBy: CodingKeys.self)
            mode = try container.decode(String.self, forKey: .mode)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .unavailable; return }
        switch try container.decode(Wire.self).mode {
        case "in_app": self = .inApp
        case "external_terminal": self = .externalTerminal
        default:
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "setupLogin.mode must be in_app or external_terminal")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .legacyAbsent, .unavailable: try container.encodeNil()
        case .inApp: try container.encode(Wire(mode: "in_app"))
        case .externalTerminal: try container.encode(Wire(mode: "external_terminal"))
        }
    }
}

// MARK: - Harness status / auth-source / model DTOs
//
// Extracted from `Models.swift` so the harness readiness + model-truth DTOs
// stay a small, single-owner unit (INV-124 readability ratchet).

public struct HarnessStatus: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let status: String
    public let manifest: JSONValue?
    public let enabledIntents: [String]
    /// Intents this harness is ACTUALLY routable for right now — the SERVER's
    /// doctor-gated availability truth (R8/W14). Surfaces read this field and
    /// never re-derive availability from status+intents. An empty array means
    /// "routes nothing" (degraded/unauth'd harness, or a legacy daemon that
    /// predates the field) — fail-closed, never "ready".
    public let routableIntents: [String]
    public let disabledIntents: [String]
    public let checks: [HarnessCheck]
    public let reasons: [String]?
    /// Doctor-backed readiness for each concrete authentication source. An
    /// empty array means a legacy daemon (or a probe that reported no source
    /// detail), never "ready".
    public let authSources: [HarnessAuthSource]
    /// The daemon-normalized display list (W4.7): what surfaces RENDER —
    /// typed rows (kind/title/status/detail), never parsed strings or
    /// id-substring matches. Empty means a legacy daemon; raw checks/reasons
    /// remain for "copy raw" evidence.
    public let readiness: [ReadinessCheck]
    /// The user's configured per-harness default model, if any.
    public let configuredModel: String?
    /// Truth-source verdict for `configuredModel` under the harness's own declaration
    /// ("ok" with a message = advisory admission; "rejected" + actionable message).
    public let configuredModelCheck: HarnessModelCheck?
    /// Engine-owned readiness for the selected runtime/harness Delegate belt.
    /// Absence means an older runtime and therefore fails closed in the UI.
    public let delegation: HarnessDelegationCapability?
    /// Presence-aware engine fact: absent is a legacy daemon, explicit null
    /// means no managed login, and the two objects select exact transport.
    public let setupLogin: HarnessSetupLoginCapability

    enum CodingKeys: String, CodingKey {
        case id, status, manifest, enabledIntents, routableIntents, disabledIntents, checks, reasons, authSources, readiness, configuredModel, configuredModelCheck, delegation, setupLogin
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decode(String.self, forKey: .status)
        manifest = try c.decodeIfPresent(JSONValue.self, forKey: .manifest)
        enabledIntents = try c.decodeIfPresent([String].self, forKey: .enabledIntents) ?? []
        routableIntents = try c.decodeIfPresent([String].self, forKey: .routableIntents) ?? []
        disabledIntents = try c.decodeIfPresent([String].self, forKey: .disabledIntents) ?? []
        checks = try c.decodeIfPresent([HarnessCheck].self, forKey: .checks) ?? []
        reasons = try c.decodeIfPresent([String].self, forKey: .reasons)
        authSources = try c.decodeIfPresent([HarnessAuthSource].self, forKey: .authSources) ?? []
        readiness = try c.decodeIfPresent([ReadinessCheck].self, forKey: .readiness) ?? []
        configuredModel = try c.decodeIfPresent(String.self, forKey: .configuredModel)
        configuredModelCheck = try c.decodeIfPresent(HarnessModelCheck.self, forKey: .configuredModelCheck)
        delegation = try c.decodeIfPresent(HarnessDelegationCapability.self, forKey: .delegation)
        if !c.contains(.setupLogin) {
            setupLogin = .legacyAbsent
        } else if try c.decodeNil(forKey: .setupLogin) {
            setupLogin = .unavailable
        } else {
            setupLogin = try c.decode(HarnessSetupLoginCapability.self, forKey: .setupLogin)
        }
    }
}

/// `HarnessStatusDto.delegation` / `CatalogHarness.delegation`. The reason is
/// a closed engine vocabulary (`ready`, `runtime_unavailable`, or
/// `manifest_unsupported`); the app displays the server-projected remediation
/// instead of reconstructing install/update advice.
public struct HarnessDelegationCapability: Codable, Sendable, Equatable, Hashable {
    public let available: Bool
    public let reason: String
    public let remediation: String?
    public let requiresFullAccess: Bool

    public init(available: Bool, reason: String, remediation: String? = nil, requiresFullAccess: Bool) {
        self.available = available
        self.reason = reason
        self.remediation = remediation
        self.requiresFullAccess = requiresFullAccess
    }
}

/// One daemon-normalized readiness row (schema `ReadinessCheckDto`).
public struct ReadinessCheck: Codable, Sendable, Equatable, Hashable {
    /// "binary" | "auth" | "smoke" | "model" | "probe" — typed classification
    /// from the daemon's table; the UI switches on it, never on id substrings.
    public let kind: String
    public let id: String
    public let title: String
    /// "pass" | "fail" | "skip".
    public let status: String
    public let detail: String?

    public init(kind: String, id: String, title: String, status: String, detail: String? = nil) {
        self.kind = kind
        self.id = id
        self.title = title
        self.status = status
        self.detail = detail
    }
}

public struct HarnessAuthSource: Codable, Sendable, Equatable, Hashable {
    public let source: String
    public let availability: String
    public let verification: String
    public let detail: String?

    public init(source: String, availability: String, verification: String, detail: String? = nil) {
        self.source = source
        self.availability = availability
        self.verification = verification
        self.detail = detail
    }

    /// Native session readiness is proven only by the typed doctor verdict.
    /// Credential presence alone is deliberately insufficient.
    public var isVerifiedNativeSession: Bool {
        source == "native_session" && availability == "available" && verification == "passed"
    }
}

public struct HarnessModelCheck: Codable, Sendable, Equatable {
    public let status: String
    public let message: String?
}

public struct HarnessCheck: Codable, Sendable, Equatable {
    public let id: String
    public let status: String
    public let detail: String?
}

/// Execution-location Git readiness returned beside the fresh harness snapshot.
public struct WorkspaceGitCapability: Codable, Sendable, Equatable, Hashable {
    public let status: String
    public let version: String?
    public let detail: String?
    public let remediation: String?

    public init(status: String, version: String?, detail: String?, remediation: String?) {
        self.status = status
        self.version = version
        self.detail = detail
        self.remediation = remediation
    }

    public var available: Bool { status == "available" }
}

public struct HarnessListResponse: Codable, Sendable {
    public let harnesses: [HarnessStatus]
    /// nil when connected to a daemon predating Git-capability projection.
    public let git: WorkspaceGitCapability?
}

/// One enumerable model a harness offers. Mirrors the control-api `HarnessModel`
/// (deliberately small: only fields a real `GET /v1/models` enumeration can
/// honestly populate). `label`/`contextWindow` are nullable on the wire.
public struct HarnessModel: Codable, Sendable, Identifiable, Equatable, Hashable {
    public let id: String
    public let label: String?
    public let contextWindow: Int?
    /// Credential routes this model is annotated for (W11: "local_session" /
    /// "api_key"). nil = unannotated, offered on every route.
    public let routes: [String]?
    /// Input modalities the live catalog declares, verbatim ("text", "image",
    /// "file", …). nil = unknown, never "no input"; declared metadata that
    /// gates no request (#146).
    public let inputModalities: [String]?
    /// Largest completion the live catalog declares; nil = unknown.
    public let maxOutputTokens: Int?

    enum CodingKeys: String, CodingKey {
        case id, label, routes
        case contextWindow = "context_window"
        case inputModalities = "input_modalities"
        case maxOutputTokens = "max_output_tokens"
    }

    public init(id: String, label: String? = nil, contextWindow: Int? = nil, routes: [String]? = nil,
                inputModalities: [String]? = nil, maxOutputTokens: Int? = nil) {
        self.id = id
        self.label = label
        self.contextWindow = contextWindow
        self.routes = routes
        self.inputModalities = inputModalities
        self.maxOutputTokens = maxOutputTokens
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        contextWindow = try c.decodeIfPresent(Int.self, forKey: .contextWindow)
        routes = try c.decodeIfPresent([String].self, forKey: .routes)
        // The engine never sends an empty list for "unknown"; an older or
        // malformed empty list is treated as unknown rather than "no input".
        let modalities = try c.decodeIfPresent([String].self, forKey: .inputModalities)
        inputModalities = modalities?.isEmpty == true ? nil : modalities
        maxOutputTokens = try c.decodeIfPresent(Int.self, forKey: .maxOutputTokens)
    }

    /// True only when the catalog declares input modalities and none is an
    /// image. Unknown modalities answer false: no claim is made (#146).
    public var catalogDeclaresNoImageInput: Bool {
        guard let inputModalities else { return false }
        return !inputModalities.contains("image")
    }
}

/// Menu-facing presentation for enumerable models (issue #53). An open
/// `Picker` popup is an NSMenu, and an NSMenu sizes to its WIDEST item — a
/// `.frame` on the closed control cannot bound it. Vendor catalogs are free
/// text with no length contract (Cursor ships very long labels), so the menu
/// STRING itself carries the guarantee. Kept in ClaudexorKit as a pure value
/// transform so the cap semantics are unit-tested without the UI and run in
/// CI (`QuotaPresentation` precedent).
public enum HarnessModelPresentation {
    /// Hard cap for one menu title. 48 characters keeps the widest possible
    /// menu item close to the closed control's `modelPickerWidth` while
    /// leaving both the human-label prefix and the id tail recognizable.
    public static let menuTitleMaxCharacters = 48

    /// The ONE shared "label (id)" derivation for catalog-fed picker menus
    /// (composer models rows + Settings model override): the id alone when no
    /// distinct label exists; whitespace runs collapse to single spaces (a
    /// menu item must never carry a newline); overflow truncates in the
    /// MIDDLE so the family prefix AND the differentiating id tail both stay
    /// readable.
    public static func menuTitle(label: String?, id: String) -> String {
        let name = label.flatMap { $0.isEmpty ? nil : $0 } ?? id
        let full = name == id ? name : "\(name) (\(id))"
        let collapsed = full.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard collapsed.count > menuTitleMaxCharacters else { return collapsed }
        let keep = menuTitleMaxCharacters - 1
        let head = (keep + 1) / 2
        return "\(collapsed.prefix(head))…\(collapsed.suffix(keep - head))"
    }
}

/// Models enumerable for one harness (GET /harnesses/:id/models). `source` is
/// honest about provenance: "api" when the adapter implemented a real
/// enumeration, "manifest" reserved for a future manifest list, "none" when the
/// adapter cannot enumerate (the list is then empty).
public struct HarnessModelsResponse: Codable, Sendable, Equatable {
    public let harnessId: String
    public let models: [HarnessModel]
    /// "api" | "manifest" | "none".
    public let source: String
    /// Freshness note for manifest-sourced lists: the vendor CLI version the
    /// known-model hints were last verified against (nil for api/none).
    public let verifiedAgainst: String?
    /// Present only when the live catalog read failed (code
    /// `model_catalog_unavailable`, `context.cause` naming why): `models` is
    /// then empty and is NOT an empty catalog (#393).
    public let problem: ControlProblem?
    /// The harness's declared request-time routing suffixes (#145/#146); empty
    /// when it declares none.
    public let routingVariants: [ModelRoutingVariantInfo]

    enum CodingKeys: String, CodingKey { case harnessId, models, source, verifiedAgainst, problem, routingVariants }

    public init(harnessId: String, models: [HarnessModel] = [], source: String, verifiedAgainst: String? = nil,
                problem: ControlProblem? = nil, routingVariants: [ModelRoutingVariantInfo] = []) {
        self.harnessId = harnessId
        self.models = models
        self.source = source
        self.verifiedAgainst = verifiedAgainst
        self.problem = problem
        self.routingVariants = routingVariants
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        harnessId = try c.decode(String.self, forKey: .harnessId)
        models = try c.decodeIfPresent([HarnessModel].self, forKey: .models) ?? []
        source = try c.decode(String.self, forKey: .source)
        verifiedAgainst = try c.decodeIfPresent(String.self, forKey: .verifiedAgainst)
        problem = try c.decodeIfPresent(ControlProblem.self, forKey: .problem)
        routingVariants = try c.decodeIfPresent([ModelRoutingVariantInfo].self, forKey: .routingVariants) ?? []
    }

    /// The row whose metadata applies to `model`: the exact row, else the listed
    /// row a declared routing variant names. The engine's rule (core
    /// `catalogRowFor`): suffixes combine in any order, so every DECLARED
    /// segment after the base id is removed and every other one stays
    /// (`m:nitro:free` -> `m:free`); that row must itself be listed. No other
    /// name is guessed.
    public func row(forModel model: String) -> HarnessModel? {
        if let exact = models.first(where: { $0.id == model }) { return exact }
        var segments = model.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard !segments.isEmpty, !segments[0].isEmpty else { return nil }
        let base = segments.removeFirst()
        let declared = Set(routingVariants.map { String($0.suffix.dropFirst()) })
        let kept = segments.filter { !declared.contains($0) }
        guard kept.count < segments.count else { return nil }
        let metadataId = ([base] + kept).joined(separator: ":")
        return models.first(where: { $0.id == metadataId })
    }

    /// True when a truth source exists (strict model-truth validation: no truth source = the
    /// harness runs its default only; there is no free-text model entry). A failed
    /// live read (`problem`) is not a truth source either, but it is not "default
    /// only": surfaces show the problem instead.
    public var canEnumerate: Bool { problem == nil && source != "none" && !models.isEmpty }

    /// The typed cause of a failed live catalog read (`context.cause`), if any.
    public var problemCause: String? { problem?.context["cause"]?.stringValue }
}
