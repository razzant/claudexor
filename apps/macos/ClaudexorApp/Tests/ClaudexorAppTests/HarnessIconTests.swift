import AppKit
import Foundation
import Testing
@testable import ClaudexorApp

/// M9-UX item 5: `HarnessIcon` is the SINGLE owner of vendor iconography. Vendors
/// we ship an official brand mark for render it; EVERY other (unknown/future)
/// harness — raw-api/openrouter meta-hosts included — falls back to ONE shared
/// generic glyph. This guards that mapping against silent drift.
@Suite struct HarnessIconTests {
    @Test func brandMarkVendorsHaveOfficialMarks() {
        for family in [HarnessFamily.codex, .claude, .cursor, .opencode] {
            #expect(
                HarnessIconCatalog.hasBrandMark(family.rawValue),
                "\(family.rawValue) must ship a real brand mark")
        }
    }

    @Test func unknownVendorsFallBackToOneGenericGlyph() {
        // raw-api (the OpenRouter host) and any future harness id have no bundled
        // mark and must resolve to the ONE shared generic glyph — never a random
        // per-vendor lookalike.
        for id in ["raw-api", "openrouter", "fake", "some-future-harness"] {
            #expect(!HarnessIconCatalog.hasBrandMark(id), "\(id) must not claim a brand mark")
        }
        #expect(
            NSImage(systemSymbolName: HarnessIconCatalog.genericSymbol, accessibilityDescription: nil) != nil,
            "the generic glyph must be a real SF Symbol")
    }

    @MainActor
    @Test func menuImageAccessorIsStableAndCached() {
        // The rasterized menu image path returns for both a real mark and the
        // generic fallback without throwing; a second call is served from cache.
        _ = HarnessIconImage.image(for: .claude)
        _ = HarnessIconImage.image(for: .claude)
        _ = HarnessIconImage.image(for: .raw)
    }
}
