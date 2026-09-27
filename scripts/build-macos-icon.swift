// Builds src-tauri/icons/icon.icns from the full-bleed artwork.
//
// macOS app icons are drawn on the Big Sur grid: an 824x824 rounded square
// centred on a 1024x1024 transparent canvas, with a soft drop shadow. The
// Windows .ico keeps the full-bleed artwork, so only the .icns is regenerated.
//
// Usage: swift scripts/build-macos-icon.swift [source.png] [output.icns]

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
let sourcePath = args.count > 1 ? args[1] : "src-tauri/icons/black-cat-icon.png"
let outputPath = args.count > 2 ? args[2] : "src-tauri/icons/icon.icns"

// Apple macOS icon grid, expressed as fractions of the canvas.
let tileScale: CGFloat = 824.0 / 1024.0
let cornerRatio: CGFloat = 185.4 / 824.0
// Crop the source edges slightly so its own corners/fringe never show.
let sourceBleed: CGFloat = 0.015
let shadowOffsetY: CGFloat = 10.0 / 1024.0
let shadowBlur: CGFloat = 20.0 / 1024.0
let shadowAlpha: CGFloat = 0.3

guard
  let provider = CGDataProvider(url: URL(fileURLWithPath: sourcePath) as CFURL),
  let imageSource = CGImageSourceCreateWithDataProvider(provider, nil),
  let artwork = CGImageSourceCreateImageAtIndex(imageSource, 0, nil)
else {
  FileHandle.standardError.write("Cannot read \(sourcePath)\n".data(using: .utf8)!)
  exit(1)
}

func renderIcon(size: Int) -> CGImage {
  let canvas = CGFloat(size)
  let context = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  context.interpolationQuality = .high

  let tileSize = canvas * tileScale
  let tile = CGRect(
    x: (canvas - tileSize) / 2, y: (canvas - tileSize) / 2,
    width: tileSize, height: tileSize)
  let radius = tileSize * cornerRatio
  let shape = CGPath(roundedRect: tile, cornerWidth: radius, cornerHeight: radius, transform: nil)

  // Shadow pass: fill the tile shape so the shadow follows the rounded corners.
  context.saveGState()
  context.setShadow(
    offset: CGSize(width: 0, height: -canvas * shadowOffsetY),
    blur: canvas * shadowBlur,
    color: CGColor(gray: 0, alpha: shadowAlpha))
  context.addPath(shape)
  context.setFillColor(CGColor(gray: 0, alpha: 1))
  context.fillPath()
  context.restoreGState()

  // Artwork pass, clipped to the tile.
  context.saveGState()
  context.addPath(shape)
  context.clip()
  context.draw(artwork, in: tile.insetBy(dx: -tileSize * sourceBleed, dy: -tileSize * sourceBleed))
  context.restoreGState()

  return context.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
  let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    FileHandle.standardError.write("Cannot write \(url.path)\n".data(using: .utf8)!)
    exit(1)
  }
}

let fileManager = FileManager.default
let iconset = fileManager.temporaryDirectory
  .appendingPathComponent("blackcat-\(UUID().uuidString).iconset")
try fileManager.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? fileManager.removeItem(at: iconset) }

for base in [16, 32, 128, 256, 512] {
  writePNG(renderIcon(size: base), to: iconset.appendingPathComponent("icon_\(base)x\(base).png"))
  writePNG(renderIcon(size: base * 2), to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", outputPath]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { exit(iconutil.terminationStatus) }
print("Wrote \(outputPath)")
