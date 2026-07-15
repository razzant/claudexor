// swift-tools-version:6.0
import PackageDescription

// ClaudexorKit: the macOS app's client for the Claudexor control-api (loopback HTTP+SSE).
// It is a plain SwiftPM library (no SwiftUI) so it builds/tests with the Swift
// toolchain alone; the SwiftUI app (apps/macos/ClaudexorApp, built in Xcode 26) depends
// on it. The Zod schema in packages/schema remains the cross-language SSOT; the few
// DTOs here are the minimal client contract (SSE envelope + commands), not a mirror.
let package = Package(
    name: "ClaudexorKit",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ClaudexorKit", targets: ["ClaudexorKit"]),
    ],
    targets: [
        .target(name: "ClaudexorKit"),
        .testTarget(
            name: "ClaudexorKitTests",
            dependencies: ["ClaudexorKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
