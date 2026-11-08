import Foundation

/// Leaving Justus for this long locks it (mirrors Android LOCK_AFTER_MS).
let lockAfterSeconds: TimeInterval = 30

/// leftAt: monotonic seconds when Justus went to the background; nil = cold start.
func lockDue(enabled: Bool, leftAt: TimeInterval?, now: TimeInterval, limit: TimeInterval = lockAfterSeconds) -> Bool {
  guard enabled else { return false }
  guard let leftAt else { return true }
  return now < leftAt || now - leftAt >= limit
}

/// What the host shows: the cover is up while locked or while Justus is not active.
struct AppLockState: Equatable {
  var locked = false
  var covered = false
  var leftAt: TimeInterval? = nil
  var promptShown = false

  var hidden: Bool { locked || covered }

  /// App start: locks when the lock is on.
  mutating func launched(enabled: Bool) {
    locked = lockDue(enabled: enabled, leftAt: nil, now: 0)
    promptShown = false
  }

  /// Justus stopped being active (app switcher, Control Center, a system prompt).
  mutating func resigned(enabled: Bool) {
    covered = enabled
  }

  /// Justus went to the background.
  mutating func left(at now: TimeInterval) {
    leftAt = now
  }

  /// Justus is active again. Returns true when the prompt should open by itself.
  mutating func cameBack(enabled: Bool, secure: Bool, at now: TimeInterval) -> Bool {
    covered = false
    if locked && !secure {
      locked = false
    } else if !locked, let leftAt, lockDue(enabled: enabled, leftAt: leftAt, now: now) {
      locked = true
      promptShown = false
    }
    leftAt = nil
    if locked && !promptShown {
      promptShown = true
      return true
    }
    return false
  }

  /// The person confirmed with Face ID, Touch ID or the passcode.
  mutating func confirmed() {
    locked = false
  }
}

enum ToggleStep: Equatable {
  case fail(String)
  case answer(enabled: Bool)
  case prompt
}

/// Mirrors MainActivity.kt lock.setEnabled in the same order.
func toggleStep(requested: Bool?, current: Bool, secure: Bool, promptOpen: Bool) -> ToggleStep {
  guard let requested else { return .fail("Missing enabled") }
  if !secure { return .fail("No screen lock set") }
  if requested == current { return .answer(enabled: current) }
  if promptOpen { return .fail("Unlock already in progress") }
  return .prompt
}
