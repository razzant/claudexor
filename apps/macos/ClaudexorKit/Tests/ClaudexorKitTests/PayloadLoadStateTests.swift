import Foundation
import Testing
@testable import ClaudexorKit

/// The D15 no-stale-bytes invariant: a payload slot may only paint a value
/// under the identity it was fetched for. These tests pin the identity-keying
/// so switching runs can never render the previous run's bytes.
@Suite struct PayloadLoadStateTests {
    private func id(_ run: String, _ plane: PayloadPlane = .run, _ path: String? = nil) -> PayloadIdentity {
        PayloadIdentity(runId: run, plane: plane, path: path)
    }

    @Test func freshSlotIsIdle() {
        let slot = PayloadSlot<[String]>()
        #expect(slot.state == .idle)
        #expect(slot.identity == nil)
    }

    @Test func beginMovesToLoadingForNewIdentity() {
        var slot = PayloadSlot<[String]>()
        slot.begin(id("A"))
        #expect(slot.state == .loading)
        #expect(slot.identity == id("A"))
    }

    @Test func commitPaintsWhenIdentityMatches() {
        var slot = PayloadSlot<[String]>()
        slot.begin(id("A"))
        let applied = slot.commit(.loaded(["x"]), for: id("A"))
        #expect(applied)
        #expect(slot.state == .loaded(["x"]))
    }

    @Test func switchingIdentityDropsPreviousValueImmediately() {
        var slot = PayloadSlot<[String]>()
        slot.begin(id("A"))
        slot.commit(.loaded(["a-bytes"]), for: id("A"))
        // Switch to a NEW run: the previous run's bytes must be gone the instant
        // the identity changes — before any new fetch resolves.
        slot.begin(id("B"))
        #expect(slot.state == .loading)
        #expect(slot.state.value == nil)
    }

    @Test func lateResultForSupersededIdentityIsDropped() {
        var slot = PayloadSlot<[String]>()
        slot.begin(id("A"))
        slot.begin(id("B"))
        // A's fetch finally returns AFTER we switched to B — it must not paint.
        let applied = slot.commit(.loaded(["a-bytes"]), for: id("A"))
        #expect(!applied)
        #expect(slot.state == .loading)
        #expect(slot.identity == id("B"))
    }

    @Test func planeIsPartOfIdentity() {
        var slot = PayloadSlot<[String]>()
        slot.begin(id("A", .run))
        slot.commit(.loaded(["run-bytes"]), for: id("A", .run))
        // Same run, DIFFERENT plane (produced) is a distinct identity.
        slot.begin(id("A", .produced))
        #expect(slot.state == .loading)
        let staleApplied = slot.commit(.loaded(["run-bytes"]), for: id("A", .run))
        #expect(!staleApplied)
    }

    @Test func pathIsPartOfIdentity() {
        var slot = PayloadSlot<String>()
        slot.begin(id("A", .run, "one.txt"))
        slot.commit(.loaded("one"), for: id("A", .run, "one.txt"))
        slot.begin(id("A", .run, "two.txt"))
        #expect(slot.state == .loading)
        #expect(slot.state.value == nil)
    }

    @Test func reBeginningSameIdentityKeepsLoadedValue() {
        var slot = PayloadSlot<[String]>()
        slot.begin(id("A"))
        slot.commit(.loaded(["x"]), for: id("A"))
        // A view re-appearing for the same identity must not flash back to loading.
        slot.begin(id("A"))
        #expect(slot.state == .loaded(["x"]))
    }

    @Test func emptyIsASuccessfulLoadNotAFailure() {
        var slot = PayloadSlot<[String]>()
        slot.begin(id("A"))
        slot.commit(.empty, for: id("A"))
        #expect(slot.state == .empty)
        #expect(slot.state.isTerminal)
        #expect(slot.state.value == nil)
    }

    @Test func failedCarriesTypedReason() {
        var slot = PayloadSlot<[String]>()
        slot.begin(id("A"))
        slot.commit(.failed(.offline), for: id("A"))
        #expect(slot.state == .failed(.offline))
        if case .failed(let e) = slot.state { #expect(e.message.contains("offline")) } else { Issue.record("expected failed") }
    }
}
