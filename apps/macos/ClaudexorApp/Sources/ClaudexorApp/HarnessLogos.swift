import SwiftUI

/// Minimal SVG path (`d`) → SwiftUI `Path` parser, enough for the official harness marks
/// we embed (M m L l H h V v C c S s Q q T t Z z and circular A a). Arcs with rx≈ry are
/// rendered exactly; the (unused) rx≠ry case degrades to a line. Output is scaled to fit a
/// target rect from the source viewBox, preserving aspect ratio and centering.
enum SVGPath {
    static func path(_ d: String, viewBox: CGRect, in rect: CGRect) -> Path {
        var path = Path()
        var lex = PathLexer(d)

        var cur = CGPoint.zero
        var start = CGPoint.zero
        var lastCtrl: CGPoint?
        var lastCmd: Character = " "

        func pt(_ x: Double, _ y: Double, rel: Bool) -> CGPoint {
            rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
        }

        while let cmd = lex.nextCommand() {
            let rel = cmd.isLowercase
            let up = Character(cmd.uppercased())
            switch up {
            case "M":
                guard let x = lex.nextNumber(), let y = lex.nextNumber() else { break }
                cur = pt(x, y, rel: rel); start = cur; path.move(to: cur)
                while lex.hasNumber() { // implicit lineto pairs
                    guard let nx = lex.nextNumber(), let ny = lex.nextNumber() else { break }
                    cur = pt(nx, ny, rel: rel); path.addLine(to: cur)
                }
            case "L":
                while lex.hasNumber() {
                    guard let x = lex.nextNumber(), let y = lex.nextNumber() else { break }
                    cur = pt(x, y, rel: rel); path.addLine(to: cur)
                }
            case "H":
                while lex.hasNumber() {
                    guard let x = lex.nextNumber() else { break }
                    cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); path.addLine(to: cur)
                }
            case "V":
                while lex.hasNumber() {
                    guard let y = lex.nextNumber() else { break }
                    cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); path.addLine(to: cur)
                }
            case "C":
                while lex.hasNumber() {
                    guard let x1 = lex.nextNumber(), let y1 = lex.nextNumber(), let x2 = lex.nextNumber(),
                          let y2 = lex.nextNumber(), let x = lex.nextNumber(), let y = lex.nextNumber() else { break }
                    let c1 = pt(x1, y1, rel: rel), c2 = pt(x2, y2, rel: rel), e = pt(x, y, rel: rel)
                    path.addCurve(to: e, control1: c1, control2: c2); lastCtrl = c2; cur = e
                }
            case "S":
                while lex.hasNumber() {
                    guard let x2 = lex.nextNumber(), let y2 = lex.nextNumber(), let x = lex.nextNumber(), let y = lex.nextNumber() else { break }
                    let c1 = (lastCmd == "C" || lastCmd == "S") ? reflect(lastCtrl, about: cur) : cur
                    let c2 = pt(x2, y2, rel: rel), e = pt(x, y, rel: rel)
                    path.addCurve(to: e, control1: c1, control2: c2); lastCtrl = c2; cur = e
                }
            case "Q":
                while lex.hasNumber() {
                    guard let x1 = lex.nextNumber(), let y1 = lex.nextNumber(), let x = lex.nextNumber(), let y = lex.nextNumber() else { break }
                    let c = pt(x1, y1, rel: rel), e = pt(x, y, rel: rel)
                    path.addQuadCurve(to: e, control: c); lastCtrl = c; cur = e
                }
            case "T":
                while lex.hasNumber() {
                    guard let x = lex.nextNumber(), let y = lex.nextNumber() else { break }
                    let c = (lastCmd == "Q" || lastCmd == "T") ? reflect(lastCtrl, about: cur) : cur
                    let e = pt(x, y, rel: rel)
                    path.addQuadCurve(to: e, control: c); lastCtrl = c; cur = e
                }
            case "A":
                while lex.hasNumber() {
                    guard let rx = lex.nextNumber(), let ry = lex.nextNumber(), let _ = lex.nextNumber(),
                          let laf = lex.nextNumber(), let sf = lex.nextNumber(), let x = lex.nextNumber(), let y = lex.nextNumber() else { break }
                    let e = pt(x, y, rel: rel)
                    addArc(&path, from: cur, to: e, rx: rx, ry: ry, largeArc: laf != 0, sweep: sf != 0)
                    cur = e
                }
            case "Z":
                path.closeSubpath(); cur = start
            default:
                break
            }
            lastCmd = up
        }

        let scale = min(rect.width / viewBox.width, rect.height / viewBox.height)
        let tx = rect.midX - viewBox.midX * scale
        let ty = rect.midY - viewBox.midY * scale
        let t = CGAffineTransform(scaleX: scale, y: scale).concatenating(CGAffineTransform(translationX: tx, y: ty))
        return path.applying(t)
    }

    private static func reflect(_ ctrl: CGPoint?, about p: CGPoint) -> CGPoint {
        guard let c = ctrl else { return p }
        return CGPoint(x: 2 * p.x - c.x, y: 2 * p.y - c.y)
    }

    /// Circular arc (rx≈ry). Endpoint → center parameterization, then `addArc`.
    private static func addArc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx: Double, ry: Double, largeArc: Bool, sweep: Bool) {
        let r = max((rx + ry) / 2, 1e-6)
        let mid = CGPoint(x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2)
        let dx = (p1.x - p0.x) / 2, dy = (p1.y - p0.y) / 2
        let dist = (dx * dx + dy * dy).squareRoot()
        guard dist > 1e-9 else { return }
        let rEff = max(r, dist)
        let h = (rEff * rEff - dist * dist).squareRoot()
        // unit normal to the chord
        let nx = -dy / dist, ny = dx / dist
        let sign: Double = (largeArc != sweep) ? 1 : -1
        let center = CGPoint(x: mid.x + sign * h * nx, y: mid.y + sign * h * ny)
        let a0 = atan2(p0.y - center.y, p0.x - center.x)
        let a1 = atan2(p1.y - center.y, p1.x - center.x)
        path.addArc(center: center, radius: rEff, startAngle: .radians(a0), endAngle: .radians(a1), clockwise: !sweep)
    }
}

