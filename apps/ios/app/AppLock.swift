import Combine
import Darwin
import Foundation
import LocalAuthentication
import SwiftUI
import UIKit

enum LockPrompt {
  case confirmed
  case cancelled
  case failed(String)
}

func deviceSecure() -> Bool {
  LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
}

private let lockPrefKey = "appLock.enabled"

func readLockPref() -> Bool {
  UserDefaults.standard.bool(forKey: lockPrefKey)
}

func writeLockPref(_ enabled: Bool) {
  UserDefaults.standard.set(enabled, forKey: lockPrefKey)
}

func lockOn() -> Bool {
  readLockPref() && deviceSecure()
}

/// Monotonic seconds that keep counting while the phone sleeps (unlike systemUptime).
func monotonicNow() -> TimeInterval {
  Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1e9
}

func showLockPrompt(_ done: @escaping @MainActor (LockPrompt) -> Void) {
  LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Justus") { ok, error in
    let result: LockPrompt
    if ok {
      result = .confirmed
    } else if let code = (error as? LAError)?.code,
      [.userCancel, .appCancel, .systemCancel, .userFallback].contains(code)
    {
      result = .cancelled
    } else {
      result = .failed(error?.localizedDescription ?? "Unlock failed")
    }
    Task { @MainActor in done(result) }
  }
}

@MainActor
final class AppLockController: ObservableObject {
  @Published private(set) var state = AppLockState()
  var promptOpen = false
  private var observers: [NSObjectProtocol] = []

  init() {
    state.launched(enabled: lockOn())
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.state.resigned(enabled: lockOn()) }
      },
      center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.state.left(at: monotonicNow()) }
      },
      center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self else { return }
          if self.state.cameBack(enabled: lockOn(), secure: deviceSecure(), at: monotonicNow()) {
            self.requestOpen()
          }
        }
      },
    ]
  }

  func requestOpen() {
    guard !promptOpen else { return }
    promptOpen = true
    showLockPrompt { [weak self] result in
      self?.promptOpen = false
      if case .confirmed = result { self?.state.confirmed() }
    }
  }
}

struct LockCover: View {
  let onTap: () -> Void
  private let ink = Color(red: 0x1B / 255, green: 0x1B / 255, blue: 0x1F / 255)

  var body: some View {
    VStack(spacing: 24) {
      Image(systemName: "lock.fill").font(.system(size: 48)).foregroundColor(ink)
      Text("Justus is locked").font(.title3).foregroundColor(ink)
      Button("Unlock", action: onTap).buttonStyle(.borderedProminent)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.white)
  }
}
