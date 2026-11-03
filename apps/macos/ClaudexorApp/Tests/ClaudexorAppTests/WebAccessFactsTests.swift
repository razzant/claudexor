import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// #118/#413: the run facts say what was requested, what was prepared for each
/// route, whether a native session was reported and what was observed, without
/// overstating any of it. The summaries were projected by the built engine from
/// its real producers (`web-access-summaries.json`, made by
/// `.review-evidence/scripts/gen-web-access-summaries-v4.mjs`; temp paths
/// neutralized): the per-spawn gate, adapter native settings and refusals, real
/// parsers, recorded Browser MCP replies, the telemetry fold and the control-API
/// projection.
@MainActor
struct WebAccessFactsTests {
    static func wire(_ name: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: "web-access-summaries", withExtension: "json"))
        let all = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try JSONSerialization.data(withJSONObject: try #require(all[name]))
    }

    static func summary(_ name: String) throws -> RunSummary {
        try JSONDecoder().decode(RunSummary.self, from: wire(name))
    }

    static func detail(_ name: String) throws -> RunDetail {
        let json = #"{"summary":"#.data(using: .utf8)! + (try wire(name)) + "}".data(using: .utf8)!
        return try JSONDecoder().decode(RunDetail.self, from: json)
    }

    static func fact(_ id: String, in name: String) throws -> RunFacts.Fact {
        let facts = RunFacts.headerDetails(AppModel.liveTask(from: try summary(name)))
        return try #require(facts.first { $0.id == id })
    }

    // MARK: Web evidence strength

    @Test func aCompletedSearchWithoutRetrievalProofIsReachedNotVerified() throws {
        let web = try Self.fact("web", in: "codexSearch")
        #expect(web.text == "Web reached")
        #expect(web.tone == .neutral)
        let help = try #require(web.help)
        #expect(help.contains("Requested web policy: auto."))
        #expect(help.contains("A web call completed, but no typed result shows a page or search results."))
        #expect(help.contains("codex: built-in web search cached (native setting)"))
        #expect(help.contains("network traffic is not measured"))
    }

    @Test func onlyAResultThatShowsTheRetrievedPageIsVerified() throws {
        let web = try Self.fact("web", in: "browserVerified")
        #expect(web.text == "Web verified")
        #expect(web.tone == .success)
        #expect(web.help?.contains("Page retrieved: a typed result shows the loaded page") == true)
        #expect(web.help?.contains("claude: built-in web tools allowed; Browser handed to it") == true)
    }

    @Test func aClaudeSearchIsSearchedNeverAFetchedPage() throws {
        let web = try Self.fact("web", in: "claudeSearch")
        #expect(web.text == "Web searched")
        #expect(web.tone == .success)
        let help = try #require(web.help)
        #expect(help.contains("Search results returned: a web search reported results; that is not a fetched page."))
        #expect(!help.contains("Page retrieved"))
    }

    @Test func aBrowserCallThatReadNoPageIsNeitherReachedNorVerified() throws {
        let web = try Self.fact("web", in: "browserClosedOnly")
        #expect(web.text == "Web tools used")
        #expect(web.tone == .neutral)
        let help = try #require(web.help)
        #expect(help.contains("Web tools completed, but no page or search result was recorded."))
        #expect(!help.contains("Web reached"))
    }

    @Test func anOlderEngineWithoutStrengthOrRoutesClaimsNeither() throws {
        let web = try Self.fact("web", in: "olderEngineSearch")
        #expect(web.text == "Web tools used")
        let help = try #require(web.help)
        #expect(help.contains("This engine did not report what its web calls retrieved."))
        #expect(help.contains("No route recorded its native web switch."))
        // Scope is the engine's statement: an engine that did not make it is not quoted.
        #expect(!help.contains("network traffic is not measured"))
    }

    @Test func anOlderVerifiedRecordClaimsNoPage() throws {
        let web = try Self.fact("web", in: "olderRecordVerified")
        #expect(web.text == "Web verified")
        #expect(web.help?.contains("A typed web result was returned; this record does not say whether it was a page or search results.") == true)
    }

    // MARK: Browser startup (#215)

    /// The badge itself states what the route reported: prepared (no report, or an
    /// engine that sends none), ready, startup failed or cancelled, or startup
    /// unconfirmed. Admission refusals keep their own text, and every state stays
    /// neutral: a Browser that did not start never reads as a failed run.
    @Test(arguments: [
        ("browserVerified", "claude: browser prepared"),
        ("olderEngineBrowser", "codex: browser prepared"),
        ("codexBrowserReady", "codex: browser ready"),
        ("codexBrowserFailed", "codex: browser startup failed"),
        ("codexBrowserCancelled", "codex: browser startup cancelled"),
        ("codexBrowserStillStarting", "codex: browser startup unconfirmed"),
        ("codexBrowserNotObserved", "codex: browser startup unconfirmed"),
        ("codexBrowserMixed", "codex: browser startup failed"),
        ("codexBrowserUnavailable", "codex: browser unavailable (access_profile_incompatible)"),
    ])
    func theBrowserBadgeStatesTheReportedStartup(_ scenario: String, _ text: String) throws {
        let badge = try Self.fact("browser", in: scenario)
        #expect(badge.text == text)
        #expect(badge.tone == .neutral)
        #expect(badge.glyph == "globe")
        // Never more than Codex said: no connection or usability is claimed.
        #expect(!badge.text.contains("connected") && !badge.text.contains("usable"))
        #expect(!badge.text.contains("enabled"))
    }

    @Test func theBrowserStartupIsStatedOnlyAsReported() throws {
        // The badge's help keeps the route's own report, also when the model never
        // used the web.
        let ready = try Self.fact("browser", in: "codexBrowserReady")
        #expect(ready.help == "codex: browser ready\n"
            + "codex: Browser handed to it, ready before the first model request (waited 2.1 s)")
        let failed = try #require(try Self.fact("browser", in: "codexBrowserFailed").help)
        #expect(failed.contains("codex: Browser handed to it, failed to start: browser launcher exited; the run continued without it"))
        let cancelled = try #require(try Self.fact("browser", in: "codexBrowserCancelled").help)
        #expect(cancelled.contains("codex: Browser handed to it, startup cancelled: no reason given; the run continued without it"))
        let late = try #require(try Self.fact("browser", in: "codexBrowserStillStarting").help)
        #expect(late.contains("codex: Browser handed to it, still starting after 90.1 s; the first model request may not have offered it"))
        let silent = try #require(try Self.fact("browser", in: "codexBrowserNotObserved").help)
        #expect(silent.contains("codex: Browser handed to it, no startup status reported; the first model request may not have offered it"))
        let mixed = try #require(try Self.fact("browser", in: "codexBrowserMixed").help)
        #expect(mixed.contains("ready before the first model request") && mixed.contains("failed to start: browser launcher exited"))
        // Handed but never reported: prepared settings are not a connection.
        let prepared = try #require(try Self.fact("browser", in: "browserVerified").help)
        #expect(prepared.contains("claude: Browser handed to it; startup not reported"))
        #expect(!prepared.contains("ready"))
        let webHelp = try #require(try Self.fact("web", in: "browserVerified").help)
        #expect(webHelp.contains("claude: built-in web tools allowed; Browser handed to it\n"))
        // A run's lifecycle is not touched by any of these.
        for scenario in ["codexBrowserFailed", "codexBrowserCancelled", "codexBrowserNotObserved"] {
            let task = AppModel.liveTask(from: try Self.summary(scenario))
            #expect(!task.phase.isFailureShaped, "\(scenario)")
        }
    }

    // MARK: Web Off: requested, prepared, observed, missing

    @Test func webOffThatRanNamesEachRoutesSwitchAndWhatIsNotMeasured() throws {
        let web = try Self.fact("web", in: "webOffReadonly")
        #expect(web.text == "Web tools off")
        #expect(web.tone == .neutral)
        let help = try #require(web.help)
        #expect(help.contains("Requested web policy: off."))
        #expect(help.contains("Observed: no web tool call."))
        #expect(help.contains("codex: built-in web search off (native setting)"))
        #expect(help.contains("claude: built-in web tools denied"))
        #expect(help.contains("Browser: not handed to any route"))
        #expect(help.contains("network traffic is not measured"))
        #expect(help.contains("an allowed shell command can still reach the network"))
    }

    @Test func webOffRefusedBeforeLaunchIsOnlyRequested() throws {
        let web = try Self.fact("web", in: "webOffRefused")
        #expect(web.text == "Web Off requested")
        let help = try #require(web.help)
        #expect(help.contains("Requested web policy: off."))
        #expect(help.contains("claude: built-in web tools denied — prepared only, no native start reported"))
        #expect(!help.contains("switched off by"))
    }

    @Test func webOffWithoutRouteFactsNeverClaimsToolsWereSwitchedOff() throws {
        let legacy = try Self.fact("web", in: "webOffLegacyTelemetry")
        #expect(legacy.text == "Web Off requested")
        #expect(legacy.help?.contains(
            "No route recorded its native web switch, so nothing here says a web tool was switched off.") == true)
        let running = try Self.fact("web", in: "webOffNoTelemetry")
        #expect(running.text == "Web Off requested")
        let help = try #require(running.help)
        #expect(help.contains("Web/tool telemetry unavailable for this run"))
        #expect(help.contains("No route recorded its native web switch"))
        #expect(!help.contains("Observed: no web tool call."))
        #expect(!help.contains("network traffic is not measured"))
    }

    // MARK: Access

    @Test func accessNamesTheNativeSettingAndNeverClaimsEnforcement() throws {
        let cursor = try Self.fact("access", in: "cursorReadonly")
        #expect(cursor.text == "Read-only · no OS file boundary declared")
        let help = try #require(cursor.help)
        #expect(!help.localizedCaseInsensitiveContains("enforce"))
        #expect(help.contains("Requested Read-only."))
        #expect(help.contains("cursor: --force --sandbox enabled --trust --mode ask"))
        #expect(help.contains("vendor tool allowlist; no OS file boundary declared"))
    }

    @Test func aFalseHomeFactSaysNotScopedNotTheOperatorsOwn() throws {
        let help = try #require(try Self.fact("access", in: "cursorReadonly").help)
        #expect(help.contains("HOME: not scoped by Claudexor"))
        #expect(!help.contains("your own"))
        // No applied fact recorded: no HOME sentence at all.
        let refused = try #require(try Self.fact("access", in: "webOffRefused").help)
        #expect(!refused.contains("HOME"))
    }

    @Test func aVendorSandboxIsNamedAsTheVendorsAndMixedRoutesSaySo() throws {
        let codex = try Self.fact("access", in: "codexSearch")
        #expect(codex.text == "Workspace write · vendor sandbox")
        #expect(codex.help?.contains("vendor file-system sandbox") == true)
        #expect(codex.help?.contains("HOME: Claudexor-owned") == true)
        let mixed = try Self.fact("access", in: "webOffReadonly")
        #expect(mixed.text == "Read-only · OS boundary varies by route")
        #expect(mixed.help?.contains("Claudexor adds no OS file boundary of its own") == true)
    }

    @Test func inheritNativeNeverImpliesNoConfinement() throws {
        let only = try Self.fact("access", in: "inheritNative")
        #expect(only.text == "Inherit native · harness settings")
        let help = try #require(only.help)
        #expect(help.contains("the harness's own settings decide; what they confine is unknown here"))
        #expect(!help.contains("no OS file boundary declared"))
        // Beside a route that declares none, the qualifier still makes no claim about it.
        let mixed = try Self.fact("access", in: "inheritNativeMixed")
        #expect(mixed.text.hasSuffix("· OS boundary varies by route"))
    }

    @Test func aRouteThatNeverStartedQualifiesNothing() throws {
        let refused = try Self.fact("access", in: "webOffRefused")
        #expect(refused.text == "Read-only")
        #expect(refused.help?.contains("Prepared only: no native start reported.") == true)
        let running = try Self.fact("access", in: "webOffNoTelemetry")
        #expect(running.text == "Read-only")
        #expect(running.help?.contains("No route recorded what was prepared for it") == true)
    }

    // MARK: Diagnostics

    @Test func diagnosticsCarryTheSameFacts() throws {
        let refused = RunDiagnosticsPresentation.summary(detail: try Self.detail("webOffRefused"), error: nil)
        #expect(refused.contains("# Web Evidence"))
        #expect(refused.contains("verification: none"))
        #expect(refused.contains("scope: tool_calls; network not_measured"))
        #expect(refused.contains("route claude: built-in web tools denied — prepared only, no native start reported"))
        let browser = RunDiagnosticsPresentation.summary(detail: try Self.detail("browserClosedOnly"), error: nil)
        #expect(browser.contains("verification: none"))
        let search = RunDiagnosticsPresentation.summary(detail: try Self.detail("claudeSearch"), error: nil)
        #expect(search.contains("verification: verified\nverified content: search_results"))
        let failed = RunDiagnosticsPresentation.summary(detail: try Self.detail("codexBrowserFailed"), error: nil)
        #expect(failed.contains("Browser handed to it, failed to start: browser launcher exited"))
    }

    /// The placeholder values the API sends with `available: false` are not
    /// observations: Diagnostics keeps the requested mode and requirement and says
    /// the observation is unavailable instead of printing them.
    static let placeholderObservations = [
        "status: none", "attempted: false", "satisfied: false", "verification: none", "scope:",
    ]

    static func expectUnavailable(_ text: String) {
        #expect(text.contains("# Web Evidence\n\nobserved: unavailable\n"
            + RouteControlsPresentation.telemetryUnavailable + "\nmode: off\nrequired: false"))
        for placeholder in placeholderObservations {
            #expect(!text.contains(placeholder), "\(placeholder)")
        }
    }

    @Test func diagnosticsSayMissingWebTelemetryIsUnavailableNotNone() throws {
        Self.expectUnavailable(RunDiagnosticsPresentation.summary(
            detail: try Self.detail("webOffNoTelemetry"), error: nil))
        // Available telemetry keeps every observed value, unavailable or not.
        for scenario in ["webOffReadonly", "webOffRefused", "codexBrowserFailed"] {
            let text = RunDiagnosticsPresentation.summary(detail: try Self.detail(scenario), error: nil)
            #expect(!text.contains("observed: unavailable"), "\(scenario)")
            for observed in Self.placeholderObservations {
                #expect(text.contains(observed), "\(scenario): \(observed)")
            }
            #expect(text.contains("\nroute "), "\(scenario)")
        }
    }

    /// The Diagnostics panel and Copy Diagnostics share `diagnosticText`: check it
    /// where the app sets it, through the real detail hydration (an in-process URL
    /// stub serves the fixture; no socket, daemon or network), and in the copied text.
    @Test func theSharedDiagnosticsPayloadSaysUnavailable() async throws {
        let summary = try Self.wire("webOffNoTelemetry")
        let runId = try #require((try JSONSerialization.jsonObject(with: summary) as? [String: Any])?["runId"] as? String)
        WebAccessDetailStub.body = #"{"summary":"#.data(using: .utf8)! + summary
            + #","lastSeq":0,"artifacts":[]}"#.data(using: .utf8)!
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [WebAccessDetailStub.self]
        let model = AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
            session: URLSession(configuration: config)
        ), requestNotificationAuthorization: false, loadPersistedState: false)
        model.liveTasks = [AppModel.liveTask(from: try Self.summary("webOffNoTelemetry"))]
        await model.loadRunDetail(runId)
        let task = try #require(model.liveTasks.first { $0.id == runId })
        let diagnostics = try #require(task.diagnosticText)
        Self.expectUnavailable(diagnostics)
        let copied = RunEvidenceView.diagnosticsCopyText(task)
        #expect(copied.hasPrefix("run: \(runId)\n"))
        #expect(copied.hasSuffix("\n\n# Diagnostics\n" + diagnostics))
        Self.expectUnavailable(copied)
    }
}

/// Serves one run detail to the hydration test and nothing else (artifacts: 404).
private final class WebAccessDetailStub: URLProtocol {
    nonisolated(unsafe) static var body = Data()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let detail = path.hasPrefix("/v2/runs/") && !path.contains("/artifacts/")
        let response = HTTPURLResponse(
            url: request.url!, statusCode: detail ? 200 : 404, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: detail ? Self.body : Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
