import Foundation

public enum CredentialRoute: String, Codable, Sendable {
    case vendorNative = "vendor_native"
    case managedAPIKey = "managed_api_key"
    case local
}

public enum AuthAvailability: String, Codable, Sendable {
    case available, unavailable, unknown
}

public enum AuthVerification: String, Codable, Sendable {
    case passed, failed
    case notRun = "not_run"
}

public enum AuthSourceKind: String, Codable, Sendable {
    case nativeSession = "native_session"
    case oauthTokenEnvironment = "oauth_token_env"
    case apiKeyEnvironment = "api_key_env"
    case apiKeyFlag = "api_key_flag"
    case providerAuthFile = "provider_auth_file"
    case none
}

public enum BillingKnowledge: String, Codable, Sendable {
    case provenZero = "proven_zero"
    case subscriptionEntitlement = "subscription_entitlement"
    case metered, unknown
}

public enum CostKnowledge: String, Codable, Sendable {
    case exact, estimated, unknown
}

public struct AuthSourceReadiness: Codable, Sendable, Equatable {
    public let source: AuthSourceKind
    public let availability: AuthAvailability
    public let verification: AuthVerification
    public let detail: String?

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case source, availability, verification, detail
    }

    public init(source: AuthSourceKind, availability: AuthAvailability,
                verification: AuthVerification, detail: String? = nil) {
        self.source = source
        self.availability = availability
        self.verification = verification
        self.detail = detail
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        source = try container.decode(AuthSourceKind.self, forKey: .source)
        availability = try container.decode(AuthAvailability.self, forKey: .availability)
        verification = try container.decode(AuthVerification.self, forKey: .verification)
        detail = try decodeOptionalNonNull(String.self, from: container, forKey: .detail)
    }
}

public struct AuthReadinessRefreshRequest: Codable, Sendable, Equatable {
    public let authRequest: AuthRequest
    public let source: AuthSourceKind

    public init(authRequest: AuthRequest, source: AuthSourceKind) {
        self.authRequest = authRequest
        self.source = source
    }
}

public struct AuthReadinessRefreshResponse: Codable, Sendable, Equatable {
    public let harnessId: String
    public let authRequest: AuthRequest
    public let requestedSource: AuthSourceKind
    public let observedAt: String
    public let readiness: AuthSourceReadiness

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case harnessId, authRequest, requestedSource, observedAt, readiness
    }

    public init(harnessId: String, authRequest: AuthRequest, requestedSource: AuthSourceKind,
                observedAt: String, readiness: AuthSourceReadiness) {
        self.harnessId = harnessId
        self.authRequest = authRequest
        self.requestedSource = requestedSource
        self.observedAt = observedAt
        self.readiness = readiness
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        harnessId = try container.decode(String.self, forKey: .harnessId)
        authRequest = try container.decode(AuthRequest.self, forKey: .authRequest)
        requestedSource = try container.decode(AuthSourceKind.self, forKey: .requestedSource)
        observedAt = try container.decode(String.self, forKey: .observedAt)
        readiness = try container.decode(AuthSourceReadiness.self, forKey: .readiness)
        try require(!harnessId.isEmpty && parseOffsetTimestamp(observedAt) != nil,
                    decoder: decoder, "Auth readiness identity or timestamp is invalid")
        try require(readiness.source == requestedSource, decoder: decoder,
                    "Auth readiness source must match requestedSource")
    }
}

public struct ControlProblem: Codable, Sendable, Equatable {
    public let code: String
    public let message: String
    public let retryable: Bool
    public let fieldErrors: [String: [String]]
    public let requiredActions: [String]
    public let evidenceRefs: [String]

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case code, message, retryable, fieldErrors, requiredActions, evidenceRefs
    }

    public init(code: String, message: String, retryable: Bool,
                fieldErrors: [String: [String]] = [:], requiredActions: [String] = [],
                evidenceRefs: [String] = []) {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.fieldErrors = fieldErrors
        self.requiredActions = requiredActions
        self.evidenceRefs = evidenceRefs
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        code = try container.decode(String.self, forKey: .code)
        message = try container.decode(String.self, forKey: .message)
        retryable = try container.decode(Bool.self, forKey: .retryable)
        fieldErrors = container.contains(.fieldErrors)
            ? try container.decode([String: [String]].self, forKey: .fieldErrors) : [:]
        requiredActions = container.contains(.requiredActions)
            ? try container.decode([String].self, forKey: .requiredActions) : []
        evidenceRefs = container.contains(.evidenceRefs)
            ? try container.decode([String].self, forKey: .evidenceRefs) : []
        try require(!code.isEmpty && requiredActions.allSatisfy({ !$0.isEmpty })
                    && evidenceRefs.allSatisfy({ !$0.isEmpty }), decoder: decoder,
                    "Control problem code, actions, and evidence references must be non-empty")
    }
}

