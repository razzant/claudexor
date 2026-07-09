// swift-tools-version:6.2
import PackageDescription

// The SwiftUI mission-control app. Built as a SwiftPM executable for dev/CI here
// (`swift run ClaudexorApp`); `apps/macos/scripts/build-app.sh` assembles unsigned
// unsigned artifacts, and can sign/notarize when credentials are available. Targets
// macOS 26 (Tahoe) so Liquid Glass APIs are first-class rather than availability-gated.
let package = Package(
    name: "ClaudexorApp",
    platforms: [.macOS(.v26)],
    dependencies: [
        .package(path: "../ClaudexorKit"),
    ],
    targets: [
        .executableTarget(
            name: "ClaudexorApp",
            dependencies: [.product(name: "ClaudexorKit", package: "ClaudexorKit")],
            resources: [.process("Resources")],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
    ]
)
