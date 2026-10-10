import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct RuntimeConcurrencySettingsTests {
    private func snapshot(concurrency: String? = nil) throws -> SettingsSnapshot {
        let concurrencyMember = concurrency.map { ",\"concurrency\":\($0)" } ?? ""
        return try JSONDecoder().decode(SettingsSnapshot.self, from: Data("""
        {
          "sources": [],
          "routing": {
            "goal": "auto", "paidFallback": "when_unavailable", "qualityTiers": {},
            "primaryHarness": null, "eligibleHarnesses": [], "envInheritance": "mirror_native"
          },
          "budget": { "paidBudgetPerRun": { "kind": "unlimited" } },
          "runtime": {
            "reviewerTimeoutMs": 600000,
            "transientRetry": { "maxRetries": 2, "initialDelayMs": 1000, "maxDelayMs": 10000 }
            \(concurrencyMember)
          }
        }
        """.utf8))
    }

    @Test func decodesCurrentConcurrencyAndRoundTripsEveryCap() throws {
        let decoded = try snapshot(concurrency: """
        {
          "configured": { "maxConcurrent": 24, "maxParallelCandidates": 12, "maxDeepScanWidth": 32, "maxCouncilMembers": 8 },
          "effective": { "maxConcurrent": 24, "maxParallelCandidates": 12, "maxDeepScanWidth": 32, "maxCouncilMembers": 8 },
          "restartRequired": false
        }
        """)
        let concurrency = try #require(decoded.runtime?.concurrency)
        #expect(concurrency.configured.maxConcurrent == .finite(24))
        #expect(concurrency.configured.maxParallelCandidates == 12)
        #expect(concurrency.configured.maxDeepScanWidth == 32)
        #expect(concurrency.configured.maxCouncilMembers == 8)
        #expect(concurrency.effective == concurrency.configured)
        #expect(!concurrency.restartRequired)
        let roundTrip = try JSONDecoder().decode(SettingsSnapshot.self, from: JSONEncoder().encode(decoded))
        #expect(roundTrip == decoded)
    }

    @Test func oldEngineOmissionStaysAbsentWithoutInventedLimits() throws {
        let decoded = try snapshot()
        #expect(decoded.runtime?.concurrency == nil)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? [String: Any]
        let runtime = try #require(encoded?["runtime"] as? [String: Any])
        #expect(runtime["concurrency"] == nil)
    }

    @Test func keepsPendingConfiguredValuesSeparateFromEffectiveStartupCaps() throws {
        let decoded = try snapshot(concurrency: """
        {
          "configured": { "maxConcurrent": 48, "maxParallelCandidates": 16, "maxDeepScanWidth": 64, "maxCouncilMembers": 12 },
          "effective": { "maxConcurrent": 24, "maxParallelCandidates": 4, "maxDeepScanWidth": 8, "maxCouncilMembers": 4 },
          "restartRequired": true
        }
        """)
        let concurrency = try #require(decoded.runtime?.concurrency)
        #expect(concurrency.configured.maxConcurrent == .finite(48))
        #expect(concurrency.configured.maxParallelCandidates == 16)
        #expect(concurrency.configured.maxDeepScanWidth == 64)
        #expect(concurrency.configured.maxCouncilMembers == 12)
        #expect(concurrency.effective.maxConcurrent == .finite(24))
        #expect(concurrency.effective.maxParallelCandidates == 4)
        #expect(concurrency.effective.maxDeepScanWidth == 8)
        #expect(concurrency.effective.maxCouncilMembers == 4)
        #expect(concurrency.restartRequired)
    }

    @Test func unlimitedKeepsStrategyWidthsAndSourceDistinctFromAbsence() throws {
        let decoded = try snapshot(concurrency: """
        {
          "configured": { "maxConcurrent": "unlimited", "maxConcurrentNonModelJobs": 24, "maxConcurrentModelOperations": "unlimited", "maxParallelCandidates": 4, "maxDeepScanWidth": 8, "maxCouncilMembers": 8, "sources": { "max_concurrent": "config", "max_concurrent_model_operations": "default" } },
          "effective": { "maxConcurrent": 24, "maxParallelCandidates": 4, "maxDeepScanWidth": 8, "maxCouncilMembers": 8 },
          "restartRequired": true
        }
        """)
        let concurrency = try #require(decoded.runtime?.concurrency)
        #expect(concurrency.configured.maxConcurrent == .unlimited)
        #expect(concurrency.configured.maxConcurrentNonModelJobs == .finite(24))
        #expect(concurrency.configured.sources?["max_concurrent"] == .config)
        #expect(concurrency.configured.sources?["max_concurrent_model_operations"] == .default)
        #expect(concurrency.effective.maxConcurrentModelOperations == nil)
        #expect(concurrency.effective.sources == nil)
        #expect(concurrency.configured.maxCouncilMembers == 8)
        #expect(try JSONDecoder().decode(SettingsSnapshot.self, from: JSONEncoder().encode(decoded)) == decoded)
    }

    @Test func invalidCapacityDoesNotBecomeUnlimited() {
        for invalid in ["0", "-1", "1.5", "true", "\"unknown\"", "9007199254740992"] {
            #expect(throws: (any Error).self) {
                try JSONDecoder().decode(ConcurrencyLimit.self, from: Data(invalid.utf8))
            }
        }
    }
}