// MARK: - Lexer

/// A single synchronized cursor over the path string. Commands and numbers share one
/// index, so reading a command's params never desyncs from the command stream.
private struct PathLexer {
    private let chars: [Character]; private var i = 0
    init(_ s: String) { chars = Array(s) }

    private func isSep(_ c: Character) -> Bool { c == " " || c == "," || c == "\n" || c == "\t" || c == "\r" }
    private func isNumStart(_ c: Character) -> Bool { c.isNumber || c == "-" || c == "+" || c == "." }

    private mutating func skipSep() { while i < chars.count, isSep(chars[i]) { i += 1 } }

    /// Next command letter (advances past it). Numbers between commands are read separately.
    mutating func nextCommand() -> Character? {
        while i < chars.count {
            let c = chars[i]
            if isSep(c) { i += 1; continue }
            if c.isLetter { i += 1; return c }
            // a stray number with no command: stop (malformed)
            return nil
        }
        return nil
    }

    /// True if the next non-separator token is a number (does NOT consume; stops at a letter).
    mutating func hasNumber() -> Bool {
        skipSep()
        guard i < chars.count else { return false }
        return isNumStart(chars[i])
    }

    /// Parse the next number (SVG-style: sign/decimal/exponent; a 2nd '.' starts a new number).
    mutating func nextNumber() -> Double? {
        skipSep()
        guard i < chars.count, isNumStart(chars[i]) else { return nil }
        var s = ""
        var seenDot = false
        if chars[i] == "-" || chars[i] == "+" { s.append(chars[i]); i += 1 }
        while i < chars.count {
            let c = chars[i]
            if c.isNumber { s.append(c); i += 1 }
            else if c == "." { if seenDot { break }; seenDot = true; s.append(c); i += 1 }
            else if c == "e" || c == "E" {
                s.append(c); i += 1
                if i < chars.count, chars[i] == "-" || chars[i] == "+" { s.append(chars[i]); i += 1 }
            } else { break }
        }
        return Double(s)
    }
}

