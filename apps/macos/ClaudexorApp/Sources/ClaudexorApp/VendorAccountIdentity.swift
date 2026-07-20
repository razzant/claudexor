import Foundation

// MARK: - Vendor account identity (batch-6 item a, INV-135)
//
// The non-secret vendor identity behind ONE account row — the subscription email
// + plan the vendor's OWN login file records — read LOCALLY from the profile's
// `isolation_locator` (or a native home). The wire never carries the email/plan,
// so the accounts surface reads it off disk. This code decodes ONLY the identity
// claims (email, plan); it MUST NEVER surface token material (id_token /
// access_token / refresh_token / OPENAI_API_KEY / oauth secrets).

/// The vendor identity shown as an account row's secondary line: the login email
/// and the subscription plan, whichever the vendor's config file records.
struct VendorAccountIdentity: Equatable, Sendable {
    let email: String?
    let plan: String?

    /// The ONE compact secondary line, or nil when neither field resolved (the
    /// row then keeps its current detail — absence ≠ a blank line).
    var summaryLine: String? {
        let e = email?.trimmingCharacters(in: .whitespaces)
        let p = plan.map(VendorAccountIdentity.planLabel)?.trimmingCharacters(in: .whitespaces)
        switch (e?.isEmpty == false ? e : nil, p?.isEmpty == false ? p : nil) {
        case let (email?, plan?): return "\(email) · \(plan)"
        case let (email?, nil): return email
        case let (nil, plan?): return plan
        case (nil, nil): return nil
        }
    }

    /// Humanize a raw plan token into a short label (pure). Codex plan types and
    /// Claude seat tiers both funnel through here so the row reads the same.
    static func planLabel(_ raw: String) -> String {
        switch raw.lowercased() {
        case "pro": return "Pro"
        case "plus": return "Plus"
        case "free": return "Free"
        case "max", "max_20x", "max_5x": return "Max"
        case "team": return "Team"
        case "enterprise", "enterprise_seat": return "Enterprise"
        case "business", "self_serve_business_usage_based", "business_usage_based": return "Business"
        default:
            // Unknown token: clean it up rather than leaking snake_case wire text.
            let words = raw.split(whereSeparator: { $0 == "_" || $0 == "-" })
            return words.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
        }
    }
}

/// Pure parsers for the two vendor login-file shapes (verified against real
/// files on 2026-07-20). Never returns token material.
enum VendorIdentityParser {
    /// Codex `auth.json`: `tokens.id_token` is a JWT whose payload carries the
    /// `email` claim and `["https://api.openai.com/auth"].chatgpt_plan_type`. We
    /// decode ONLY those identity claims — the raw token is never surfaced.
    static func fromCodexAuth(_ data: Data) -> VendorAccountIdentity? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        let idToken = (root["tokens"] as? [String: Any])?["id_token"] as? String
        guard let payload = idToken.flatMap(jwtPayload) else {
            // No id_token (e.g. an API-key-only auth.json) — nothing to identify.
            return nil
        }
        let email = payload["email"] as? String
        let authClaims = payload["https://api.openai.com/auth"] as? [String: Any]
        let plan = authClaims?["chatgpt_plan_type"] as? String
        let identity = VendorAccountIdentity(email: email, plan: plan)
        return identity.summaryLine == nil ? nil : identity
    }

    /// Claude `.claude.json`: `oauthAccount.emailAddress` + the seat tier as the
    /// plan-ish label. Only these non-secret identity fields are read.
    static func fromClaudeConfig(_ data: Data) -> VendorAccountIdentity? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let account = root["oauthAccount"] as? [String: Any] else { return nil }
        let email = account["emailAddress"] as? String
        let plan = (account["seatTier"] as? String) ?? (account["billingType"] as? String)
        let identity = VendorAccountIdentity(email: email, plan: plan)
        return identity.summaryLine == nil ? nil : identity
    }

    /// Decode a JWT payload (the middle base64url segment) into a JSON object.
    /// Pure; no signature check (identity display only, never authorization).
    static func jwtPayload(_ jwt: String) -> [String: Any]? {
        let segments = jwt.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3 else { return nil }
        guard let data = base64urlDecode(String(segments[1])) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// Base64url → Data (pads, swaps the URL alphabet). No regex (house rule).
    static func base64urlDecode(_ s: String) -> Data? {
        var b64 = s.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = b64.count % 4
        if remainder > 0 { b64 += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: b64)
    }

    /// Dispatch a file's bytes to the right parser by harness id.
    static func parse(harnessId: String, data: Data) -> VendorAccountIdentity? {
        switch harnessId {
        case "codex": return fromCodexAuth(data)
        case "claude": return fromClaudeConfig(data)
        default: return nil
        }
    }
}

/// Resolves the LOCAL file that records a row's vendor identity, and reads it
/// off the main actor. Profile rows use their wire `isolation_locator`; native
/// "CLI login" rows fall back to the conventional vendor home. All best-effort:
/// an unresolved / unreadable path yields nil and the row keeps its detail.
enum VendorIdentityLoader {
    /// The vendor login FILE for `harnessId`, given the profile's config dir (the
    /// wire `isolation_locator`) or, for a native row, nil → the conventional
    /// home. Pure: `env`, `home`, and `fileExists` are injected so it is tested.
    static func filePath(
        harnessId: String,
        isolationLocator: String?,
        env: [String: String],
        home: String,
        fileExists: (String) -> Bool
    ) -> String? {
        let fileName: String
        switch harnessId {
        case "codex": fileName = "auth.json"
        case "claude": fileName = ".claude.json"
        default: return nil
        }
        if let dir = isolationLocator, !dir.isEmpty {
            return join(dir, fileName)
        }
        // Native/CLI-login row: probe the conventional homes in priority order.
        let candidateDirs: [String]
        switch harnessId {
        case "codex":
            candidateDirs = [
                env["CLAUDEXOR_CODEX_NATIVE_HOME"], env["CODEX_HOME"],
                join(home, ".claudexor/v3/native/codex"), join(home, ".codex"),
            ].compactMap { $0 }
        case "claude":
            candidateDirs = [
                env["CLAUDEXOR_CLAUDE_NATIVE_HOME"], env["CLAUDE_CONFIG_DIR"],
                join(home, ".claude"), home,
            ].compactMap { $0 }
        default:
            candidateDirs = []
        }
        for dir in candidateDirs {
            let path = join(dir, fileName)
            if fileExists(path) { return path }
        }
        return nil
    }

    private static func join(_ dir: String, _ file: String) -> String {
        (dir as NSString).appendingPathComponent(file)
    }

    /// Read + parse the vendor identity off the main actor. nil on any failure
    /// (unresolved path, unreadable file, no identity claims) — never throws.
    static func load(harnessId: String, isolationLocator: String?) async -> VendorAccountIdentity? {
        let env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        return await Task.detached(priority: .utility) {
            guard let path = filePath(
                harnessId: harnessId, isolationLocator: isolationLocator,
                env: env, home: home, fileExists: { FileManager.default.fileExists(atPath: $0) }
            ) else { return nil }
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: [.mappedIfSafe]) else {
                return nil
            }
            return VendorIdentityParser.parse(harnessId: harnessId, data: data)
        }.value
    }
}
