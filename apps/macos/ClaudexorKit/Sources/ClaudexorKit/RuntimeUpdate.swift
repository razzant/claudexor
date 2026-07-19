import Foundation

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

// MARK: - Runtime manifest

/// `runtime-manifest.json` describing the published closure. `signature` is
/// reserved (always null for now) — parsed as an ignored optional, NEVER
/// required or verified. `sha256` is lowercase hex of the .tar.gz.
public struct RuntimeManifest: Codable, Sendable, Equatable {
    public let version: String
    public let sha256: String
    public let minAppVersion: String
    /// Reserved for a future signed-manifest scheme; always null today. Kept as
    /// an ignored optional so an old app never breaks when it starts being set.
    public let signature: String?
    public let notes: String

    public init(version: String, sha256: String, minAppVersion: String,
                signature: String? = nil, notes: String = "") {
        self.version = version
        self.sha256 = sha256
        self.minAppVersion = minAppVersion
        self.signature = signature
        self.notes = notes
    }

    private enum CodingKeys: String, CodingKey {
        case version, sha256, minAppVersion, signature, notes
    }

    // Lenient on `notes`/`signature` (defaulted/reserved), strict on the three
    // fields the updater actually gates on.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(String.self, forKey: .version)
        sha256 = try c.decode(String.self, forKey: .sha256)
        minAppVersion = try c.decode(String.self, forKey: .minAppVersion)
        signature = try c.decodeIfPresent(String.self, forKey: .signature)
        notes = try c.decodeIfPresent(String.self, forKey: .notes) ?? ""
    }

    /// Honest parse: nil unless the record is well-formed with a semver
    /// `version`, a semver `minAppVersion`, and a 64-char lowercase-hex
    /// `sha256`. An honest updater never acts on a manifest it cannot trust.
    public static func parse(_ data: Data) -> RuntimeManifest? {
        guard let decoded = try? JSONDecoder().decode(RuntimeManifest.self, from: data) else {
            return nil
        }
        let version = decoded.version.trimmingCharacters(in: .whitespacesAndNewlines)
        guard SemanticVersion(version) != nil else { return nil }
        guard SemanticVersion(decoded.minAppVersion) != nil else { return nil }
        let sha = decoded.sha256.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard isLowercaseHexSHA256(sha) else { return nil }
        return RuntimeManifest(
            version: version,
            sha256: sha,
            minAppVersion: decoded.minAppVersion.trimmingCharacters(in: .whitespacesAndNewlines),
            signature: nil,
            notes: decoded.notes
        )
    }
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
