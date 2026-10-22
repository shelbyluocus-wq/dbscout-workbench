// A dedicated monochrome menu-bar glyph. Run: swift scripts/build-macos-tray-icon.swift
// 36 pixels supplies a crisp 18-point icon on Retina displays.
import AppKit
import ImageIO
import UniformTypeIdentifiers

let size = 36
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
    bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.scaleBy(x: 2, y: 2)
context.setFillColor(CGColor(gray: 0, alpha: 1))
let head = CGMutablePath()
head.move(to: CGPoint(x: 2, y: 15.5))
head.addQuadCurve(to: CGPoint(x: 6, y: 12.5), control: CGPoint(x: 3, y: 16))
head.addQuadCurve(to: CGPoint(x: 12, y: 12.5), control: CGPoint(x: 9, y: 14))
head.addQuadCurve(to: CGPoint(x: 16, y: 15.5), control: CGPoint(x: 15, y: 16))
head.addLine(to: CGPoint(x: 15.5, y: 8))
head.addCurve(to: CGPoint(x: 9, y: 2), control1: CGPoint(x: 17, y: 4), control2: CGPoint(x: 13, y: 2))
head.addCurve(to: CGPoint(x: 2.5, y: 8), control1: CGPoint(x: 5, y: 2), control2: CGPoint(x: 1, y: 4))
head.closeSubpath()
context.addPath(head)
context.fillPath()
// Transparent eyes remain legible when macOS reverses the template colour.
context.setBlendMode(.clear)
for x: CGFloat in [4.5, 10.5] {
    context.fillEllipse(in: CGRect(x: x, y: 7, width: 3, height: 1.8))
}
let output = URL(fileURLWithPath: "src-tauri/icons/tray-template.png")
let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
print(output.path)
