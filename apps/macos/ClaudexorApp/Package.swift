// swift-tools-version:6.2
import PackageDescription

// The SwiftUI mission-control app. Built as a SwiftPM executable for dev/CI here
// (`swift run ClaudexorApp`); `apps/macos/scripts/build-app.sh` assembles locally
// ad-hoc-signed artifacts, or signs with Developer ID and notarizes when configured. Targets
// macOS 26 (Tahoe) so Liquid Glass APIs are first-class rather than availability-gated.
let package = Package(
    name: "ClaudexorApp",
    platforms: [.macOS(.v26)],
    dependencies: [
        .package(path: "../ClaudexorKit"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.15.0"),
    ],
    targets: [
        .executableTarget(
            name: "ClaudexorApp",
            dependencies: [
                .product(name: "ClaudexorKit", package: "ClaudexorKit"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            resources: [.process("Resources")],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
        .testTarget(
            name: "ClaudexorAppTests",
            dependencies: ["ClaudexorApp", .product(name: "ClaudexorKit", package: "ClaudexorKit")],
            resources: [.process("Fixtures")],
            swiftSettings: [
                .swiftLanguageMode(.v6),
            ]
        ),
    ]
)
