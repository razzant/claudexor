import AppKit
import ClaudexorKit
import SwiftUI
import Testing
@testable import ClaudexorApp

/// Only product leaves in an isolated hosting view. No AppModel, app lifecycle,
/// network, credentials, preferences, provider action or daemon is constructed.
@MainActor @Suite(.serialized)
struct AccountResourcesRenderingTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_RESOURCE_RENDER_QA"] == "1"))
    func nativeResourcesWithTwentyFourAccounts() async throws {
        let application = NSApplication.shared
        let previousPolicy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(previousPolicy) }
        let regularRows = try (0..<24).map(AccountResourcesFixtures.row)
        let quota = try AccountResourcesFixtures.quota()
        let regularSnapshot = try #require(quota.resources?.first)
        let cursorURL = try #require(Bundle.module.url(forResource: "cursor-resources-freshness", withExtension: "json"))
        let cursor = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(contentsOf: cursorURL))
        let cursorSnapshot = try #require(cursor.resources?.first)
        // Separate synthetic absence exercises its coexistence with real producer resources.
        let cursorAbsence = try JSONDecoder().decode(QuotaAbsence.self, from: Data(#"{"subject":{"harness":"cursor","credential_route":"vendor_native","subject_id":"chosen","plan_label":null},"reason":"no_source","detail":null,"observed_at":"2026-10-15T13:04:58.000Z"}"#.utf8))
        let cursorRow = AccountRowModel(id: "cursor-fixture", displayName: "Cursor fixture",
            harnessId: "cursor", family: .cursor, readiness: .ready, verified: true,
            profileId: "chosen", detail: "Verified", quotaGroups: [], enabled: true, nextUp: false, identity: nil)
        let fixture = ResourceAppFixture()
        fixture.handler = { _ in (200, Data(AccountResourcesFixtures.catalog.utf8)) }
        defer { fixture.handler = nil }
        let capabilities = try await fixture.gateway().accountResourceCapabilities()
        let scenarios: [(String, Int?, [AccountResetAttempt])] = [
            ("collapsed-24", nil, []), ("expanded", 0, []),
            ("unconfirmed", 0, [try AccountResourcesFixtures.attempt()]),
            ("applied-readback-failed", 0, [try AccountResourcesFixtures.attempt("reset")]),
            ("disabled", 3, []),
            ("scrolled-bottom-24", nil, []),
            ("full-details", 0, []),
            ("source-details", 0, []),
            ("cursor-collapsed", nil, []),
            ("cursor-full-details", 0, []),
            ("cursor-source-details", 0, []),
        ]
        var files: [String] = []
        var controlEvidence: [[String: Any]] = []
        for (scenario, expanded, attempts) in scenarios {
            let isCursor = scenario.hasPrefix("cursor-")
            let rows = isCursor ? [cursorRow] : regularRows
            let snapshot = isCursor ? cursorSnapshot : regularSnapshot
            for (name, appearance, scheme) in [("light", NSAppearance.Name.aqua, ColorScheme.light),
                                                ("dark", .darkAqua, .dark)] {
                let height: CGFloat = scenario == "cursor-full-details" ? 1200 : scenario == "full-details" ? 820 : 700
                var refreshInvocations = 0
                var rootEnabled: Bool?
                var controlActiveState: String?
                let content = Group {
                    if scenario.hasSuffix("source-details") {
                        VStack {
                            AccountResourceSourceDetails(groups: rows[0].quotaGroups, snapshot: snapshot,
                                absences: isCursor ? [cursorAbsence] : [], expanded: true)
                            Spacer(minLength: 0)
                        }.padding(Theme.Spacing.lg).frame(width: 400, height: height)
                            .background(Color(nsColor: .windowBackgroundColor))
                    } else if scenario.hasSuffix("full-details") {
                        VStack {
                            AccountResourceDetails(row: rows[0], snapshot: snapshot, capabilities: capabilities,
                                absences: isCursor ? [cursorAbsence] : [],
                                refresh: { refreshInvocations += 1 }, recover: { _ in }, reset: { _, _ in })
                                .frame(width: 400 - 2 * Theme.Spacing.lg)
                            Spacer(minLength: 0)
                        }.padding(Theme.Spacing.lg).frame(width: 400, height: height)
                            .background(Color(nsColor: .windowBackgroundColor))
                    } else {
                        ResourceFixtureSurface(rows: rows, snapshot: snapshot,
                            capabilities: capabilities, expanded: expanded, attempts: attempts,
                            scrollToBottom: scenario == "scrolled-bottom-24")
                    }
                }
                let host = NSHostingView(rootView: content
                    .background(ResourceControlEnvironmentProbe { enabled, state in
                        rootEnabled = enabled
                        controlActiveState = state
                    })
                    .environment(\.colorScheme, scheme)
                    .environment(\.locale, Locale(identifier: "en_US_POSIX")))
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: height),
                    styleMask: [.borderless], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = host
                host.frame = NSRect(x: 0, y: 0, width: 400, height: height)
                host.appearance = NSAppearance(named: appearance)
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(150))
                host.displayIfNeeded()
                let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let png = try #require(bitmap.representation(using: .png, properties: [:]))
                let filename = "\(scenario)-\(name).png"
                if let root = ProcessInfo.processInfo.environment["CX_RESOURCE_RENDER_OUTPUT"] {
                    let directory = URL(fileURLWithPath: root, isDirectory: true)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try png.write(to: directory.appendingPathComponent(filename))
                }
                files.append(filename)
                #expect(host.frame.width == 400 && host.frame.height == height)
                #expect(!window.isVisible && !window.isKeyWindow)
                #expect(rootEnabled == true)
                if scenario.hasSuffix("full-details") {
                    let nodes = accessibilityNodes(host)
                    // Unshown SwiftUI hosts omit button AX actions. Record the
                    // actual environment/window evidence; do not claim a click.
                    controlEvidence.append(["file": filename, "root_environment_enabled": rootEnabled == true,
                        "swiftui_control_active_state": controlActiveState ?? "not observed",
                        "refresh_capability": capabilities.refresh, "in_flight_actions": 0,
                        "fixture_refresh_callback_count": refreshInvocations, "window_key": window.isKeyWindow,
                        "window_shown": window.isVisible, "application_active": application.isActive,
                        "native_progress_enabled": nodes.filter { $0.accessibilityRole() == .progressIndicator }.map { $0.isAccessibilityEnabled() },
                        "quota_freshness": rows[0].quotaGroups.flatMap(\.windows).map(\.freshness)])
                }
                window.close()
            }
        }
        if let root = ProcessInfo.processInfo.environment["CX_RESOURCE_RENDER_OUTPUT"] {
            let manifest: [String: Any] = ["files": files, "account_count": 24, "width_points": 400,
                "height_points": 700, "full_details_height_points": 820,
                "cursor_account_count": 1, "cursor_full_details_height_points": 1200,
                "capture": "NSHostingView.cacheDisplay", "app_model": false,
                "window_shown": false, "provider_actions": false, "control_evidence": controlEvidence]
            try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
                .write(to: URL(fileURLWithPath: root).appendingPathComponent("manifest.json"))
        }
    }

    private func accessibilityNodes(_ root: NSView) -> [any NSAccessibilityProtocol] {
        var pending: [Any] = [root]
        if let window = root.window { pending.append(window) }
        var seen: Set<ObjectIdentifier> = []
        var result: [any NSAccessibilityProtocol] = []
        while let next = pending.popLast() {
            guard seen.insert(ObjectIdentifier(next as AnyObject)).inserted else { continue }
            if let view = next as? NSView { pending.append(contentsOf: view.subviews) }
            guard let node = next as? any NSAccessibilityProtocol else { continue }
            result.append(node)
            pending.append(contentsOf: node.accessibilityChildren() ?? [])
            pending.append(contentsOf: NSAccessibility.unignoredChildren(from: node.accessibilityChildren() ?? []))
        }
        return result
    }

}

