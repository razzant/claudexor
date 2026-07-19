import Foundation
import ClaudexorKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - Runtime release transport (M7)
//
// The network SEAM for the engine-runtime updater. Abstracted behind a protocol
// so the whole check/download flow is exercised offline with an in-memory stub
// (no live GitHub in tests). The production impl wraps URLSession, injectable
// exactly like GatewayClient's session.

/// Result of a latest-release fetch. `status` is the HTTP status (304 = "not
/// modified", the ETag cache hit); `etag` is the response `Etag` (nil when the
/// server sent none); `data` is the release JSON body (nil on 304).
public struct ReleaseFetchResult: Sendable, Equatable {
    public let status: Int
    public let etag: String?
    public let data: Data?

    public init(status: Int, etag: String?, data: Data?) {
        self.status = status
        self.etag = etag
        self.data = data
    }
}

/// The two side-effectful ports the updater needs from the network: fetch the
/// latest-release JSON (ETag-conditional) and download an asset by URL.
public protocol RuntimeReleaseTransport: Sendable {
    /// GET the latest-release metadata. When `etag` is non-nil it is sent as
    /// `If-None-Match`; a 304 response means "unchanged" (no body).
    func fetchLatestRelease(etag: String?) async throws -> ReleaseFetchResult
    /// Download a release asset's raw bytes.
    func downloadAsset(from url: URL) async throws -> Data
}

/// One asset of a GitHub release (`assets[]`), decoded leniently — GitHub sends
/// many more fields than we read, so only `name` + `browser_download_url` are
/// required and everything else is ignored.
public struct GitHubReleaseAsset: Decodable, Sendable, Equatable {
    public let name: String
    public let browserDownloadURL: String

    private enum CodingKeys: String, CodingKey {
        case name
        case browserDownloadURL = "browser_download_url"
    }
}

/// The subset of the GitHub latest-release document the updater reads.
public struct GitHubRelease: Decodable, Sendable, Equatable {
    public let assets: [GitHubReleaseAsset]

    /// Find an asset by exact name (e.g. "runtime-manifest.json").
    public func asset(named name: String) -> GitHubReleaseAsset? {
        assets.first { $0.name == name }
    }

    /// Parse the release JSON. Nil for malformed bytes.
    public static func parse(_ data: Data) -> GitHubRelease? {
        try? JSONDecoder().decode(GitHubRelease.self, from: data)
    }
}

/// Production transport against `api.github.com/repos/razzant/claudexor`. Uses
/// an injectable URLSession so tests can drive it through a URLProtocol stub,
/// or replace the whole transport with an in-memory one.
public struct GitHubRuntimeReleaseTransport: RuntimeReleaseTransport {
    public static let repoSlug = "razzant/claudexor"
    private let latestReleaseURL: URL
    private let session: URLSession

    public init(session: URLSession = .shared,
                latestReleaseURL: URL = URL(string: "https://api.github.com/repos/razzant/claudexor/releases/latest")!) {
        self.session = session
        self.latestReleaseURL = latestReleaseURL
    }

    public func fetchLatestRelease(etag: String?) async throws -> ReleaseFetchResult {
        var req = URLRequest(url: latestReleaseURL)
        req.httpMethod = "GET"
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("claudexor-macos", forHTTPHeaderField: "User-Agent")
        if let etag, !etag.isEmpty {
            req.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw RuntimeUpdateError.transport("latest-release fetch returned no HTTP response")
        }
        // `Etag` header spelling varies; HTTPURLResponse header lookup is
        // case-insensitive on Darwin, but read it defensively.
        let responseETag = (http.value(forHTTPHeaderField: "Etag")
            ?? http.value(forHTTPHeaderField: "ETag"))
        if http.statusCode == 304 {
            return ReleaseFetchResult(status: 304, etag: responseETag ?? etag, data: nil)
        }
        guard http.statusCode == 200 else {
            throw RuntimeUpdateError.transport("latest-release fetch failed (HTTP \(http.statusCode))")
        }
        return ReleaseFetchResult(status: 200, etag: responseETag, data: data)
    }

    public func downloadAsset(from url: URL) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        req.setValue("claudexor-macos", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw RuntimeUpdateError.transport("asset download returned no HTTP response")
        }
        guard http.statusCode == 200 else {
            throw RuntimeUpdateError.transport("asset download failed (HTTP \(http.statusCode))")
        }
        return data
    }
}