// MARK: - Harness icon (ONE owner of vendor iconography, M9-UX item 5)

/// The single mapping from a harness id to its brand mark. Every surface that
/// shows a vendor icon (the harness picker, accounts, composer chips, run/turn
/// identity, readiness) renders through `HarnessIcon` — there are NO scattered
/// per-vendor SF-Symbol/emoji placeholders. Vendors we ship an official mark for
/// (Codex/Claude/Cursor/OpenCode, from simple-icons) render it tinted with the
/// brand color; EVERY unknown/future harness gets ONE shared generic glyph.
enum HarnessIconCatalog {
    /// The single generic glyph for any harness without a bundled brand mark
    /// (raw-api/openrouter meta-hosts and every future harness id).
    static let genericSymbol = "shippingbox.fill"

    static func mark(for harnessId: String) -> HarnessLogoData.Mark? {
        HarnessLogoData.marks[harnessId]
    }
    /// True when the vendor ships a real bundled brand mark (else the generic
    /// glyph is used). Pure — unit-tested so the mapping never silently drifts.
    static func hasBrandMark(_ harnessId: String) -> Bool { mark(for: harnessId) != nil }
}

/// Renders a harness's official brand mark, tinted with the family color (the
/// brand's own color), or the ONE shared generic glyph for any vendor without a
/// bundled mark. The single owner of harness iconography.
struct HarnessIcon: View {
    let family: HarnessFamily
    var size: CGFloat = 16
    /// Render monochrome (menu/label contexts) rather than in the brand color.
    var monochrome = false

    private var tint: Color { monochrome ? .primary : family.color }

    var body: some View {
        if let mark = HarnessIconCatalog.mark(for: family.rawValue) {
            Canvas { ctx, canvasSize in
                let rect = CGRect(origin: .zero, size: canvasSize)
                    .insetBy(dx: canvasSize.width * 0.06, dy: canvasSize.height * 0.06)
                let p = SVGPath.path(mark.path, viewBox: mark.viewBox, in: rect)
                ctx.fill(p, with: .color(tint), style: FillStyle(eoFill: true))
            }
            .frame(width: size, height: size)
            .accessibilityLabel("\(family.label) logo")
        } else {
            Image(systemName: HarnessIconCatalog.genericSymbol)
                .font(.system(size: size * 0.8))
                .foregroundStyle(tint)
                .accessibilityLabel("\(family.label) icon")
        }
    }
}

/// Native NSMenu items and `Label(_:image:)` icons cannot host a live `Canvas`,
/// so the brand marks are rasterized ONCE into template images (auto-tinting to
/// the menu/label foreground) and cached. Vendors without a mark fall back to
/// the shared generic SF Symbol.
@MainActor
enum HarnessIconImage {
    private static var cache: [String: Image] = [:]

    static func image(for family: HarnessFamily, size: CGFloat = 14) -> Image {
        guard HarnessIconCatalog.hasBrandMark(family.rawValue) else {
            return Image(systemName: HarnessIconCatalog.genericSymbol)
        }
        let key = "\(family.rawValue)@\(Int(size))"
        if let cached = cache[key] { return cached }
        let renderer = ImageRenderer(
            content: HarnessIcon(family: family, size: size, monochrome: true)
                .frame(width: size, height: size))
        renderer.scale = 2
        let image: Image
        if let ns = renderer.nsImage {
            ns.isTemplate = true
            image = Image(nsImage: ns)
        } else {
            image = Image(systemName: HarnessIconCatalog.genericSymbol)
        }
        cache[key] = image
        return image
    }
}
