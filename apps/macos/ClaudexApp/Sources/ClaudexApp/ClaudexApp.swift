import SwiftUI

@main
struct ClaudexApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(minWidth: 980, minHeight: 640)
        }
        .windowStyle(.titleBar)
    }
}
