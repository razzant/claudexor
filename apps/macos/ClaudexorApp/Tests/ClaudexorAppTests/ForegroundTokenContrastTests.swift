import AppKit
import ClaudexorKit
import SwiftUI
import Testing
@testable import ClaudexorApp

/// #545: a colour calibrated as a FILL must not be used as TEXT. The harness
/// fallback (OpenRouter, Copilot, any future id) used `accentSolid`, a fill
/// behind white text, and light `status(.caution)` was the vivid amber fill;
/// both read below 3:1 as labels. These pins keep each foreground token at WCAG
/// AA 4.5:1 on the solid surfaces it is drawn on, and keep the fills as fills.
/// A solid-surface pin says nothing about a capsule on glass, whose colour follows
/// the wallpaper; the measured-glass pins below cover one real frame per consumer.
@MainActor
@Suite struct ForegroundTokenContrastTests {
    private typealias RGB = (r: Double, g: Double, b: Double)
    private let appearances: [NSAppearance.Name] = [.aqua, .darkAqua]
    private let harnessesWithoutOwnHue = [
        HarnessFamily.openrouter.rawValue, HarnessFamily.copilot.rawValue, "future-harness",
    ]

    private func srgb(_ color: Color, _ appearanceName: NSAppearance.Name) -> RGB {
        var out: RGB = (0, 0, 0)
        NSAppearance(named: appearanceName)!.performAsCurrentDrawingAppearance {
            let ns = NSColor(color).usingColorSpace(.sRGB)!
            out = (Double(ns.redComponent), Double(ns.greenComponent), Double(ns.blueComponent))
        }
        return out
    }

    /// The harness palette's documented bar (DESIGN_SYSTEM §2.2): AA against
    /// `surface/raised` in both themes, here also against `surface/base`.
    @Test func harnessWithoutItsOwnHueReadsAsText() {
        for id in harnessesWithoutOwnHue {
            for appearance in appearances {
                let ink = srgb(Theme.harness(id), appearance)
                for surface in [Theme.surfaceRaised, Theme.surfaceBase] {
                    let ratio = contrast(ink, srgb(surface, appearance))
                    #expect(ratio >= 4.5, "\(id) \(appearance.rawValue): \(ratio)")
                }
            }
        }
    }

    /// The same text inside its own chips on the solid surface: each view composites
    /// the harness FILL at this alpha (receipt capsule, account chip, HarnessChip,
    /// FilterChip) over `surfaceRaised`. On glass the chip is lighter or darker with
    /// the wallpaper (see the measured-glass pins); the account chip's text is the
    /// label colour, not this ink.
    @Test func harnessWithoutItsOwnHueReadsInsideItsChips() {
        for id in harnessesWithoutOwnHue {
            for appearance in appearances {
                let ink = srgb(Theme.harness(id), appearance)
                let fill = srgb(Theme.harnessFill(id), appearance)
                let surface = srgb(Theme.surfaceRaised, appearance)
                for alpha in [0.13, 0.14, 0.16, 0.18] {
                    let ratio = contrast(ink, over(fill, alpha, surface))
                    #expect(ratio >= 4.5, "\(id) \(appearance.rawValue) chip \(alpha): \(ratio)")
                }
            }
        }
    }

