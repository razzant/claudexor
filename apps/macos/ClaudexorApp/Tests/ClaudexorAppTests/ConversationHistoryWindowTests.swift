import Testing
@testable import ClaudexorApp

struct ConversationHistoryWindowTests {
    @Test func latestWindowIsBoundedForEmptySmallAndLargeHistories() {
        let window = ConversationHistoryWindow()
        #expect(window.pageSize == 20)
        #expect(window.isFollowingLatest)
        #expect(window.visibleRange(totalCount: 0) == 0..<0)
        #expect(window.visibleRange(totalCount: 1) == 0..<1)
        #expect(window.visibleRange(totalCount: 20) == 0..<20)
        #expect(window.visibleRange(totalCount: 21) == 1..<21)
        #expect(window.visibleRange(totalCount: 55) == 35..<55)
        #expect(!window.canShowOlder(totalCount: 20))
        #expect(window.canShowOlder(totalCount: 21))
        #expect(!window.canShowNewer(totalCount: 55))
    }

    @Test func olderPagesCoverHistoryWithoutGrowingTheMountedWindow() {
        var window = ConversationHistoryWindow()
        let latest = window.visibleRange(totalCount: 55)
        window.showOlder(totalCount: 55)
        let middle = window.visibleRange(totalCount: 55)
        window.showOlder(totalCount: 55)
        let oldest = window.visibleRange(totalCount: 55)

        #expect(latest == 35..<55)
        #expect(middle == 15..<35)
        #expect(oldest == 0..<15)
        #expect(Array(oldest) + Array(middle) + Array(latest) == Array(0..<55))
        #expect(!window.canShowOlder(totalCount: 55))
        window.showOlder(totalCount: 55)
        #expect(window.visibleRange(totalCount: 55) == oldest)
        #expect(!window.isFollowingLatest)
    }

    @Test func newerPagesReturnToFollowingLatest() {
        var window = ConversationHistoryWindow()
        window.showOlder(totalCount: 55)
        window.showOlder(totalCount: 55)
        #expect(window.canShowNewer(totalCount: 55))

        window.showNewer(totalCount: 55)
        #expect(window.visibleRange(totalCount: 55) == 15..<35)
        #expect(!window.isFollowingLatest)
        window.showNewer(totalCount: 55)
        #expect(window.visibleRange(totalCount: 55) == 35..<55)
        #expect(window.isFollowingLatest)
        #expect(!window.canShowNewer(totalCount: 55))
        window.showNewer(totalCount: 55)
        #expect(window.visibleRange(totalCount: 55) == 35..<55)
    }

    @Test func singleOverflowTurnRemainsReachable() {
        var window = ConversationHistoryWindow()
        window.showOlder(totalCount: 21)
        #expect(window.visibleRange(totalCount: 21) == 0..<1)
        #expect(!window.canShowOlder(totalCount: 21))
        window.showNewer(totalCount: 21)
        #expect(window.visibleRange(totalCount: 21) == 1..<21)
        #expect(window.isFollowingLatest)
    }

    @Test func readingAnOlderPageDoesNotJumpWhenNewTurnsArrive() {
        var window = ConversationHistoryWindow()
        window.showOlder(totalCount: 55)
        #expect(window.visibleRange(totalCount: 55) == 15..<35)
        #expect(window.visibleRange(totalCount: 56) == 15..<35)
        #expect(window.visibleRange(totalCount: 100) == 15..<35)
        #expect(window.canShowNewer(totalCount: 100))
        #expect(!window.isFollowingLatest)

        window.showLatest()
        #expect(window.visibleRange(totalCount: 100) == 80..<100)
        #expect(window.visibleRange(totalCount: 101) == 81..<101)
        #expect(window.isFollowingLatest)
    }

    @Test func shrinkingHistoryClampsIndicesAndNavigation() {
        var window = ConversationHistoryWindow()
        window.showOlder(totalCount: 55)
        #expect(window.visibleRange(totalCount: 25) == 5..<25)
        #expect(!window.canShowNewer(totalCount: 25))
        #expect(window.visibleRange(totalCount: 1) == 0..<1)
        #expect(window.visibleRange(totalCount: 0) == 0..<0)
        #expect(!window.canShowOlder(totalCount: 0))
        #expect(!window.canShowNewer(totalCount: 0))

        window.showOlder(totalCount: 25)
        #expect(window.visibleRange(totalCount: 25) == 0..<5)
        window.showNewer(totalCount: 25)
        #expect(window.visibleRange(totalCount: 25) == 5..<25)
        #expect(window.isFollowingLatest)
    }

    @Test func resetReturnsAReusedWindowToLatestHistory() {
        var window = ConversationHistoryWindow()
        window.showOlder(totalCount: 55)
        window.reset()
        #expect(window.isFollowingLatest)
        #expect(window.visibleRange(totalCount: 21) == 1..<21)
    }

    @Test func invalidCountsAndPageSizesCannotProduceInvalidRanges() {
        var window = ConversationHistoryWindow(pageSize: 0)
        #expect(window.pageSize == 1)
        #expect(window.visibleRange(totalCount: -1) == 0..<0)
        window.showOlder(totalCount: -1)
        window.showNewer(totalCount: -1)
        #expect(window.visibleRange(totalCount: -1) == 0..<0)
        #expect(window.visibleRange(totalCount: 21) == 20..<21)
    }
}