public enum AuthCapabilitySelectionReason: String, Codable, Sendable {
    case exactRequestedRoute = "exact_requested_route"
    case adapterUnavailable = "adapter_unavailable"
    case requestMismatch = "request_mismatch"
    case routeMissing = "route_missing"
    case routeMismatch = "route_mismatch"
    case sourceMissing = "source_missing"
    case sourceMismatch = "source_mismatch"
    case harnessError = "harness_error"
    case adapterError = "adapter_error"
    case missingCompletion = "missing_completion"
    case responseMismatch = "response_mismatch"
    case scratchMutated = "scratch_mutated"
    case protocolViolation = "protocol_violation"
    case adapterIdentityMismatch = "adapter_identity_mismatch"
    case cancelled
}

public struct AuthSmokeDisclosure: Codable, Sendable, Equatable {
    public let schemaVersion: Int
    public let protocolVersion: Int
    public let harness: String
    public let requested: AuthRequest
    public let requiredRoute: CredentialRoute
    public let requiredSource: AuthSourceKind
    public let networkScope: String
    public let billingKnowledge: BillingKnowledge
    public let incrementalCostKnowledge: CostKnowledge
    public let mayConsumeQuota: Bool
    public let generatedAt: String

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case schemaVersion, protocolVersion, harness, requested, requiredRoute, requiredSource
        case networkScope, billingKnowledge, incrementalCostKnowledge, mayConsumeQuota, generatedAt
    }

    public init(harness: String, requested: AuthRequest = .subscription,
                requiredRoute: CredentialRoute = .vendorNative,
                requiredSource: AuthSourceKind = .nativeSession,
                billingKnowledge: BillingKnowledge = .unknown,
                incrementalCostKnowledge: CostKnowledge = .unknown,
                mayConsumeQuota: Bool = true, generatedAt: String) {
        schemaVersion = 1
        protocolVersion = 1
        self.harness = harness
        self.requested = requested
        self.requiredRoute = requiredRoute
        self.requiredSource = requiredSource
        networkScope = "selected_harness_only"
        self.billingKnowledge = billingKnowledge
        self.incrementalCostKnowledge = incrementalCostKnowledge
        self.mayConsumeQuota = mayConsumeQuota
        self.generatedAt = generatedAt
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
        harness = try container.decode(String.self, forKey: .harness)
        requested = try container.decode(AuthRequest.self, forKey: .requested)
        requiredRoute = try container.decode(CredentialRoute.self, forKey: .requiredRoute)
        requiredSource = try container.decode(AuthSourceKind.self, forKey: .requiredSource)
        networkScope = try container.decode(String.self, forKey: .networkScope)
        billingKnowledge = try container.decode(BillingKnowledge.self, forKey: .billingKnowledge)
        incrementalCostKnowledge = try container.decode(CostKnowledge.self, forKey: .incrementalCostKnowledge)
        mayConsumeQuota = try container.decode(Bool.self, forKey: .mayConsumeQuota)
        generatedAt = try container.decode(String.self, forKey: .generatedAt)
        try require(schemaVersion == 1 && protocolVersion == 1 && !harness.isEmpty
                    && networkScope == "selected_harness_only"
                    && parseOffsetTimestamp(generatedAt) != nil, decoder: decoder,
                    "Invalid auth smoke disclosure contract")
        if requiredRoute == .vendorNative {
            try require(billingKnowledge == .unknown && incrementalCostKnowledge == .unknown
                        && mayConsumeQuota, decoder: decoder,
                        "Vendor-native disclosure must preserve unknown cost and quota risk")
        }
    }
}

