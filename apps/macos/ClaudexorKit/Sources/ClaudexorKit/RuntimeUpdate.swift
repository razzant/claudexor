import Foundation
import CryptoKit

// MARK: - Engine-runtime updater: pure logic (M7)
//
// The macOS .app auto-updates the ENGINE RUNTIME CLOSURE (claudexord.bundle.cjs,
// setup-login-runner.cjs, browser-mcp-runtime/, native/) WITHOUT a new DMG. Node
// stays app-owned (a Node bump ships a new DMG). The release pipeline publishes
// two GitHub-release assets: `claudexor-runtime-<version>.tar.gz` (the closure)
// and `runtime-manifest.json` (below).
//
// This file holds the app-INDEPENDENT core so it is unit-tested with no network
// and no process: the manifest Codable + honest parse, semver compare, the
// update DECISION, and the current.json Codable. All process/tar/URLSession
// orchestration lives in ClaudexorApp.

// MARK: - Semantic version (compare-only core)

/// A permissive MAJOR.MINOR.PATCH parse used ONLY for ordering releases. Any
/// pre-release/build metadata (`-rc.1`, `+sha`) is stripped before comparing —
/// the updater orders release closures, not pre-release channels. Returns nil
/// for anything without at least one numeric component, so an honest parse never
/// invents an order from garbage.
public struct SemanticVersion: Sendable, Equatable, Comparable {
    public let major: Int
    public let minor: Int
    public let patch: Int

    public init?(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        // Drop build ("+...") then pre-release ("-...") metadata; keep the core.
        let core = trimmed.split(separator: "+", maxSplits: 1)[0]
            .split(separator: "-", maxSplits: 1)[0]
        let parts = core.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty, parts.count <= 3 else { return nil }
        var nums = [Int]()
        for part in parts {
            guard let n = Int(part), n >= 0 else { return nil }
            nums.append(n)
        }
        major = nums[0]
        minor = nums.count > 1 ? nums[1] : 0
        patch = nums.count > 2 ? nums[2] : 0
    }

    public static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
        (lhs.major, lhs.minor, lhs.patch) < (rhs.major, rhs.minor, rhs.patch)
    }
}

// MARK: - Runtime-update signing authority (D-2)

/// The PINNED runtime-update authority (public half). This is embedded here AND
/// tracked in release/runtime-update-authority.json (a test binds them). It is a
/// DEDICATED key, SEPARATE from the review-attestation key: it signs ONLY
/// runtime-update manifests. Verification is fail-closed against this key; a key
/// rotation ships a new signed DMG carrying the new pinned public half.
public struct RuntimeUpdateAuthority: Sendable, Equatable {
    public let keyId: String
    public let algorithm: String
    public let publicKeyPem: String

    public init(keyId: String, algorithm: String, publicKeyPem: String) {
        self.keyId = keyId
        self.algorithm = algorithm
        self.publicKeyPem = publicKeyPem
    }

    public static let pinned = RuntimeUpdateAuthority(
        keyId: "claudexor-runtime-update-v3.1.0-ed25519-ce7f15e6187e137d",
        algorithm: "Ed25519",
        publicKeyPem:
            "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA0AKwkzFo7g4oHTXn2hCyhNIWNV8wBqK4aGX8+Y6mfN0=\n-----END PUBLIC KEY-----\n"
    )

    /// The 32-byte raw Ed25519 key extracted from the SPKI PEM, or nil if the
    /// PEM is not a 44-byte Ed25519 SubjectPublicKeyInfo.
    func signingPublicKey() -> Curve25519.Signing.PublicKey? {
        let body = publicKeyPem
            .replacingOccurrences(of: "-----BEGIN PUBLIC KEY-----", with: "")
            .replacingOccurrences(of: "-----END PUBLIC KEY-----", with: "")
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\r", with: "")
            .trimmingCharacters(in: .whitespaces)
        guard let der = Data(base64Encoded: body), der.count == 44 else { return nil }
        // Ed25519 SPKI is a fixed 12-byte AlgorithmIdentifier prefix + the raw
        // 32-byte key; take the trailing 32 bytes as the raw representation.
        let raw = der.suffix(32)
        return try? Curve25519.Signing.PublicKey(rawRepresentation: raw)
    }
}

