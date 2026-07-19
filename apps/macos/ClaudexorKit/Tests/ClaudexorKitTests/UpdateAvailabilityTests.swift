import Foundation
import Testing
@testable import ClaudexorKit

/// M5c update-chip shell: the override parser must be HONEST — a real record
/// yields a version, anything malformed yields nothing (never a fake state).
@Suite struct UpdateAvailabilityTests {
    @Test func parsesVersionAndUrl() {
        let json = #"{"version":"3.1.0","url":"https://example/releases/3.1.0"}"#
        let update = UpdateAvailability.parse(Data(json.utf8))
        #expect(update?.version == "3.1.0")
        #expect(update?.url == "https://example/releases/3.1.0")
    }

    @Test func parsesVersionOnly() {
        let update = UpdateAvailability.parse(Data(#"{"version":"3.2.0"}"#.utf8))
        #expect(update?.version == "3.2.0")
        #expect(update?.url == nil)
    }

    @Test func emptyVersionIsNothing() {
        #expect(UpdateAvailability.parse(Data(#"{"version":"  "}"#.utf8)) == nil)
    }

    @Test func garbageIsNothing() {
        #expect(UpdateAvailability.parse(Data("not json".utf8)) == nil)
        #expect(UpdateAvailability.parse(Data(#"{"other":1}"#.utf8)) == nil)
    }

    @Test func missingFileProviderReportsNothing() {
        let provider = FileUpdateAvailabilityProvider(
            path: FileManager.default.temporaryDirectory
                .appendingPathComponent("claudexor-no-such-\(UUID().uuidString).json"))
        #expect(provider.current() == nil)
    }

    @Test func presentFileProviderReportsUpdate() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("claudexor-update-\(UUID().uuidString).json")
        try Data(#"{"version":"9.9.9"}"#.utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let provider = FileUpdateAvailabilityProvider(path: url)
        #expect(provider.current()?.version == "9.9.9")
    }
}
