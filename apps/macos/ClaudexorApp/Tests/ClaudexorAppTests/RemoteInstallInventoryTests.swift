import Foundation
import Testing
@testable import ClaudexorApp

func installDisclosureFixture(version: String? = nil) -> [String: Any] {
    ["ok": true, "dryRun": true, "harness": "codex", "installationHome": "/fixture/home",
     "target": ["kind": version == nil ? "latest" : "version", "version": version as Any? ?? NSNull()],
     "commands": [["binary": "bash", "args": ["/fixture/installer.sh"], "env": [:],
        "script": ["url": "https://vendor.example/install.sh", "size": 10,
                   "sha256": String(repeating: "a", count: 64)]]]]
}

func remoteInstallTestPrompt(lease: RemoteActionLease, harness: String, command: String = "vendor", version: String? = nil) -> RemoteHarnessInstallPrompt {
    RemoteHarnessInstallPrompt(lease: lease, harness: harness, runtimeTarget: "versions/test",
        commands: [RemoteVendorCommand(binary: command, args: ["install"], env: [:], script: nil)],
        installationHome: "/fixture/home", requestedVersion: version)
}

@Suite struct RemoteInstallInventoryTests {
    @Test func menuUsesEngineCapabilitiesIncludingUnknownVendors() throws {
        let inventory = try JSONDecoder().decode(RemoteInstallInventory.self, from: Data(#"{"harnesses":[{"harness":"future-vendor","actions":{"install":{"available":true,"reason":null}}},{"harness":"unavailable","actions":{"install":{"available":false,"reason":"Not supported here."}}}]}"#.utf8))
        #expect(inventory.harnesses.map(\.harness) == ["future-vendor", "unavailable"])
        #expect(inventory.harnesses[0].actions.install.available)
        #expect(inventory.harnesses[1].actions.install.reason == "Not supported here.")
    }
    @Test func notReadyInstallNamesTheCredentialStepWithoutNativeLogin() {
        #expect(remoteInstallNextStep(harness: "copilot", displayName: "GitHub Copilot") == "Configure its provider credentials.")
        #expect(remoteInstallNextStep(harness: "opencode", displayName: "OpenCode") == "Configure its provider credentials.")
        #expect(remoteInstallNextStep(harness: "claude", displayName: "Claude") == "Use Login → Claude.")
    }
}