// MARK: - Runtime manifest (SIGNED contract, D-2)

/// `runtime-manifest.json` describing the published closure. In 3.1 this is the
/// SIGNED contract: every field except `signature` is covered by the Ed25519
/// signature, so an unsigned / unknown-key / tampered / regressed manifest is
/// REFUSED. `verified(_:authority:)` is the only trust boundary; the honest
/// `parse` shape-decode never establishes trust on its own.
public struct RuntimeManifest: Codable, Sendable, Equatable {
    public let schemaVersion: Int
    public let version: String
    public let sha256: String
    public let minAppVersion: String
    public let archiveName: String
    public let archiveUrl: String
    public let buildSha: String
    public let notes: String
    public let keyId: String
    public let algorithm: String
    public let signature: String

    public init(
        version: String,
        sha256: String,
        minAppVersion: String,
        archiveName: String? = nil,
        archiveUrl: String? = nil,
        buildSha: String = String(repeating: "0", count: 40),
        notes: String = "",
        keyId: String = "",
        algorithm: String = "Ed25519",
        signature: String = "",
        schemaVersion: Int = 1
    ) {
        self.schemaVersion = schemaVersion
        self.version = version
        self.sha256 = sha256
        self.minAppVersion = minAppVersion
        self.archiveName = archiveName ?? "claudexor-runtime-\(version).tar.gz"
        self.archiveUrl = archiveUrl ?? RuntimeManifest.archiveUrl(for: version)
        self.buildSha = buildSha
        self.notes = notes
        self.keyId = keyId
        self.algorithm = algorithm
        self.signature = signature
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, version, sha256, minAppVersion, archiveName, archiveUrl, buildSha, notes,
            keyId, algorithm, signature
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 0
        version = try c.decode(String.self, forKey: .version)
        sha256 = try c.decode(String.self, forKey: .sha256)
        minAppVersion = try c.decode(String.self, forKey: .minAppVersion)
        archiveName = try c.decodeIfPresent(String.self, forKey: .archiveName) ?? ""
        archiveUrl = try c.decodeIfPresent(String.self, forKey: .archiveUrl) ?? ""
        buildSha = try c.decodeIfPresent(String.self, forKey: .buildSha) ?? ""
        notes = try c.decodeIfPresent(String.self, forKey: .notes) ?? ""
        keyId = try c.decodeIfPresent(String.self, forKey: .keyId) ?? ""
        algorithm = try c.decodeIfPresent(String.self, forKey: .algorithm) ?? ""
        signature = try c.decodeIfPresent(String.self, forKey: .signature) ?? ""
    }

    /// The conventional archive filename bound into (and signed by) the manifest.
    public static func archiveName(for version: String) -> String {
        "claudexor-runtime-\(version).tar.gz"
    }

    /// The canonical release-asset URL bound into (and signed by) the manifest
    /// (D-2 name+URL binding). Matches the TS/mjs `runtimeArchiveUrl`.
    public static func archiveUrl(for version: String) -> String {
        "https://github.com/razzant/claudexor/releases/download/v\(version)/\(archiveName(for: version))"
    }

    /// Deterministic sorted-key JSON of the signed field subset — byte-identical
    /// to the TS/mjs `canonicalJson(runtimeManifestSignedFields(...))`.
    func signingBytes() -> Data {
        let fields: [(String, String)] = [
            ("algorithm", jsonString(algorithm)),
            ("archiveName", jsonString(archiveName)),
            ("archiveUrl", jsonString(archiveUrl)),
            ("buildSha", jsonString(buildSha)),
            ("keyId", jsonString(keyId)),
            ("minAppVersion", jsonString(minAppVersion)),
            ("notes", jsonString(notes)),
            ("schemaVersion", String(schemaVersion)),
            ("sha256", jsonString(sha256)),
            ("version", jsonString(version)),
        ]
        let body = fields.map { "\(jsonString($0.0)):\($0.1)" }.joined(separator: ",")
        return Data("{\(body)}".utf8)
    }