private struct ResourceControlEnvironmentProbe: View {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.controlActiveState) private var activeState
    let report: (Bool, String) -> Void
    var body: some View {
        Color.clear.onAppear { report(enabled, String(describing: activeState)) }
    }
}

private struct ResourceFixtureSurface: View {
    let rows: [AccountRowModel]
    let snapshot: AccountResourceSnapshot
    let capabilities: AccountResourceCapabilities
    let expanded: Int?
    let attempts: [AccountResetAttempt]
    let scrollToBottom: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Accounts").font(.headline)
                Spacer()
                Image(systemName: "gauge.with.dots.needle.67percent")
                Image(systemName: "arrow.clockwise")
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.top, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.md)
            Divider().opacity(0.55)
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: true) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                        AlignedList {
                            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                                AccountRowView(row: row, login: {}, setEnabled: { _ in }, delete: {},
                                    resourceSummary: AccountResourcePresentation.summary(snapshot, attempts: index == expanded ? attempts : []),
                                    resourceStatus: index == expanded ? attempts.last.map {
                                        $0.unconfirmed ? "Reset result unconfirmed" : "Reset applied · usage not updated"
                                    } : nil,
                                    expanded: index == expanded, toggleResources: {})
                                if index == expanded {
                                    GridRow {
                                        AccountResourceDetails(row: row, snapshot: snapshot, capabilities: capabilities,
                                            attempts: attempts, refresh: {}, recover: { _ in }, reset: { _, _ in })
                                        .frame(width: 400 - 2 * Theme.Spacing.lg, alignment: .leading)
                                        .gridCellColumns(4).gridCellUnsizedAxes(.horizontal)
                                        .padding(.bottom, Theme.Spacing.sm)
                                    }
                                }
                            }
                        }
                        Divider()
                        Text("Add another account").font(.subheadline.weight(.semibold))
                        Text("Auto-switch accounts at quota limit").font(.callout)
                    }
                    .padding(Theme.Spacing.lg)
                    .id("fixture-content")
                }.scrollIndicators(.visible)
                .task {
                    // Explicit bottom-only fixture. Product never forces a
                    // first-row scroll that would bypass its top padding.
                    if scrollToBottom { proxy.scrollTo("fixture-content", anchor: .bottom) }
                }
            }
        }
        .frame(width: 400, height: 700)
        .background(Color(nsColor: .windowBackgroundColor))
        .textSelection(.enabled)
    }
}
