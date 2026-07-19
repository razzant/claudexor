import Foundation

// MARK: - Update availability (M5c shell / M7 seam)
//
// An HONEST shell for the future (M7) updater. Until the real updater exists,
// the sidebar footer chip reads a LOCAL override file so the surface can be
// built and dogfooded without fabricating an update state. No file (or an
// unparseable one) means "nothing to show" — never a fake "up to date" or a
// fake pending version. When M7 lands, the same `UpdateAvailability` shape is
// what the updater will report and the chip needs no change.

/// A pending update the footer should advertise. `version` is the target the
/// updater would move to; `url` is an optional release/notes link.
public struct UpdateAvailability: Codable, Sendable, Equatable {
    public let version: String
    public let url: String?

    public init(version: String, url: String? = nil) {
        self.version = version
        self.url = url
    }

    /// Parse the override file's bytes. Returns nil for anything that is not a
    /// well-formed availability record with a non-empty version — an honest
    /// shell never invents a state from garbage.
    public static func parse(_ data: Data) -> UpdateAvailability? {
        guard let decoded = try? JSONDecoder().decode(UpdateAvailability.self, from: data) else {
            return nil
        }
        let version = decoded.version.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !version.isEmpty else { return nil }
        return UpdateAvailability(version: version, url: decoded.url)
    }
}

/// Reads the update-availability override. A protocol so the UI can inject a
/// deterministic provider in tests; the default reads the on-disk override.
public protocol UpdateAvailabilityProviding: Sendable {
    func current() -> UpdateAvailability?
}

/// The default provider: reads `~/.claudexor/v3/update-available.json` if it
/// exists, else reports nothing. Pure file-read; no network, no side effects.
public struct FileUpdateAvailabilityProvider: UpdateAvailabilityProviding {
    private let path: URL

    public init(path: URL? = nil) {
        self.path = path ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claudexor/v3/update-available.json")
    }

    public func current() -> UpdateAvailability? {
        guard let data = try? Data(contentsOf: path) else { return nil }
        return UpdateAvailability.parse(data)
    }
}