    /// Honest SHAPE decode (no signature check). Never a trust boundary on its
    /// own — callers must use `verified(_:authority:)`.
    public static func parse(_ data: Data) -> RuntimeManifest? {
        guard let decoded = try? JSONDecoder().decode(RuntimeManifest.self, from: data) else {
            return nil
        }
        let version = decoded.version.trimmingCharacters(in: .whitespacesAndNewlines)
        guard SemanticVersion(version) != nil else { return nil }
        guard SemanticVersion(decoded.minAppVersion) != nil else { return nil }
        // STRICT lowercase hex — the signed contract's canonical form is
        // lowercase, so normalizing here would silently diverge from the bytes
        // the signature covers. An uppercase sha256 is refused, not coerced.
        guard isLowercaseHexSHA256(decoded.sha256) else { return nil }
        return decoded
    }

    /// FAIL-CLOSED verification (D-2): shape + pinned authority + Ed25519
    /// signature over the canonical signed bytes. Returns nil on ANY failure —
    /// an unsigned / unknown-key / tampered / malformed manifest is refused, so
    /// the updater never acts on a manifest it cannot cryptographically trust.
    public static func verified(
        _ data: Data,
        authority: RuntimeUpdateAuthority = .pinned
    ) -> RuntimeManifest? {
        guard let m = parse(data) else { return nil }
        guard m.schemaVersion == 1 else { return nil }
        guard m.algorithm == "Ed25519", authority.algorithm == "Ed25519" else { return nil }
        guard m.keyId == authority.keyId else { return nil }
        guard isLowercaseHexSHA256(m.sha256) else { return nil }
        // 40-char lowercase-hex build sha (the handshake identity binding).
        guard m.buildSha.count == 40, isLowercaseHex(m.buildSha) else { return nil }
        // archiveName AND archiveUrl are bound to version (D-2 name+URL binding).
        guard m.archiveName == archiveName(for: m.version) else { return nil }
        guard m.archiveUrl == archiveUrl(for: m.version) else { return nil }
        guard let key = authority.signingPublicKey() else { return nil }
        guard let sig = Data(base64Encoded: m.signature), sig.count == 64 else { return nil }
        guard key.isValidSignature(sig, for: m.signingBytes()) else { return nil }
        return m
    }
}

/// JS-`JSON.stringify`-compatible quoted string: escape `"`, `\`, and control
/// chars (<0x20); everything else (incl. non-ASCII) is emitted raw UTF-8 —
/// matching the TS/mjs canonicalizer byte-for-byte.
func jsonString(_ value: String) -> String {
    var out = "\""
    for scalar in value.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\u{08}": out += "\\b"
        case "\u{09}": out += "\\t"
        case "\u{0A}": out += "\\n"
        case "\u{0C}": out += "\\f"
        case "\u{0D}": out += "\\r"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    out += "\""
    return out
}

/// True for a lowercase hex string (no length constraint).
func isLowercaseHex(_ value: String) -> Bool {
    guard !value.isEmpty else { return false }
    for scalar in value.unicodeScalars {
        switch scalar {
        case "0"..."9", "a"..."f": continue
        default: return false
        }
    }
    return true
}

/// True for a 64-character lowercase hex string (a sha256 digest). No regex
/// (repo no-regex discipline) — a manual character scan.
public func isLowercaseHexSHA256(_ value: String) -> Bool {
    guard value.count == 64 else { return false }
    for scalar in value.unicodeScalars {
        switch scalar {
        case "0"..."9", "a"..."f": continue
        default: return false
        }
    }
    return true
}

// MARK: - Update decision (given running engine, app version, manifest)

