import Foundation

enum ConversationPreviewText {
    /// Supply more than the widest fold can paint, then let TextKit's whole-line
    /// clip choose its visible bottom. This bounds layout, not the collapse rule.
    static func prefix(_ source: String) -> String {
        guard let limit = source.index(source.startIndex, offsetBy: 6_144, limitedBy: source.endIndex),
              limit < source.endIndex else { return source }
        // Finish the word at the budget, including an indivisible first token.
        let boundary = source[limit...].firstIndex(where: { $0.isWhitespace }) ?? source.endIndex
        return String(source[..<boundary])
    }
}