public struct AuthCapabilityStreamEvidence: Codable, Sendable, Equatable {
    public let startedEvents: Int
    public let completedEvents: Int
    public let errorEvents: Int
    public let unexpectedToolEvents: Int
    public let interactionEvents: Int
    public let sessionMismatchEvents: Int
    public let eventsAfterCompleted: Int
    public let aborted: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case startedEvents, completedEvents, errorEvents, unexpectedToolEvents
        case interactionEvents, sessionMismatchEvents, eventsAfterCompleted, aborted
    }

    public init(startedEvents: Int, completedEvents: Int, errorEvents: Int,
                unexpectedToolEvents: Int, interactionEvents: Int,
                sessionMismatchEvents: Int, eventsAfterCompleted: Int, aborted: Bool) {
        self.startedEvents = startedEvents
        self.completedEvents = completedEvents
        self.errorEvents = errorEvents
        self.unexpectedToolEvents = unexpectedToolEvents
        self.interactionEvents = interactionEvents
        self.sessionMismatchEvents = sessionMismatchEvents
        self.eventsAfterCompleted = eventsAfterCompleted
        self.aborted = aborted
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        startedEvents = try container.decode(Int.self, forKey: .startedEvents)
        completedEvents = try container.decode(Int.self, forKey: .completedEvents)
        errorEvents = try container.decode(Int.self, forKey: .errorEvents)
        unexpectedToolEvents = try container.decode(Int.self, forKey: .unexpectedToolEvents)
        interactionEvents = try container.decode(Int.self, forKey: .interactionEvents)
        sessionMismatchEvents = try container.decode(Int.self, forKey: .sessionMismatchEvents)
        eventsAfterCompleted = try container.decode(Int.self, forKey: .eventsAfterCompleted)
        aborted = try container.decode(Bool.self, forKey: .aborted)
        try require([
            startedEvents, completedEvents, errorEvents, unexpectedToolEvents,
            interactionEvents, sessionMismatchEvents, eventsAfterCompleted,
        ].allSatisfy { $0 >= 0 }, decoder: decoder, "Negative auth stream event count")
    }
}

