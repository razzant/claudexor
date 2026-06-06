// swift-tools-version:6.2
import PackageDescription

// The SwiftUI mission-control app. Built as a SwiftPM executable for dev/CI here
// (`swift run ClaudexApp`); a notarized .app bundle is produced in Xcode 26 for
// distribution. Targets macOS 26 (Tahoe) so the Liquid Glass APIs — `glassEffect`,
// `GlassEffectContainer`, glass button styles, `.backgroundExtensionEffect()` — are
// first-class rather than availability-gated.
let package = Package(
    name: "ClaudexApp",
    platforms: [.macOS(.v26)],
    dependencies: [
        .package(path: "../ClaudexKit"),
    ],
    targets: [
        .executableTarget(
            name: "ClaudexApp",
            dependencies: [.product(name: "ClaudexKit", package: "ClaudexKit")],
            resources: [.process("Resources")],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
    ]
)
