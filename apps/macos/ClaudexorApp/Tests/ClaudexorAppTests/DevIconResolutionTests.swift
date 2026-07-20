import Foundation
import Testing
@testable import ClaudexorApp

/// v3.0.1 hotfix guard: the dev Dock icon is resolved by plain file path and
/// MUST degrade to nil when the SwiftPM resource bundle is absent or empty.
/// The 3.0.0 regression was `Bundle.module` fatalError-ing at launch for every
/// quarantined (browser-downloaded) install — shipping code may never route
/// this lookup through a Bundle API again.
@Suite struct DevIconResolutionTests {
    private static let bundleName = "ClaudexorApp_ClaudexorApp.bundle"

    private func makeTempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("dev-icon-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @Test func findsIconInFirstBaseWithBundle() throws {
        let base = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: base) }
        let icon = base.appendingPathComponent(Self.bundleName).appendingPathComponent("AppIcon.png")
        try FileManager.default.createDirectory(
            at: icon.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: icon)

        let resolved = AppDelegate.devIconURL(bases: [base])
        #expect(resolved?.standardizedFileURL == icon.standardizedFileURL)
    }

    @Test func fallsBackToLaterBaseWhenFirstIsEmpty() throws {
        let empty = try makeTempDir()
        let populated = try makeTempDir()
        defer {
            try? FileManager.default.removeItem(at: empty)
            try? FileManager.default.removeItem(at: populated)
        }
        let icon = populated.appendingPathComponent(Self.bundleName).appendingPathComponent("AppIcon.png")
        try FileManager.default.createDirectory(
            at: icon.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: icon)

        let resolved = AppDelegate.devIconURL(bases: [nil, empty, populated])
        #expect(resolved?.standardizedFileURL == icon.standardizedFileURL)
    }

    @Test func returnsNilNonfatallyWhenBundleAbsent() throws {
        // The crash class this hotfix exists to kill: no bundle anywhere must
        // mean "no icon", never a trap.
        let base = try makeTempDir()
        defer { try? FileManager.default.removeItem(at: base) }
        #expect(AppDelegate.devIconURL(bases: [nil, base]) == nil)
        #expect(AppDelegate.devIconURL(bases: []) == nil)
    }
}