public struct AuthCapabilityReceipt: Codable, Sendable, Equatable {
    public let receiptId: String
    public let attemptId: String
    public let harness: String
    public let requested: AuthRequest
    public let requiredRoute: CredentialRoute
    public let requiredSource: AuthSourceKind
    public let effective: CredentialRoute?
    public let effectiveSource: AuthSourceKind?
    public let selectionReason: AuthCapabilitySelectionReason
    public let availability: AuthAvailability
    public let verification: AuthVerification
    public let billingKnowledge: BillingKnowledge
    public let costKnowledge: CostKnowledge
    public let costUsd: Double?
    public let startedAt: String
    public let completedAt: String
    public let challengeDigest: String
    public let requestDigest: String
    public let responseDigest: String
    public let streamDigest: String
    public let scratchBeforeDigest: String
    public let scratchAfterDigest: String
    public let stream: AuthCapabilityStreamEvidence
    public let evidenceRefs: [String]

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case receiptId, attemptId, harness, requested, requiredRoute, requiredSource
        case effective, effectiveSource, selectionReason, availability, verification
        case billingKnowledge, costKnowledge, costUsd, startedAt, completedAt
        case challengeDigest, requestDigest, responseDigest, streamDigest
        case scratchBeforeDigest, scratchAfterDigest, stream, evidenceRefs
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        receiptId = try container.decode(String.self, forKey: .receiptId)
        attemptId = try container.decode(String.self, forKey: .attemptId)
        harness = try container.decode(String.self, forKey: .harness)
        requested = try container.decode(AuthRequest.self, forKey: .requested)
        requiredRoute = try container.decode(CredentialRoute.self, forKey: .requiredRoute)
        requiredSource = try container.decode(AuthSourceKind.self, forKey: .requiredSource)
        effective = try requireNullable(CredentialRoute.self, from: container, forKey: .effective)
        effectiveSource = try requireNullable(AuthSourceKind.self, from: container, forKey: .effectiveSource)
        selectionReason = try container.decode(AuthCapabilitySelectionReason.self, forKey: .selectionReason)
        availability = try container.decode(AuthAvailability.self, forKey: .availability)
        verification = try container.decode(AuthVerification.self, forKey: .verification)
        billingKnowledge = try container.decode(BillingKnowledge.self, forKey: .billingKnowledge)
        costKnowledge = try container.decode(CostKnowledge.self, forKey: .costKnowledge)
        costUsd = try decodeOptionalNonNull(Double.self, from: container, forKey: .costUsd)
        startedAt = try container.decode(String.self, forKey: .startedAt)
        completedAt = try container.decode(String.self, forKey: .completedAt)
        challengeDigest = try container.decode(String.self, forKey: .challengeDigest)
        requestDigest = try container.decode(String.self, forKey: .requestDigest)
        responseDigest = try container.decode(String.self, forKey: .responseDigest)
        streamDigest = try container.decode(String.self, forKey: .streamDigest)
        scratchBeforeDigest = try container.decode(String.self, forKey: .scratchBeforeDigest)
        scratchAfterDigest = try container.decode(String.self, forKey: .scratchAfterDigest)
        stream = try container.decode(AuthCapabilityStreamEvidence.self, forKey: .stream)
        evidenceRefs = try container.decode([String].self, forKey: .evidenceRefs)
        let digests = [challengeDigest, requestDigest, responseDigest, streamDigest,
                       scratchBeforeDigest, scratchAfterDigest]
        let started = parseOffsetTimestamp(startedAt)
        let completed = parseOffsetTimestamp(completedAt)
        try require(!receiptId.isEmpty && !attemptId.isEmpty && !harness.isEmpty
                    && digests.allSatisfy(isSHA256) && (costUsd == nil || costUsd! >= 0)
                    && evidenceRefs.allSatisfy({ !$0.isEmpty }) && started != nil && completed != nil
                    && completed! >= started!,
                    decoder: decoder, "Invalid auth capability receipt")
        if verification == .passed {
            try require(availability == .available && effective == requiredRoute
                        && effectiveSource == requiredSource && selectionReason == .exactRequestedRoute
                        && responseDigest == challengeDigest && scratchBeforeDigest == scratchAfterDigest
                        && stream.startedEvents == 1 && stream.completedEvents == 1
                        && stream.errorEvents == 0 && stream.unexpectedToolEvents == 0
                        && stream.interactionEvents == 0 && stream.sessionMismatchEvents == 0
                        && stream.eventsAfterCompleted == 0 && !stream.aborted,
                        decoder: decoder, "Passed capability receipt lacks clean exact-route evidence")
        }
        if requiredRoute == .vendorNative {
            try require(billingKnowledge == .unknown && costKnowledge == .unknown,
                        decoder: decoder, "Vendor-native receipt cannot claim billing knowledge")
        }
        if costKnowledge == .unknown {
            try require(costUsd == nil, decoder: decoder, "Unknown cost cannot carry USD")
        } else {
            try require(costUsd != nil, decoder: decoder, "Known cost requires USD")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(receiptId, forKey: .receiptId)
        try container.encode(attemptId, forKey: .attemptId)
        try container.encode(harness, forKey: .harness)
        try container.encode(requested, forKey: .requested)
        try container.encode(requiredRoute, forKey: .requiredRoute)
        try container.encode(requiredSource, forKey: .requiredSource)
        if let effective { try container.encode(effective, forKey: .effective) }
        else { try container.encodeNil(forKey: .effective) }
        if let effectiveSource { try container.encode(effectiveSource, forKey: .effectiveSource) }
        else { try container.encodeNil(forKey: .effectiveSource) }
        try container.encode(selectionReason, forKey: .selectionReason)
        try container.encode(availability, forKey: .availability)
        try container.encode(verification, forKey: .verification)
        try container.encode(billingKnowledge, forKey: .billingKnowledge)
        try container.encode(costKnowledge, forKey: .costKnowledge)
        try container.encodeIfPresent(costUsd, forKey: .costUsd)
        try container.encode(startedAt, forKey: .startedAt)
        try container.encode(completedAt, forKey: .completedAt)
        try container.encode(challengeDigest, forKey: .challengeDigest)
        try container.encode(requestDigest, forKey: .requestDigest)
        try container.encode(responseDigest, forKey: .responseDigest)
        try container.encode(streamDigest, forKey: .streamDigest)
        try container.encode(scratchBeforeDigest, forKey: .scratchBeforeDigest)
        try container.encode(scratchAfterDigest, forKey: .scratchAfterDigest)
        try container.encode(stream, forKey: .stream)
        try container.encode(evidenceRefs, forKey: .evidenceRefs)
    }
}

