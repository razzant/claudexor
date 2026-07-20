import Foundation
import SwiftUI

/// Review-findings domain models. Extracted from `DomainModels.swift` (the
/// readability ratchet) — same UI-side projections of the engine's review axes:
/// severity, route-proof provenance, adjudication status, the finding row, and
/// the review verdict. The canonical shapes live in `packages/schema`.

// MARK: - Review findings

enum Severity: String, CaseIterable, Hashable {
    case blocker, major, minor, nit
    var label: String { rawValue.capitalized }
    var glyph: String {
        switch self {
        case .blocker: return "xmark.octagon.fill"
        case .major: return "exclamationmark.triangle.fill"
        case .minor: return "exclamationmark.circle"
        case .nit: return "sparkle"
        }
    }
    var color: Color {
        switch self {
        case .blocker: return Theme.status(.negative)
        case .major: return Theme.status(.caution)
        case .minor: return Theme.status(.info)
        case .nit: return .secondary
        }
    }
    var rank: Int { Self.allCases.firstIndex(of: self) ?? 9 }
}

enum RouteProof: String, Hashable {
    case verified, acceptedModelArg, unverified, sameModelFallback
    var label: String {
        switch self {
        case .verified: return "Route verified"
        case .acceptedModelArg: return "Model arg accepted"
        case .unverified: return "Route unverified"
        case .sameModelFallback: return "Same-model fallback"
        }
    }
    var glyph: String {
        switch self {
        case .verified: return "checkmark.shield.fill"
        case .acceptedModelArg: return "checkmark.shield"
        case .unverified: return "shield"
        case .sameModelFallback: return "exclamationmark.shield"
        }
    }
    var color: Color {
        switch self {
        case .verified: return Theme.status(.positive)
        case .acceptedModelArg: return Theme.accent
        case .unverified: return .secondary
        case .sameModelFallback: return Theme.status(.caution)
        }
    }
}

enum FindingStatus: String, Hashable {
    case proposed
    case accepted
    case rebutted
    case fixed
    case acceptedRisk
    case duplicate
    case stale
    case outOfScope
    case insufficientEvidence

    init(api: String?) {
        switch api?.lowercased() {
        case "accepted": self = .accepted
        case "rebutted": self = .rebutted
        case "fixed": self = .fixed
        case "accepted_risk", "accepted-risk": self = .acceptedRisk
        case "duplicate": self = .duplicate
        case "stale": self = .stale
        case "out_of_scope", "out-of-scope": self = .outOfScope
        case "insufficient_evidence", "insufficient-evidence": self = .insufficientEvidence
        default: self = .proposed
        }
    }

    var label: String {
        switch self {
        case .proposed: return "Proposed"
        case .accepted: return "Accepted"
        case .rebutted: return "Rebutted"
        case .fixed: return "Fixed"
        case .acceptedRisk: return "Accepted Risk"
        case .duplicate: return "Duplicate"
        case .stale: return "Stale"
        case .outOfScope: return "Out of Scope"
        case .insufficientEvidence: return "Insufficient"
        }
    }

    var color: Color {
        switch self {
        case .accepted, .fixed: return Theme.status(.positive)
        case .rebutted, .outOfScope: return Theme.status(.negative)
        case .insufficientEvidence, .acceptedRisk: return Theme.status(.caution)
        case .duplicate, .stale, .proposed: return .secondary
        }
    }
}

struct Finding: Identifiable, Hashable {
    let id: String
    var severity: Severity
    var category: String
    var title: String
    var detail: String
    var reviewer: HarnessFamily
    var routeProof: RouteProof
    var evidenceFile: String?
    var evidenceLine: Int?
    var status: FindingStatus = .proposed
    var taskTitle: String = ""
    var hasEvidence: Bool { evidenceFile != nil }
}

enum ReviewVerdict: String, Hashable {
    case notRun = "not_run"
    case running
    case clean
    case findings
    case failed
    case error

    var label: String {
        switch self {
        case .notRun: return "Not run"
        case .running: return "Running"
        case .clean: return "Clean"
        case .findings: return "Findings"
        case .failed: return "Failed"
        case .error: return "Error"
        }
    }
}
