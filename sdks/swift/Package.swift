// swift-tools-version: 5.9
// SPDX-License-Identifier: Apache-2.0
import PackageDescription
let package = Package(
    name: "GeoPrefix",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "GeoPrefix", targets: ["GeoPrefix"])],
    targets: [.target(name: "GeoPrefix")]
)
