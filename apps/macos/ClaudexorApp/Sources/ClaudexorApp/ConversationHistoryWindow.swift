/// Keeps eager conversation layout bounded without deleting or truncating history.
///
/// A nil end index follows the newest turns. An explicit exclusive end index
/// anchors an older page while new turns arrive. Only the range is projected;
/// the caller continues to own the complete, unchanged turn collection.
struct ConversationHistoryWindow: Equatable, Sendable {
    let pageSize: Int
    private var endIndex: Int?

    init(pageSize: Int = 20) {
        self.pageSize = max(1, pageSize)
        self.endIndex = nil
    }

    var isFollowingLatest: Bool { endIndex == nil }

    func visibleRange(totalCount: Int) -> Range<Int> {
        let count = max(0, totalCount)
        let end = min(count, max(0, endIndex ?? count))
        return max(0, end - pageSize)..<end
    }

    func canShowOlder(totalCount: Int) -> Bool {
        visibleRange(totalCount: totalCount).lowerBound > 0
    }

    func canShowNewer(totalCount: Int) -> Bool {
        visibleRange(totalCount: totalCount).upperBound < max(0, totalCount)
    }

    mutating func showOlder(totalCount: Int) {
        let start = visibleRange(totalCount: totalCount).lowerBound
        guard start > 0 else { return }
        endIndex = start
    }

    mutating func showNewer(totalCount: Int) {
        let count = max(0, totalCount)
        let end = visibleRange(totalCount: count).upperBound
        // Subtraction avoids overflowing end + pageSize near Int.max.
        guard count - end > pageSize else {
            showLatest()
            return
        }
        endIndex = end + pageSize
    }

    mutating func showLatest() {
        endIndex = nil
    }

    mutating func reset() {
        showLatest()
    }
}
