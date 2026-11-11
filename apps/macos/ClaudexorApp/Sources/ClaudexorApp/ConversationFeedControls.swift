import SwiftUI

enum HistoryControlState { case ready, loading, failed }

struct EarlierTurnsControl: View {
    var hasEarlier: Bool
    var state: HistoryControlState = .ready
    var action: () -> Void

    var body: some View {
        if !hasEarlier {
            Text("Beginning of saved history").font(.caption).foregroundStyle(.secondary)
                .help("There are no earlier saved turns in this conversation.")
                .accessibilityLabel("Beginning of saved history")
        } else {
            VStack(spacing: Theme.Spacing.xs) {
                Button(label, action: action).disabled(state == .loading)
                    .help(help).accessibilityLabel(label)
                if state == .failed {
                    Text("Earlier turns could not be loaded.").font(.caption).foregroundStyle(.secondary)
                }
            }.buttonStyle(.borderless).foregroundStyle(Theme.accent)
        }
    }
    private var label: String {
        switch state {
        case .ready: "Show earlier turns"
        case .loading: "Loading earlier turns…"
        case .failed: "Retry loading earlier turns"
        }
    }
    private var help: String {
        switch state {
        case .ready: "Show earlier turns while keeping the current passage in view. When all mounted turns fit, stay at the top edge."
        case .loading: "Loading the previous turns."
        case .failed: "Earlier turns could not be loaded. Try again."
        }
    }
}

struct LaterTurnsControl: View {
    var state: HistoryControlState = .ready
    var showJump = true
    var newCount: Int? = 0
    var jumpState: HistoryControlState = .ready
    var later: () -> Void
    var latest: () -> Void
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Spacing.lg) { controls }
            VStack(spacing: Theme.Spacing.sm) { controls }
        }
    }
    @ViewBuilder private var controls: some View {
        Button(state == .loading ? "Loading later turns…" : state == .failed ? "Retry loading later turns" : "Show later turns", action: later)
            .buttonStyle(.borderless).foregroundStyle(Theme.accent).disabled(state == .loading)
            .help(state == .loading ? "Loading the following turns." : state == .failed
                  ? "Later turns could not be loaded. Try again." : "Show the following saved turns.")
            .accessibilityLabel(state == .loading ? "Loading later turns" : state == .failed ? "Retry loading later turns" : "Show later turns")
        if showJump { JumpToLatestControl(newCount: newCount, floating: false, state: jumpState, action: latest) }
    }
}

struct JumpToLatestControl: View {
    var newCount: Int? = 0
    var floating = true
    var state: HistoryControlState = .ready
    var action: () -> Void
    static func arrivalLabel(_ count: Int?) -> String {
        guard let count else { return "new" }
        return count > 99 ? "99+" : count > 0 ? "\(count) new" : ""
    }
    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "arrow.down")
                Text(state == .failed ? "Retry jumping to latest" : "Jump to latest")
                Text(state == .loading ? "Loading" : Self.arrivalLabel(newCount))
                    .monospacedDigit().frame(width: 64, alignment: .trailing)
                    .accessibilityHidden(newCount == 0)
            }.font(.callout).fixedSize()
                .padding(.horizontal, floating ? Theme.Spacing.md : 0)
                .padding(.vertical, floating ? Theme.Spacing.sm : 0)
                .background {
                    if floating {
                        Capsule().fill(Theme.surfaceRaised)
                            .overlay(Capsule().strokeBorder(Theme.separator))
                    }
                }
        }.buttonStyle(.plain).disabled(state == .loading)
            .help(state == .loading ? "Loading the newest turns." : "Return to the newest turn and follow new activity.")
            .accessibilityLabel(state == .failed ? "Retry jumping to latest" : "Jump to latest")
            .accessibilityValue(state == .loading ? "Loading" : Self.arrivalLabel(newCount))
    }
}

struct SavedHistoryControl: View {
    var state: HistoryControlState
    var retry: () -> Void
    var body: some View {
        Button(state == .failed ? "Retry loading messages" : "Loading saved history…", action: retry)
            .buttonStyle(.borderless).foregroundStyle(Theme.accent).disabled(state != .failed)
            .help(state == .failed ? "Try loading this conversation again." : "Loading this conversation.")
            .accessibilityLabel(state == .failed ? "Retry loading messages" : "Loading saved history")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Reserve the measured control height plus eight points without re-anchoring
/// the scroll content. A zero-height container explicitly removes the inset.
struct ConversationJumpInset: ViewModifier {
    var isPresented: Bool
    var newCount: Int?
    var state: HistoryControlState = .ready
    var measuredHeight: (CGFloat) -> Void = { _ in }
    var latest: () -> Void

    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if isPresented {
                    JumpToLatestControl(newCount: newCount, state: state, action: latest)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measuredHeight($0) }
                        .padding(.bottom, Theme.Spacing.sm)
                }
            }
            .frame(height: isPresented ? nil : 0)
            .frame(maxWidth: .infinity)
            .background(Rectangle().fill(Theme.surfaceBase))
        }
    }
}
