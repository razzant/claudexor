import Foundation

/// How a raw-api packet was sized (`RawContextBudget`, #147). Every figure is a
/// characters ÷ 4 estimate, never a tokenizer count.
public struct RawContextBudgetInfo: Codable, Sendable, Equatable, Hashable {
    /// "model_context_window" (sized to a known window) or "assumed_ceiling"
    /// (no window known; `selectionLimitTokens` is an assumption, not a model fact).
    public let basis: String
    public let model: String?
    public let contextWindow: Int?
    public let outputAllowanceTokens: Int?
    public let selectionLimitTokens: Int
    public let omittedForBudget: Int

    enum CodingKeys: String, CodingKey {
        case basis, model
        case contextWindow = "context_window"
        case outputAllowanceTokens = "output_allowance_tokens"
        case selectionLimitTokens = "selection_limit_tokens"
        case omittedForBudget = "omitted_for_budget"
    }

    public init(basis: String, model: String?, contextWindow: Int?, outputAllowanceTokens: Int?,
                selectionLimitTokens: Int, omittedForBudget: Int) {
        self.basis = basis
        self.model = model
        self.contextWindow = contextWindow
        self.outputAllowanceTokens = outputAllowanceTokens
        self.selectionLimitTokens = selectionLimitTokens
        self.omittedForBudget = omittedForBudget
    }
}

/// The raw-api request the run's final attempt last prepared
/// (`ControlRunSummary.rawContext`), receipted just before its POST.
public struct RawContextReceiptInfo: Codable, Sendable, Equatable, Hashable {
    public let model: String
    public let estimatedRequestTokens: Int
    public let budget: RawContextBudgetInfo

    enum CodingKeys: String, CodingKey {
        case model, budget
        case estimatedRequestTokens = "estimated_request_tokens"
    }

    public init(model: String, estimatedRequestTokens: Int, budget: RawContextBudgetInfo) {
        self.model = model
        self.estimatedRequestTokens = estimatedRequestTokens
        self.budget = budget
    }

    /// The window the request was checked against: known only when the packet
    /// was sized for this same model's catalog window.
    public var checkedWindow: Int? {
        budget.basis == "model_context_window" && budget.model == model ? budget.contextWindow : nil
    }
}

/// Why a raw-api request was not sent (`RunFailure.rawContextShortfall`): the
/// parts add up past the window, and the mandatory files are part of the packet.
public struct RawContextShortfallInfo: Codable, Sendable, Equatable, Hashable {
    public struct File: Codable, Sendable, Equatable, Hashable {
        public let path: String
        public let estimatedTokens: Int

        enum CodingKeys: String, CodingKey {
            case path
            case estimatedTokens = "estimated_tokens"
        }

        public init(path: String, estimatedTokens: Int) {
            self.path = path
            self.estimatedTokens = estimatedTokens
        }
    }

    public let model: String
    public let contextWindow: Int
    public let packetTokens: Int
    public let framingTokens: Int
    public let outputAllowanceTokens: Int
    /// Every mandatory file, largest first.
    public let mandatoryFiles: [File]

    enum CodingKeys: String, CodingKey {
        case model
        case contextWindow = "context_window"
        case packetTokens = "packet_tokens"
        case framingTokens = "framing_tokens"
        case outputAllowanceTokens = "output_allowance_tokens"
        case mandatoryFiles = "mandatory_files"
    }

    public init(model: String, contextWindow: Int, packetTokens: Int, framingTokens: Int,
                outputAllowanceTokens: Int, mandatoryFiles: [File]) {
        self.model = model
        self.contextWindow = contextWindow
        self.packetTokens = packetTokens
        self.framingTokens = framingTokens
        self.outputAllowanceTokens = outputAllowanceTokens
        self.mandatoryFiles = mandatoryFiles
    }

    /// The whole request: packet, framing and the room kept for the answer.
    public var neededTokens: Int { packetTokens + framingTokens + outputAllowanceTokens }
    public var mandatoryTokens: Int { mandatoryFiles.reduce(0) { $0 + $1.estimatedTokens } }
    /// Everything that is not a mandatory file or the answer's room.
    public var otherRequestTokens: Int { neededTokens - mandatoryTokens - outputAllowanceTokens }
}

/// One declared request-time routing suffix (`model_routing_variants`, #145).
public struct ModelRoutingVariantInfo: Codable, Sendable, Equatable, Hashable {
    public let suffix: String
    public let billing: String

    public init(suffix: String, billing: String) {
        self.suffix = suffix
        self.billing = billing
    }
}
