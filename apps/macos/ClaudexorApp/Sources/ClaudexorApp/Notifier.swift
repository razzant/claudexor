import Foundation
import UserNotifications

/// Native user notifications for run state changes (run completed / needs review). Guarded
/// so it is a safe no-op in the SwiftPM dev executable (which has no bundle identifier and
/// would otherwise trap in UNUserNotificationCenter); it activates in the notarized .app.
enum Notifier {
    private static var available: Bool { Bundle.main.bundleIdentifier != nil }

    static func requestAuthIfPossible() {
        guard available else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    static func post(title: String, body: String) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }
}