public enum AuthCapabilityLifecycleState: String, Codable, Sendable {
    case disclosed, running, completed
    case interruptedUnknown = "interrupted_unknown"
}

public struct AuthCapabilityLifecycle: Codable, Sendable, Equatable {
    public let attemptId: String
    public let challengeDigest: String
    public let requestDigest: String
    public let disclosure: AuthSmokeDisclosure
    public let state: AuthCapabilityLifecycleState
    public let startedAt: String?
    public let completedAt: String?
    public let interruptedAt: String?
    public let receipt: AuthCapabilityReceipt?

    private enum CodingKeys: String, CodingKey, CaseIterable, StrictCodingKey {
        case attemptId, challengeDigest, requestDigest, disclosure, state
        case startedAt, completedAt, interruptedAt, receipt
    }

    public init(attemptId: String, challengeDigest: String, requestDigest: String,
                disclosure: AuthSmokeDisclosure, state: AuthCapabilityLifecycleState,
                startedAt: String? = nil, completedAt: String? = nil,
                interruptedAt: String? = nil, receipt: AuthCapabilityReceipt? = nil) {
        self.attemptId = attemptId
        self.challengeDigest = challengeDigest
        self.requestDigest = requestDigest
        self.disclosure = disclosure
        self.state = state
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.interruptedAt = interruptedAt
        self.receipt = receipt
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownKeys(in: decoder, allowed: CodingKeys.self)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        attemptId = try container.decode(String.self, forKey: .attemptId)
        challengeDigest = try container.decode(String.self, forKey: .challengeDigest)
        requestDigest = try container.decode(String.self, forKey: .requestDigest)
        disclosure = try container.decode(AuthSmokeDisclosure.self, forKey: .disclosure)
        state = try container.decode(AuthCapabilityLifecycleState.self, forKey: .state)
        startedAt = try decodeOptionalNonNull(String.self, from: container, forKey: .startedAt)
        completedAt = try decodeOptionalNonNull(String.self, from: container, forKey: .completedAt)
        interruptedAt = try decodeOptionalNonNull(String.self, from: container, forKey: .interruptedAt)
        receipt = try decodeOptionalNonNull(AuthCapabilityReceipt.self, from: container, forKey: .receipt)

        try require(!attemptId.isEmpty && isSHA256(challengeDigest) && isSHA256(requestDigest),
                    decoder: decoder, "Invalid auth capability binding")
        let disclosed = parseOffsetTimestamp(disclosure.generatedAt)
        switch state {
        case .disclosed:
            try require(startedAt == nil && completedAt == nil && interruptedAt == nil && receipt == nil,
                        decoder: decoder, "Disclosed capability has terminal fields")
        case .running:
            try require(startedAt != nil && completedAt == nil && interruptedAt == nil && receipt == nil,
                        decoder: decoder, "Running capability fields are incomplete")
        case .completed:
            try require(startedAt != nil && completedAt != nil && interruptedAt == nil && receipt != nil,
                        decoder: decoder, "Completed capability fields are incomplete")
            if let receipt {
                try require(receipt.attemptId == attemptId && receipt.challengeDigest == challengeDigest
                            && receipt.requestDigest == requestDigest && receipt.startedAt == startedAt
                            && receipt.completedAt == completedAt,
                            decoder: decoder, "Capability receipt does not match lifecycle binding")
            }
        case .interruptedUnknown:
            try require(startedAt != nil && completedAt == nil && interruptedAt != nil && receipt == nil,
                        decoder: decoder, "Interrupted capability fields are incomplete")
        }
        if let startedAt {
            let started = parseOffsetTimestamp(startedAt)
            try require(started != nil && disclosed != nil && started! >= disclosed!, decoder: decoder,
                        "Capability smoke cannot start before its disclosure")
        }
        if let completedAt {
            try require(parseOffsetTimestamp(completedAt) != nil, decoder: decoder,
                        "Capability completion timestamp is invalid")
        }
        if let interruptedAt {
            try require(parseOffsetTimestamp(interruptedAt) != nil, decoder: decoder,
                        "Capability interruption timestamp is invalid")
        }
    }
}
