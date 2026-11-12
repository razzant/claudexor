import ClaudexorKit

extension TaskRun {
    /// #118/#413: the engine-projected web scope and route controls. One mapper
    /// for the list projection and the detail hydration.
    mutating func applyRouteFacts(_ summary: RunSummary) {
        webVerification = summary.webEvidence?.verification
        webVerifiedContent = summary.webEvidence?.verifiedContent
        webObservation = summary.webEvidence?.observation
        routeControls = summary.routeControls ?? []
    }
}

/// #118/#413: the ONE presenter of what was requested, prepared and observed for
/// each route's web and file access, composed by `RunFacts` (web and access
/// facts) and the diagnostics. It renders the engine's `routeControls` only, never
/// a control, boundary or HOME the engine did not record, and never calls a native
/// setting "enforced". A route is prepared before dispatch, so only a reported
/// native session lets a fact speak about what ran.
enum RouteControlsPresentation {
    /// Shown when no telemetry exists for the run yet, or at all.
    static let telemetryUnavailable =
        "Web/tool telemetry unavailable for this run (predates telemetry.yaml, still running, or ended before telemetry)."

    /// What the engine states its web evidence does and does not cover.
    static let webScope = "Evidence counts web tool calls only; network traffic is not measured. "
        + "The vendor API connection stays open, and an allowed shell command can still reach the network."

    private static func started(_ routes: [RouteControlInfo]) -> [RouteControlInfo] {
        routes.filter { $0.nativeSessionStarted == true }
    }

    static func webSwitch(_ route: RouteControlInfo) -> String {
        switch route.webMechanism {
        case "native":
            return route.webMode == "off"
                ? "built-in web search off (native setting)"
                : "built-in web search \(route.webMode) (native setting)"
        case "tools":
            return route.webMode == "off" ? "built-in web tools denied" : "built-in web tools allowed"
        case "uncontrolled": return "no web switch; its own web tools stay as configured"
        case "none": return "no web tools"
        default: return route.webMechanism
        }
    }

    /// #215: the Browser's startup as the route reported it; nothing when it reported
    /// none, since a Browser that was only handed to a route is not a connection.
    static func browserStartup(_ startup: BrowserStartupInfo?) -> String {
        guard let startup else { return "" }
        let waited = String(format: "%.1f s", Double(startup.waitedMs) / 1000)
        let reason = startup.error ?? "no reason given"
        switch startup.status {
        case "ready": return ", ready before the first model request (waited \(waited))"
        case "failed": return ", failed to start: \(reason); the run continued without it"
        case "cancelled": return ", startup cancelled: \(reason); the run continued without it"
        case "starting":
            return ", still starting after \(waited); the first model request may not have offered it"
        case "not_observed":
            return ", no startup status reported; the first model request may not have offered it"
        default: return ", startup \(startup.status)"
        }
    }

    /// #215: the Browser badge of one requested lane: an admission refusal as the
    /// engine resolved it, otherwise what that harness's routes reported about the
    /// Browser's startup. `ready` is Codex's own startup state, never proof that a
    /// page was or could be read, and no state turns the run into a failure.
    static func browserBadge(_ lane: RequestRequirementResolution, _ routes: [RouteControlInfo]) -> String {
        guard lane.effective else { return "\(lane.harnessId): browser unavailable (\(lane.reason))" }
        let handed = routes.filter { $0.harnessId == lane.harnessId && $0.browser }
        return "\(lane.harnessId): " + browserState(handed.map { $0.browserStartup?.status })
    }

    /// The least confirmed of the reported startups: `ready` only when every route
    /// that was handed the Browser reported it; no report at all, or an engine that
    /// sends none, is `prepared`.
    static func browserState(_ statuses: [String?]) -> String {
        if statuses.contains(where: { $0 == "failed" }) { return "browser startup failed" }
        if statuses.contains(where: { $0 == "cancelled" }) { return "browser startup cancelled" }
        if statuses.contains(where: { $0 != nil && $0 != "ready" }) { return "browser startup unconfirmed" }
        if statuses.isEmpty || statuses.contains(where: { $0 == nil }) { return "browser prepared" }
        return "browser ready"
    }

    /// #215: the Browser fact's help: its badge, then what each route that was
    /// handed the Browser reported about its startup (or that it reported none).
    static func browserHelp(_ admission: String, _ routes: [RouteControlInfo]) -> String {
        let startups = routes.filter(\.browser).map {
            "\($0.harnessId): Browser handed to it"
                + ($0.browserStartup == nil ? "; startup not reported" : browserStartup($0.browserStartup))
        }
        return ([admission] + startups.uniqued()).joined(separator: "\n")
    }

    /// One route's web switch; what was only prepared never reads as having run.
    static func webRouteLine(_ route: RouteControlInfo) -> String {
        "\(route.harnessId): \(webSwitch(route))"
            + (route.browser ? "; Browser handed to it" + browserStartup(route.browserStartup) : "")
            + (route.nativeSessionStarted == true ? "" : " — prepared only, no native start reported")
    }

