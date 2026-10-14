// swift-tools-version: 6.0
// ViaggiKit: the game's rules and data, with no user interface. The iOS app is
// built on it; the tests check it against results from the web prototype.
import PackageDescription

let package = Package(
    name: "ViaggiKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ViaggiKit", targets: ["ViaggiKit"])],
    targets: [
        .target(name: "ViaggiKit", resources: [.copy("Resources")]),
        .testTarget(name: "ViaggiKitTests", dependencies: ["ViaggiKit"], resources: [.copy("Fixtures")]),
    ],
    swiftLanguageModes: [.v5]
)
