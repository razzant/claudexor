import Foundation

// MARK: - Access profile (per-turn write scope)

/// How much a write turn may touch — surfaced in the composer's "⋯" options and
/// sent on the turn (the engine's `access` field). Read-only modes ignore it.
///
/// Extracted from `DomainModels.swift` so the five-value model stays a small,
/// single-owner unit (INV-124 readability ratchet).
enum AccessProfile: String, CaseIterable, Identifiable {
    // All five engine wire values are modelled so a thread carrying an advanced
    // profile decodes/round-trips losslessly (never coerced to Full/Read-only).
    case readOnly, workspaceWrite, full, externalSandboxFull, inheritNative
    var id: String { rawValue }
    /// The profiles a composer turn may PICK. The advanced two
    /// (external-sandbox-full, inherit-native) are engine/CLI-only — present in
    /// the enum for lossless decode, never offered as a composer choice.
    static let composerCases: [AccessProfile] = [.readOnly, .workspaceWrite, .full]
    var label: String {
        switch self {
        case .readOnly: return "Read-only"
        case .workspaceWrite: return "Workspace write"
        case .full: return "Full access"
        case .externalSandboxFull: return "External sandbox (full)"
        case .inheritNative: return "Inherit native"
        }
    }
    var glyph: String {
        switch self {
        case .readOnly: return "eye"
        case .workspaceWrite: return "square.and.pencil"
        case .full: return "lock.open"
        case .externalSandboxFull: return "shippingbox"
        case .inheritNative: return "arrow.triangle.branch"
        }
    }
    /// The engine wire value for `ControlRunStartRequest.access`.
    var wire: String {
        switch self {
        case .readOnly: return "readonly"
        case .workspaceWrite: return "workspace_write"
        case .full: return "full"
        case .externalSandboxFull: return "external_sandbox_full"
        case .inheritNative: return "inherit_native"
        }
    }
    /// Lossless decode from an engine wire value (nil for an unknown value — the
    /// caller falls back to the raw string, never a silent coercion).
    init?(wire: String) {
        switch wire {
        case "readonly": self = .readOnly
        case "workspace_write": self = .workspaceWrite
        case "full": self = .full
        case "external_sandbox_full": self = .externalSandboxFull
        case "inherit_native": self = .inheritNative
        default: return nil
        }
    }
    /// Humanize a raw engine access wire value for badges (covers all five;
    /// unknown values pass through verbatim rather than being coerced).
    static func humanize(_ wire: String) -> String { AccessProfile(wire: wire)?.label ?? wire }
}
