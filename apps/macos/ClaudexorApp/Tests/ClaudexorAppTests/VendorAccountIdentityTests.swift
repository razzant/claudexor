import Testing
import Foundation
@testable import ClaudexorApp

/// Batch-6 item a: vendor identity is read from the account's LOCAL login file
/// (codex auth.json id_token claims / claude oauthAccount) and NEVER surfaces
/// token material. Synthetic files only — no real tokens.
@Suite struct VendorAccountIdentityTests {
    /// base64url-encode without padding (the JWT segment encoding).
    private func b64url(_ s: String) -> String {
        Data(s.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func codexAuth(email: String, plan: String) -> Data {
        let payload = #"{"email":"\#(email)","https://api.openai.com/auth":{"chatgpt_plan_type":"\#(plan)"}}"#
        let jwt = "\(b64url("{\"alg\":\"none\"}")).\(b64url(payload)).sig"
        // Includes secret-shaped keys the parser must NEVER surface.
        let json = #"{"OPENAI_API_KEY":"sk-SECRET","tokens":{"id_token":"\#(jwt)","access_token":"SECRET","refresh_token":"SECRET"}}"#
        return Data(json.utf8)
    }

    @Test func codexAuthExtractsEmailAndPlan() {
        let id = VendorIdentityParser.fromCodexAuth(codexAuth(email: "anton@example.com", plan: "pro"))
        #expect(id?.email == "anton@example.com")
        #expect(id?.plan == "pro")
        #expect(id?.summaryLine == "anton@example.com · Pro")
        // Never leaks token material.
        #expect(id?.summaryLine?.contains("SECRET") == false)
    }

    @Test func codexBusinessPlanHumanized() {
        let id = VendorIdentityParser.fromCodexAuth(
            codexAuth(email: "biz@example.com", plan: "self_serve_business_usage_based"))
        #expect(id?.summaryLine == "biz@example.com · Business")
    }

    @Test func codexApiKeyOnlyAuthHasNoIdentity() {
        // No id_token ⇒ nothing to identify (an API-key-only auth.json).
        #expect(VendorIdentityParser.fromCodexAuth(Data(#"{"OPENAI_API_KEY":"sk-x"}"#.utf8)) == nil)
    }

    @Test func claudeConfigExtractsEmail() {
        let json = #"{"oauthAccount":{"emailAddress":"anton@example.com","seatTier":"max","organizationName":"Org"}}"#
        let id = VendorIdentityParser.fromClaudeConfig(Data(json.utf8))
        #expect(id?.email == "anton@example.com")
        #expect(id?.summaryLine == "anton@example.com · Max")
    }

    @Test func claudeConfigWithoutOauthAccountIsNil() {
        #expect(VendorIdentityParser.fromClaudeConfig(Data(#"{"firstStartTime":"x"}"#.utf8)) == nil)
    }

    @Test func malformedJsonIsNilNeverCrash() {
        #expect(VendorIdentityParser.fromCodexAuth(Data("not json".utf8)) == nil)
        #expect(VendorIdentityParser.fromClaudeConfig(Data("not json".utf8)) == nil)
        #expect(VendorIdentityParser.jwtPayload("only.two") == nil)
    }

    @Test func summaryLineOmitsEmptyHalves() {
        #expect(VendorAccountIdentity(email: "a@b.com", plan: nil).summaryLine == "a@b.com")
        #expect(VendorAccountIdentity(email: nil, plan: "pro").summaryLine == "Pro")
        #expect(VendorAccountIdentity(email: nil, plan: nil).summaryLine == nil)
    }

    // MARK: - File path resolution

    @Test func profileUsesIsolationLocator() {
        let path = VendorIdentityLoader.filePath(
            harnessId: "codex", isolationLocator: "/x/profiles/codex-a",
            env: [:], home: "/home", fileExists: { _ in true })
        #expect(path == "/x/profiles/codex-a/auth.json")
    }

    @Test func claudeProfilePathIsClaudeJson() {
        let path = VendorIdentityLoader.filePath(
            harnessId: "claude", isolationLocator: "/x/profiles/claude-a",
            env: [:], home: "/home", fileExists: { _ in true })
        #expect(path == "/x/profiles/claude-a/.claude.json")
    }

    @Test func nativeCodexProbesConventionalHomes() {
        // No isolation_locator ⇒ probe the conventional homes; the FIRST existing
        // candidate wins (here only ~/.codex/auth.json exists).
        let path = VendorIdentityLoader.filePath(
            harnessId: "codex", isolationLocator: nil, env: [:], home: "/home",
            fileExists: { $0 == "/home/.codex/auth.json" })
        #expect(path == "/home/.codex/auth.json")
    }

    @Test func nativeCodexHonorsEnvOverride() {
        let path = VendorIdentityLoader.filePath(
            harnessId: "codex", isolationLocator: nil,
            env: ["CLAUDEXOR_CODEX_NATIVE_HOME": "/scoped/codex"], home: "/home",
            fileExists: { $0 == "/scoped/codex/auth.json" })
        #expect(path == "/scoped/codex/auth.json")
    }

    @Test func nativeUnresolvedReturnsNil() {
        // No candidate exists ⇒ nil (the row keeps its current detail).
        #expect(VendorIdentityLoader.filePath(
            harnessId: "codex", isolationLocator: nil, env: [:], home: "/home",
            fileExists: { _ in false }) == nil)
    }

    @Test func unknownHarnessHasNoVendorFile() {
        #expect(VendorIdentityLoader.filePath(
            harnessId: "cursor", isolationLocator: "/x", env: [:], home: "/home",
            fileExists: { _ in true }) == nil)
    }
}