    /// Without its own hue a harness keeps the solid accent as its fill; with one,
    /// its text and fill stay a single identity colour.
    @Test func harnessFillIsTheSolidAccentOrTheOwnHue() {
        for appearance in appearances {
            for id in harnessesWithoutOwnHue {
                #expect(distance(srgb(Theme.harnessFill(id), appearance),
                                 srgb(Theme.accentSolid, appearance)) < 0.001, "\(id)")
            }
            for family in [HarnessFamily.codex, .claude, .cursor, .opencode, .agy, .raw] {
                #expect(distance(srgb(family.fill, appearance), srgb(family.color, appearance)) < 0.001,
                        "\(family.rawValue)")
            }
        }
    }

    /// The consumer, not only the tokens: a rendered OpenRouter HarnessChip draws
    /// the text colour over a tint of the fill, so re-tinting it with its text
    /// colour cannot pass unnoticed.
    @Test func renderedOpenRouterChipDrawsTextOverTheFillTint() throws {
        let themes: [(NSAppearance.Name, ColorScheme)] = [(.aqua, .light), (.darkAqua, .dark)]
        for (appearance, scheme) in themes {
            let renderer = ImageRenderer(content: HarnessChip(family: .openrouter)
                .padding(4)
                .background(Theme.surfaceRaised)
                .environment(\.colorScheme, scheme))
            renderer.scale = 2
            var image: CGImage?
            NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance { image = renderer.cgImage }
            let bitmap = NSBitmapImageRep(cgImage: try #require(image))
            let ink = srgb(HarnessFamily.openrouter.color, appearance)
            let tint = over(srgb(HarnessFamily.openrouter.fill, appearance), 0.16, srgb(Theme.surfaceRaised, appearance))
            var inkPixels = 0, tintPixels = 0
            for x in 0..<bitmap.pixelsWide {
                for y in 0..<bitmap.pixelsHigh {
                    guard let raw = bitmap.colorAt(x: x, y: y) else { continue }
                    let pixel: RGB = (Double(raw.redComponent), Double(raw.greenComponent), Double(raw.blueComponent))
                    if distance(pixel, ink) < 0.02 { inkPixels += 1 }
                    if distance(pixel, tint) < 0.02 { tintPixels += 1 }
                }
            }
            #expect(inkPixels > 20, "\(appearance.rawValue) text pixels: \(inkPixels)")
            #expect(tintPixels > 200, "\(appearance.rawValue) tint pixels: \(tintPixels)")
        }
    }

    /// `accentSolid` stays the fill under every white label (the Send button and
    /// every `.borderedProminent` tint): white text on it is AA. The root tint
    /// `accent` is not (3.1:1 in Dark Mode), which is why prominent buttons
    /// never inherit it.
    @Test func accentSolidRemainsAFillBehindWhiteText() {
        for appearance in appearances {
            let ratio = contrast((1, 1, 1), srgb(Theme.accentSolid, appearance))
            #expect(ratio >= 4.5, "\(appearance.rawValue): \(ratio)")
        }
    }

    /// Caution text sits on cards, Settings groups, popovers and the window; its
    /// 10–14% chips (Degraded capsule, attention chip, route-proof badge,
    /// account-rotation note) sit on cards (`surfaceRaised`) or the window.
    @Test func cautionInkReadsOnEverySurfaceAndInsideItsOwnChip() {
        let text = [Theme.surfaceRaised, Theme.surfaceRaisedHi, Theme.surfaceBase, Theme.surfaceCode]
        for appearance in appearances {
            let ink = srgb(Theme.status(.caution), appearance)
            for surface in text.map({ srgb($0, appearance) }) {
                #expect(contrast(ink, surface) >= 4.5, "\(appearance.rawValue) on \(surface)")
            }
            for surface in [Theme.surfaceRaised, Theme.surfaceBase].map({ srgb($0, appearance) }) {
                for alpha in [0.10, 0.12, 0.14] {
                    let ratio = contrast(ink, over(ink, alpha, surface))
                    #expect(ratio >= 4.5, "\(appearance.rawValue) chip \(alpha) on \(surface): \(ratio)")
                }
            }
        }
    }

    /// Solid fills keep their colour: every tone's fill is its foreground,
    /// except light caution, whose dots and bars keep the vivid amber.
    @Test func solidFillsStayTheirOwnColour() {
        let tones: [StatusTone] = [.info, .positive, .attention, .negative, .warn, .interrupted]
        for tone in tones {
            for appearance in appearances {
                #expect(distance(srgb(Theme.statusFill(tone), appearance),
                                 srgb(Theme.status(tone), appearance)) < 0.001, "\(tone)")
            }
        }
        let darkFill = srgb(Theme.statusFill(.caution), .darkAqua)
        #expect(distance(darkFill, srgb(Theme.status(.caution), .darkAqua)) < 0.001)
        let lightFill = srgb(Theme.statusFill(.caution), .aqua)
        let lightInk = srgb(Theme.status(.caution), .aqua)
        #expect(luminance(lightFill) > luminance(lightInk) + 0.1)
    }

    // MARK: Rendered consumers on glass (one measured wallpaper)

    /// Backgrounds read off real key-window frames of the app in the QA guest
    /// (macOS 26.4, 1600×1000 @2x, a blue wallpaper behind the glass): the receipt
    /// capsule's fill over the translucent turn card, and the account chip's fill
    /// over the composer glass. Another wallpaper gives other values, so these pin
    /// the two consumers that failed there (#545: the capsule's fallback ink at
    /// 4.2:1 in Dark Mode; the account chip's labels drawn in the root accent at
    /// 3.3:1 dark and 3.8:1 light), not every wallpaper.
    private let measuredGlass: [(NSAppearance.Name, capsule: RGB, chip: RGB)] = [
        (.darkAqua, capsule: (47 / 255, 72 / 255, 99 / 255), chip: (33 / 255, 69 / 255, 71 / 255)),
        (.aqua, capsule: (192 / 255, 222 / 255, 237 / 255), chip: (183 / 255, 223 / 255, 224 / 255)),
    ]

    @Test func fallbackInkReadsOnTheMeasuredReceiptCapsuleGlass() {
        for (appearance, capsule, _) in measuredGlass {
            for id in harnessesWithoutOwnHue {
                let ratio = contrast(srgb(Theme.harness(id), appearance), capsule)
                #expect(ratio >= 4.5, "\(id) \(appearance.rawValue): \(ratio)")
            }
        }
    }

    @Test func accountChipLabelReadsOnTheMeasuredComposerGlass() {
        for (appearance, _, chip) in measuredGlass {
            let (ink, alpha) = srgba(HarnessAccountChip.labelInk, appearance)
            let ratio = contrast(over(ink, alpha, chip), chip)
            #expect(ratio >= 4.5, "\(appearance.rawValue): \(ratio)")
            #expect(distance(ink, srgb(Theme.accent, appearance)) > 0.2, "not the root accent")
        }
    }

    /// A borderless `Menu` draws its label in the tint and ignores
    /// `foregroundStyle`, so each of the account chip's Menus carries the label ink
    /// as its tint; without it the labels fall back to the window's root accent.
    @Test func accountChipMenusTakeTheLabelInkAsTint() throws {
        let appRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: appRoot.appendingPathComponent("Sources/ClaudexorApp/ComposerChips.swift"), encoding: .utf8)
        let chip = try #require(source.components(separatedBy: "struct HarnessAccountChip").dropFirst().first?
            .components(separatedBy: "\nstruct ").first)
        let menus = chip.components(separatedBy: ".menuStyle(.borderlessButton)").count - 1
        let tinted = chip.components(separatedBy: ".menuStyle(.borderlessButton)\n        .tint(Self.labelInk)").count - 1
        #expect(menus == 2)
        #expect(tinted == menus)
    }

    // MARK: Prominent actions: the consumers, not only the token

    /// `accentSolidRemainsAFillBehindWhiteText` pins the token, which cannot notice a
    /// button tinted with another one; the shared Send answer was one (#545).
    @Test func everySystemProminentButtonTakesTheSolidFill() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/ClaudexorApp")
        var prominent = 0
        for case let file as URL in try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
        where file.pathExtension == "swift" {
            let uses = try String(contentsOf: file, encoding: .utf8)
                .components(separatedBy: ".buttonStyle(.borderedProminent)").dropFirst()
            prominent += uses.count
            for rest in uses {
                #expect(rest.drop(while: \.isWhitespace).hasPrefix(".tint(Theme.accentSolid)"), "\(file.lastPathComponent)")
            }
        }
        #expect(prominent > 0)
    }

    /// The real answer card where a question is answered: a run's own turn and a
    /// delegated child's row. An in-memory answer enables Send, and without one the
    /// fill must be gone, which ties the counted pixels to this button. `ImageRenderer`
    /// needs no window, so the key state is set by hand; this says nothing about how a
    /// real window composites the fill. It draws only what SwiftUI itself draws: this
    /// button, but not the question scroll area or other AppKit-backed views. With
    /// `CX_SEND_ANSWER_RENDER_OUT` (an exact-filter QA run, where nothing else in the
    /// process holds a window) the frames are written.
    @Test func sendAnswerDrawsTheSolidFillInBothQuestionContexts() throws {
        let page = try ProducerWire.page()
        let row = try ProducerWire.row(page, "turn-clean")
        var run = try #require(HistoryRunPresentation.task(row, thread: page.header.thread))
        run.phase = .running
        run.waitingOnUser = true
        run.pendingInteractions = [InteractionCardRenderingTests.compact()]
        var child = run
        child.delegatedFromRunId = "run-parent"
        let target = TurnStartTarget.existing(locationID: .local, threadID: row.threadId, repoRoot: nil,
                                              workspaceMode: "in_place", eligibleHarnesses: [])
        let contexts: [(name: String, run: TaskRun, view: AnyView)] = [
            ("ordinary", run, AnyView(TurnCard(turn: row.turnInfo, target: target, routingOptions: TurnOptions(),
                                               executionRoot: nil))),
            ("delegated", child, AnyView(DelegatedRunRow(child: child))),
        ]
        let output = ProcessInfo.processInfo.environment["CX_SEND_ANSWER_RENDER_OUT"]
        if let output {
            try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
        }
        let windows = NSApplication.shared.windows.count
        if output != nil { #expect(windows == 0) }
        for context in contexts {
            for (appearance, scheme) in [(NSAppearance.Name.aqua, ColorScheme.light), (.darkAqua, .dark)] {
                let model = AppModel(client: nil, requestNotificationAuthorization: false, loadPersistedState: false)
                model.liveTasks = [context.run]
                func solidPixels(answer: String?) throws -> Int {
                    let presentation = ConversationPresentation()
                    if let answer {
                        presentation.interactionDrafts[InteractionCardRenderingTests.runID] =
                            [InteractionCardRenderingTests.interactionID: InteractionDraft(freeText: ["q1": answer])]
                    }
                    let renderer = ImageRenderer(content: context.view.padding(12).frame(width: 720)
                        .background(Theme.surfaceBase)
                        .environment(model)
                        .environment(presentation)
                        .environment(\.controlActiveState, .key)
                        .environment(\.colorScheme, scheme)
                        .environment(\.locale, Locale(identifier: "en_US_POSIX")))
                    renderer.scale = 2
                    var rendered: CGImage?
                    NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance { rendered = renderer.cgImage }
                    let image = try #require(rendered)
                    if let output {
                        let file = "\(context.name)-\(scheme == .dark ? "dark" : "light")-\(answer == nil ? "unanswered" : "answered").png"
                        try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?
                            .write(to: URL(fileURLWithPath: output).appendingPathComponent(file))
                    }
                    return try pixels(of: srgb(Theme.accentSolid, appearance), in: image)
                }
                let answered = try solidPixels(answer: "Use SQLite")
                let unanswered = try solidPixels(answer: nil)
                #expect(answered > 5000, "\(context.name) \(appearance.rawValue): \(answered)")
                #expect(unanswered < 500, "\(context.name) \(appearance.rawValue): \(unanswered)")
            }
        }
        #expect(NSApplication.shared.windows.count == windows)
    }

    /// Reads a whole card, so it counts raw sRGB bytes rather than asking for each colour.
    private func pixels(of color: RGB, in image: CGImage) throws -> Int {
        let context = try #require(CGContext(
            data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let bytes = try #require(context.data).assumingMemoryBound(to: UInt8.self)
        var count = 0
        for offset in stride(from: 0, to: image.width * image.height * 4, by: 4) {
            let pixel: RGB = (Double(bytes[offset]) / 255, Double(bytes[offset + 1]) / 255, Double(bytes[offset + 2]) / 255)
            if distance(pixel, color) < 0.02 { count += 1 }
        }
        return count
    }

    // MARK: WCAG helpers (sRGB, gamma-space alpha compositing)

    private func srgba(_ color: Color, _ appearanceName: NSAppearance.Name) -> (RGB, Double) {
        var out: (RGB, Double) = ((0, 0, 0), 1)
        NSAppearance(named: appearanceName)!.performAsCurrentDrawingAppearance {
            let ns = NSColor(color).usingColorSpace(.sRGB)!
            out = ((Double(ns.redComponent), Double(ns.greenComponent), Double(ns.blueComponent)),
                   Double(ns.alphaComponent))
        }
        return out
    }

    private func over(_ top: RGB, _ alpha: Double, _ bottom: RGB) -> RGB {
        (alpha * top.r + (1 - alpha) * bottom.r,
         alpha * top.g + (1 - alpha) * bottom.g,
         alpha * top.b + (1 - alpha) * bottom.b)
    }

    private func distance(_ a: RGB, _ b: RGB) -> Double {
        ((a.r - b.r) * (a.r - b.r) + (a.g - b.g) * (a.g - b.g) + (a.b - b.b) * (a.b - b.b)).squareRoot()
    }

    private func linearize(_ c: Double) -> Double {
        c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }

    private func luminance(_ rgb: RGB) -> Double {
        0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b)
    }

    private func contrast(_ a: RGB, _ b: RGB) -> Double {
        let la = luminance(a), lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }
}
