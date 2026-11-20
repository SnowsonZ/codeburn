import AppKit
import Foundation

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let iconNames = ["codex", "zcode", "antigravity", "claude", "gemini"]
let canvas = NSRect(x: 0, y: 0, width: 64, height: 64)
var icons: [String: String] = [:]

for name in iconNames {
    let file = directory.appendingPathComponent("provider-\(name).svg")
    guard let source = NSImage(contentsOf: file) else { fatalError("Missing icon: \(name)") }
    let image = NSImage(size: canvas.size, flipped: false) { rect in
        let scale = min(rect.width / source.size.width, rect.height / source.size.height)
        let size = NSSize(width: source.size.width * scale, height: source.size.height * scale)
        let fit = NSRect(x: (rect.width - size.width) / 2, y: (rect.height - size.height) / 2,
                         width: size.width, height: size.height)
        source.draw(in: fit)
        return true
    }
    var rect = canvas
    guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil),
          let png = NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:])
    else { fatalError("Could not render icon: \(name)") }
    icons[name] = png.base64EncodedString()
}

FileHandle.standardOutput.write(try JSONEncoder().encode(icons))
