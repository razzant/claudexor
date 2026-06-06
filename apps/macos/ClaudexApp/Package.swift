// swift-tools-version:6.0
import PackageDescription

// The SwiftUI mission-control app. Built as a SwiftPM executable for dev/CI
// validation here; a notarized .app bundle is produced in Xcode 26. Liquid Glass
// APIs (macOS 26) are gated with #available so this also type-checks broadly.
let package = Package(
    name: "ClaudexApp",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(path: "../ClaudexKit"),
    ],
    targets: [
        .executableTarget(
            name: "ClaudexApp",
            dependencies: [.product(name: "ClaudexKit", package: "ClaudexKit")]
        ),
    ]
)
