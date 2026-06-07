// swift-tools-version:6.2
import PackageDescription

// The SwiftUI mission-control app. Built as a SwiftPM executable for dev/CI here
// (`swift run ClaudexApp`); `apps/macos/scripts/build-app.sh` assembles unsigned
// beta artifacts, and can sign/notarize when credentials are available. Targets
// macOS 26 (Tahoe) so Liquid Glass APIs are first-class rather than availability-gated.
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
