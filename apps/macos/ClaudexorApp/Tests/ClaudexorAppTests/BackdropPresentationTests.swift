import Testing
@testable import ClaudexorApp

/// M9-UX item 7: the window backdrop switches to an OPAQUE variant whenever the
/// window is not floating over the desktop — native full screen (no desktop
/// behind it) or Reduce Transparency — and stays vibrant only in the windowed,
/// transparency-allowed case. Pure state switch, unit-tested without a window.
@Suite struct BackdropPresentationTests {
    @Test func fullScreenForcesOpaqueBackdrop() {
        #expect(BackdropPresentation.backdrop(isFullScreen: true, reduceTransparency: false) == .opaque)
        #expect(BackdropPresentation.backdrop(isFullScreen: true, reduceTransparency: true) == .opaque)
    }

    @Test func reduceTransparencyForcesOpaqueBackdrop() {
        #expect(BackdropPresentation.backdrop(isFullScreen: false, reduceTransparency: true) == .opaque)
    }

    @Test func windowedTransparentUsesVibrantBackdrop() {
        #expect(BackdropPresentation.backdrop(isFullScreen: false, reduceTransparency: false) == .vibrant)
    }
}
