/// What a run's web evidence covers (#118): typed web tool calls and engine
/// Browser calls only. Process network traffic is not measured.
public struct WebObservation: Codable, Sendable, Equatable, Hashable {
    public let evidence: String
    public let network: String
}

/// The selected Browser's startup on a route as its adapter reported it before the
/// first model request (#215): `ready`, `failed`, `cancelled`, `starting` (no outcome
/// by the deadline) or `not_observed`. Nil on the route when it reported none.
public struct BrowserStartupInfo: Codable, Sendable, Equatable, Hashable {
    public let status: String
    public let waitedMs: Int
    /// The vendor's own masked reason for a failed or cancelled startup.
    public let error: String?
}

/// One distinct route of a run: the native web and access controls the engine
/// prepared for its spawns and whether a native session was reported started
/// (#118/#413), as the engine projected them. Claudexor adds no network or file
/// boundary of its own; older engines send none.
public struct RouteControlInfo: Codable, Sendable, Equatable, Hashable {
    public let harnessId: String
    public let webMode: String
    public let webMechanism: String
    /// The Browser was handed to the route: prepared, not a connection.
    public let browser: Bool
    /// What the route reported about that Browser's startup; nil when it reported none.
    public let browserStartup: BrowserStartupInfo?
    public let access: String
    /// The vendor access setting prepared for the route; nil when none or undisclosed.
    public let nativeAccess: String?
    public let accessMechanism: String
    /// True when an adapter reported a native session started under these controls.
    /// Otherwise none was observed, which never proves that no process ran.
    public let nativeSessionStarted: Bool?
    /// The route's applied HOME fact: true for an assigned Claudexor-owned HOME, false when the
    /// engine did not replace HOME, nil when it recorded none (never inferred).
    public let homeScoped: Bool?
}
