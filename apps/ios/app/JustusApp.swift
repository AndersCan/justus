import SwiftUI

@main
struct JustusApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  var body: some Scene {
    WindowGroup {
      ContentView(runtime: appDelegate.runtime, lock: appDelegate.lock)
        .onOpenURL { url in appDelegate.runtime.openInvite(url.absoluteString) }
    }
  }
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
  /// Owns the worklet/IPC lifecycle for the app's lifetime; terminated when the
  /// app closes (mirror of `MainActivity.onDestroy`).
  let runtime = BareRuntime()
  /// Covers the web view when the app lock is on and Justus was left for 30 s or more.
  let lock = AppLockController()

  func applicationWillTerminate(_ application: UIApplication) {
    runtime.terminate()
  }
}