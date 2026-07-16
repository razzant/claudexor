import AppKit
import Foundation
import Testing
@testable import ClaudexorApp

/// W3 acceptance: the five-value AccessProfile round-trips losslessly, the
/// composer offers exactly three, and every glyph the UI renders is a REAL SF
/// Symbol (guards the removed "<glyph>.slash" synthesis regression).
@Suite struct AccessProfileTests {
    @Test func roundTripsAllFiveWireValues() {
        for profile in AccessProfile.allCases {
            #expect(AccessProfile(wire: profile.wire) == profile)
        }
        // The two advanced wire values decode even though the composer never offers them.
        #expect(AccessProfile(wire: "external_sandbox_full") == .externalSandboxFull)
        #expect(AccessProfile(wire: "inherit_native") == .inheritNative)
    }

    @Test func unknownWireDecodesNilAndHumanizesVerbatim() {
        #expect(AccessProfile(wire: "made_up") == nil)
        // Unknown values pass through — never silently coerced to Full/Read-only.
        #expect(AccessProfile.humanize("made_up") == "made_up")
        #expect(AccessProfile.humanize("full") == "Full access")
        #expect(AccessProfile.humanize("workspace_write") == "Workspace write")
    }

    @Test func composerOffersExactlyReadonlyWorkspaceFull() {
        #expect(AccessProfile.composerCases == [.readOnly, .workspaceWrite, .full])
        #expect(!AccessProfile.composerCases.contains(.externalSandboxFull))
        #expect(!AccessProfile.composerCases.contains(.inheritNative))
    }

    @Test func harnessAndAccessGlyphsAreValidSFSymbols() {
        var names = AccessProfile.allCases.map(\.glyph)
        names += (HarnessFamily.builtIns + [.fake]).map(\.glyph)
        names.append("cpu") // HarnessFamily's unknown-family fallback glyph.
        for name in names {
            #expect(
                NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil,
                "SF Symbol '\(name)' does not resolve on this deployment target")
        }
    }
}
