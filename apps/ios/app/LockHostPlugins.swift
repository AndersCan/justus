import BareHost
import Foundation

/// justus.lock host handlers: status and the (prompt-guarded) on/off switch.
/// Mirrors MainActivity.kt's registerLockHandlers.
func registerLockHostPlugins(_ registry: HostPluginRegistry, lock: AppLockController) {
  registry.register(pluginId: "justus.lock", event: "lock.status") { _, _, respond in
    Task { @MainActor in
      let secure = deviceSecure()
      respond(.ok(["available": secure, "enabled": secure && readLockPref()]))
    }
  }
  registry.register(
    pluginId: "justus.lock", event: "lock.setEnabled",
    timeout: HostPluginRegistry.userMediatedInvokeTimeout
  ) { args, _, respond in
    Task { @MainActor in
      let old = readLockPref()
      let requested = args?["enabled"] as? Bool
      switch toggleStep(requested: requested, current: old, secure: deviceSecure(), promptOpen: lock.promptOpen) {
      case .fail(let message):
        respond(.fail(code: ErrorCodes.hostError, message: message))
      case .answer(let enabled):
        respond(.ok(["enabled": enabled]))
      case .prompt:
        lock.promptOpen = true
        showLockPrompt { result in
          lock.promptOpen = false
          switch result {
          case .confirmed:
            writeLockPref(requested ?? old)
            respond(.ok(["enabled": requested ?? old]))
          case .cancelled:
            respond(.ok(["enabled": old]))
          case .failed(let message):
            respond(.fail(code: ErrorCodes.hostError, message: message))
          }
        }
      }
    }
  }
}