/// The pure verdict of a runtime-update check. `appUpdateRequired` is the
/// app-vs-engine skew guard: the closure is newer but this .app is too old to
/// run it, so the app is NOT allowed to download — a new DMG is required first.
public enum RuntimeUpdateDecision: Sendable, Equatable {
    /// No closure newer than the running engine.
    case upToDate
    /// A newer closure this app can run — the target the updater would install.
    case available(RuntimeManifest)
    /// A newer closure exists but requires a newer .app (`minAppVersion`). Do
    /// NOT download; report "app update required".
    case appUpdateRequired(minAppVersion: String, manifest: RuntimeManifest)
    /// The running engine version could not be parsed as semver, so no ordering
    /// is possible — reported honestly instead of guessing an update.
    case unknown(reason: String)
}

/// Decide whether to update. `appVersion` is the app's own
/// `CFBundleShortVersionString`; the sentinel "dev" (SwiftPM/CI, no bundle)
/// satisfies ANY `minAppVersion` floor so dogfood builds are never blocked.
public func decideRuntimeUpdate(
    runningEngineVersion: String,
    appVersion: String,
    manifest: RuntimeManifest
) -> RuntimeUpdateDecision {
    guard let manifestVersion = SemanticVersion(manifest.version) else {
        // parse() already guarantees this, but never trust an un-parsed manifest.
        return .unknown(reason: "manifest version '\(manifest.version)' is not a valid version")
    }
    guard let running = SemanticVersion(runningEngineVersion) else {
        return .unknown(reason: "running engine version '\(runningEngineVersion)' is not a valid version")
    }
    guard manifestVersion > running else { return .upToDate }

    // Newer closure exists — gate on the app-vs-engine skew floor.
    if appSatisfies(appVersion: appVersion, minAppVersion: manifest.minAppVersion) {
        return .available(manifest)
    }
    return .appUpdateRequired(minAppVersion: manifest.minAppVersion, manifest: manifest)
}

/// True when `appVersion` meets `minAppVersion`. "dev" (or any unparseable app
/// version, i.e. a SwiftPM/dev build with no bundle) satisfies every floor.
public func appSatisfies(appVersion: String, minAppVersion: String) -> Bool {
    guard let app = SemanticVersion(appVersion) else { return true }
    guard let floor = SemanticVersion(minAppVersion) else { return true }
    return app >= floor
}

// MARK: - Decision -> chip display

public extension RuntimeUpdateDecision {
    /// Map to the footer chip's display model. ONLY a runnable `.available`
    /// closure advertises a pending version; `appUpdateRequired`/`upToDate`/
    /// `unknown` show nothing (the Check-for-Updates affordance reports those
    /// verbatim — the quiet chip never nags about a download it cannot perform).
    var chipAvailability: UpdateAvailability? {
        if case let .available(manifest) = self {
            return UpdateAvailability(version: manifest.version)
        }
        return nil
    }
}

// MARK: - current.json / last-known-good.json

/// The ACTIVE runtime pointer under `~/.claudexor/runtime/`. `path` is the dir
/// under `runtime/` (e.g. "versions/3.1.0"). `last-known-good.json` shares this
/// exact shape and is the rollback target (version dirs are whole closures, so
/// restoring this pointer is the rollback).
public struct RuntimeCurrent: Codable, Sendable, Equatable {
    public let version: String
    public let path: String
    public let sha256: String
    /// ISO8601 timestamp of the swap.
    public let installedAt: String
    /// Git SHA disclosed by the engine handshake at install time (null until a
    /// handshake stamps it).
    public let engineSha: String?

    public init(version: String, path: String, sha256: String,
                installedAt: String, engineSha: String?) {
        self.version = version
        self.path = path
        self.sha256 = sha256
        self.installedAt = installedAt
        self.engineSha = engineSha
    }

    /// The conventional `versions/<version>` relative path for a version.
    public static func versionPath(_ version: String) -> String { "versions/\(version)" }

    /// Parse a pointer file. Nil for malformed bytes or an empty version/path —
    /// a corrupt pointer must fall back to the bundled runtime, never crash or
    /// resolve to a bogus dir.
    public static func parse(_ data: Data) -> RuntimeCurrent? {
        guard let decoded = try? JSONDecoder().decode(RuntimeCurrent.self, from: data) else {
            return nil
        }
        guard !decoded.version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !decoded.path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return decoded
    }
}