    /// #118: what satisfied web activity returned, from the engine's typed fields only.
    static func retrievalLine(_ task: TaskRun) -> String {
        switch (task.webVerification, task.webVerifiedContent) {
        case ("verified", "page"):
            return "Page retrieved: a typed result shows the loaded page (a WebFetch result, "
                + "or a Browser navigation or snapshot of an http(s) page with no HTTP error)."
        case ("verified", "search_results"):
            return "Search results returned: a web search reported results; that is not a fetched page."
        case ("verified", _):
            return "A typed web result was returned; this record does not say whether it was a page or search results."
        case ("dispatched", _): return "A web call completed, but no typed result shows a page or search results."
        case ("none", _): return "Web tools completed, but no page or search result was recorded."
        default: return "This engine did not report what its web calls retrieved."
        }
    }

    /// #118: "Web tools off" needs a route that started under the off switch;
    /// otherwise only the request is known.
    static func webOffLabel(_ routes: [RouteControlInfo]) -> String {
        let ran = started(routes)
        let off = !ran.isEmpty && ran.allSatisfy { $0.webMode == "off" && $0.webMechanism != "uncontrolled" }
        return off ? "Web tools off" : "Web Off requested"
    }

    static func webHelp(_ task: TaskRun) -> String {
        var lines: [String] = []
        if let policy = task.externalContextPolicy { lines.append("Requested web policy: \(policy).") }
        switch task.webEvidenceStatus {
        case nil: lines.append(task.webEvidenceDetail ?? telemetryUnavailable)
        case "none": lines.append(task.webEvidenceDetail ?? "Observed: no web tool call.")
        case let status?: lines.append(task.webEvidenceDetail ?? "Observed: web \(status).")
        }
        if task.webEvidenceStatus == "satisfied" { lines.append(retrievalLine(task)) }
        let routes = task.routeControls.map(webRouteLine).uniqued()
        if routes.isEmpty {
            lines.append(task.externalContextPolicy == "off"
                ? "No route recorded its native web switch, so nothing here says a web tool was switched off."
                : "No route recorded its native web switch.")
        } else {
            lines.append(contentsOf: routes)
            if !task.routeControls.contains(where: \.browser) { lines.append("Browser: not handed to any route") }
        }
        if task.webObservation != nil { lines.append(webScope) }
        return lines.joined(separator: "\n")
    }

    static func accessMechanism(_ route: RouteControlInfo) -> String {
        switch route.accessMechanism {
        case "fs_sandbox": return "vendor file-system sandbox"
        case "permission_deny": return "vendor permission denial; no OS file boundary declared"
        case "tool_allowlist": return "vendor tool allowlist; no OS file boundary declared"
        case "tool_policy": return "vendor tool permissions; no OS file boundary declared"
        case "native_settings": return "the harness's own settings decide; what they confine is unknown here"
        case "none":
            return route.access == "full"
                ? "no limit requested; no OS file boundary declared"
                : "no access control declared; no OS file boundary declared"
        default: return route.accessMechanism
        }
    }

    /// The compact qualifier beside the access label, from routes that reported a
    /// native session; nil when none did, since then only the request is known.
    static func boundaryQualifier(_ routes: [RouteControlInfo]) -> String? {
        let classes = Set(started(routes).map { route -> String in
            switch route.accessMechanism {
            case "fs_sandbox": return "vendor sandbox"
            case "native_settings": return "harness settings"
            case "permission_deny", "tool_allowlist", "tool_policy", "none": return "no OS file boundary declared"
            default: return route.accessMechanism
            }
        })
        return classes.count > 1 ? "OS boundary varies by route" : classes.first
    }

    static func accessHelp(_ task: TaskRun) -> String {
        let requested = task.requestedAccess.map(AccessProfile.humanize) ?? "unknown"
        var lines = ["Requested \(requested)."]
        if let effective = task.effectiveAccess, effective != task.requestedAccess {
            lines = ["Requested \(requested); the engine resolved \(AccessProfile.humanize(effective))."]
        }
        guard !task.routeControls.isEmpty else {
            lines.append("No route recorded what was prepared for it, so nothing here says which native setting applied.")
            return lines.joined(separator: "\n")
        }
        lines.append("Claudexor adds no OS file boundary of its own. What each route was given:")
        for route in task.routeControls {
            let native = route.nativeAccess.map { "\($0) — " } ?? ""
            let start = route.nativeSessionStarted == true ? "" : " Prepared only: no native start reported."
            let home = route.homeScoped.map {
                $0 ? " HOME: Claudexor-owned." : " HOME: not scoped by Claudexor (inherits the engine's environment)."
            } ?? ""
            lines.append("\(route.harnessId): \(native)\(accessMechanism(route)).\(start)\(home)")
        }
        return lines.uniqued().joined(separator: "\n")
    }
}

private extension Array where Element: Hashable {
    /// First occurrence order; one line per distinct route.
    func uniqued() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}
