import BareHost
import BareKit
import UIKit
import WebKit

/// Owns the full Justus host lifecycle: the Bare worklet, the IPC channel, the
/// host plugin registry and the loopback page load. Mirror of the ekrooh
/// reference (`examples/ios-app/app/BareRuntime.swift`) and `MainActivity.kt`.
final class BareRuntime {
  private var worklet: Worklet?
  private var ipc: IPC?
  private var coordinator: HostIpcCoordinator?
  private var handoffTask: Task<Void, Never>?
  private var attached = false
  private weak var webView: WKWebView?
  private var pendingInvite: String?
  private var pageLoaded = false
  private var terminated = false
  private let handoffURL: URL
  private var navigationDelegate: BareNavigationDelegate?

  // Debug builds get a much longer handoff window so slow cold simulator boots
  // (worklet bundle + worklet boot) don't make the WebView give up before
  // handoff.json appears (release keeps 15s, matching the Android host).
  #if DEBUG
  private let handoffTimeout: TimeInterval = 90
  #else
  private let handoffTimeout: TimeInterval = 15
  #endif

  init() {
    let documents =
      FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    var storageDir = documents.appendingPathComponent("bare", isDirectory: true)
    try? FileManager.default.createDirectory(
      at: storageDir, withIntermediateDirectories: true
    )
    self.handoffURL = storageDir.appendingPathComponent("handoff.json")

    // The storage dir holds handoff.json (a bootstrap nonce) and the p2p
    // corestore (Folder keys, photos); keep it out of iCloud/iTunes backups.
    // A backed-up credential can leave the device, so refuse to start the
    // worklet rather than degrade silently.
    var backupValues = URLResourceValues()
    backupValues.isExcludedFromBackup = true
    do {
      try storageDir.setResourceValues(backupValues)
    } catch {
      BareHostLogger.log("Failed to exclude storage directory from backups")
      return
    }
    // Ephemeral cache dir: kept outside the durable storage dir so the worklet
    // can treat it as disposable (asset cache, photo spool, temp).
    let bareCacheDir = documents.appendingPathComponent("bare-cache", isDirectory: true)
    try? FileManager.default.createDirectory(
      at: bareCacheDir, withIntermediateDirectories: true
    )
    // A previous run may have left a handoff file pointing at a dead ephemeral
    // port; remove it so polling never loads a stale origin.
    try? FileManager.default.removeItem(at: handoffURL)

    // The web app ships in the app bundle (Resources/WebAssets) and is served
    // by the worklet's loopback server; the storage dir holds the origin/bootstrap
    // handoff file.
    guard
      let webAssetsURL = Bundle.main.url(
        forResource: "WebAssets", withExtension: nil
      )
    else {
      fatalError("Missing WebAssets in app bundle — run `node apps/ios/scripts/build-ios.mjs` first.")
    }

    let configuration = Worklet.Configuration(
      memoryLimit: 128 << 20,
      assets: storageDir.appendingPathComponent("asset-cache").path
    )
    // The engine may fail to initialize (e.g. out of memory); degrade rather
    // than crash so the app stays alive without the worklet.
    guard let worklet = try? Worklet(configuration: configuration) else {
      BareHostLogger.log("Failed to initialize Bare worklet")
      return
    }
    worklet.start(
      name: "main.core",
      ofType: "bundle",
      inBundle: .main,
      // On-device argv contract: [webAssets, storage, cache] (see
      // apps/backend/src/config.ts → resolveWorkletConfig()). All three must be
      // directories; a missing/absent cache falls back to storage with a
      // warning, so pass a real cache dir to keep boots quiet.
      arguments: [webAssetsURL.path, storageDir.path, bareCacheDir.path]
    )
    self.worklet = worklet
    do {
      self.ipc = try IPC(worklet: worklet)
    } catch {
      BareHostLogger.log("Failed to initialize Bare IPC")
      worklet.terminate()
      self.worklet = nil
    }
  }

  /// Attaches the web layer once the WKWebView exists. The coordinator handles
  /// host capability queries and host invokes; the page itself talks to the
  /// worklet over the loopback WebSocket socket (cookie auth). Also installs a
  /// navigation delegate that confines the WebView to the loopback origin.
  func attach(webView: WKWebView) {
    guard let ipc, attached == false else { return }
    attached = true
    self.webView = webView

    let navDelegate = BareNavigationDelegate()
    navigationDelegate = navDelegate
    webView.navigationDelegate = navDelegate

    let hostPlugins = HostPluginRegistry()
    registerDefaultHostPlugins(hostPlugins)
    registerMediaHostPlugins(hostPlugins)

    coordinator = HostIpcCoordinator(ipc: ipc, hostPlugins: hostPlugins)
    coordinator?.start()

    waitForHandoffAndLoad(webView: webView)
  }

  /// Polls the worklet's `handoff.json` (written once the loopback server is
  /// up), injects the one-time bootstrap nonce + shell marker, then loads the page.
  private func waitForHandoffAndLoad(webView: WKWebView) {
    handoffTask = Task { @MainActor in
      let deadline = Date().addingTimeInterval(handoffTimeout)
      var credentials: [String: Any]?
      while Date() < deadline && !Task.isCancelled {
        if let data = try? Data(contentsOf: handoffURL) {
          credentials =
            (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
          if credentials != nil { break }
        }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
      guard
        !Task.isCancelled,
        let credentials,
        let origin = credentials["origin"] as? String,
        let bootstrap = credentials["bootstrap"] as? String,
        let url = URL(string: "\(origin)/index.html")
      else {
        BareHostLogger.log("Timed out waiting for worklet handoff")
        return
      }
      // Confine the WebView to exactly this loopback origin (host + port)
      // before the first load; until then every main-frame navigation is
      // cancelled.
      if let originURL = URL(string: origin) {
        navigationDelegate?.allowedHost = originURL.host
        navigationDelegate?.allowedPort = originURL.port
      }
      let payloadJSON =
        (try? JSONSerialization.data(withJSONObject: ["bootstrap": bootstrap]))
        .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
      var bootScript = "window.__ekrooh=" + payloadJSON + ";window.BareShell=true;"
      if let invite = pendingInvite {
        bootScript += "window.__justusInvite=" + Self.jsString(invite) + ";"
        pendingInvite = nil
      }
      webView.configuration.userContentController.addUserScript(
        WKUserScript(
          source: bootScript,
          injectionTime: .atDocumentStart,
          forMainFrameOnly: true
        )
      )
      webView.load(URLRequest(url: url))
      pageLoaded = true
      // The bootstrap is single-use; the page keeps its own HttpOnly session
      // cookie and the worklet writes a fresh handoff on the next boot.
      try? FileManager.default.removeItem(at: handoffURL)
    }
  }

  /// A justus://join/... link opened the app. Before the page loads it is
  /// injected at document start; afterwards the web layer gets an event and
  /// shows the join consent sheet.
  func openInvite(_ link: String) {
    guard pageLoaded, let webView else {
      pendingInvite = link
      return
    }
    webView.evaluateJavaScript(
      "window.dispatchEvent(new CustomEvent('justus:invite',{detail:" + Self.jsString(link) + "}))"
    )
  }

  private static func jsString(_ value: String) -> String {
    (try? JSONSerialization.data(withJSONObject: [value], options: []))
      .flatMap { String(data: $0, encoding: .utf8) }
      .map { String($0.dropFirst().dropLast()) } ?? "\"\""
  }

  func terminate() {
    guard terminated == false else { return }
    terminated = true
    handoffTask?.cancel()
    handoffTask = nil
    coordinator = nil
    // `close()` is asynchronous on the IPC actor; capture the reference so the
    // in-flight read loop observes the close instead of a torn-down channel.
    let ipcToClose = ipc
    Task { await ipcToClose?.close() }
    ipc = nil
    worklet?.terminate()
    worklet = nil
  }

  deinit {
    terminate()
  }
}

/// Restricts the WebView to the loopback origin handed off by the worklet.
/// Mirrors Android's `BareWebViewClient.allowedOrigin` and ekrooh's
/// `examples/ios-app`: any main-frame navigation to another host or port is
/// cancelled, and external http(s) URLs open in the system browser instead of
/// inside the view that holds the session cookie.
final class BareNavigationDelegate: NSObject, WKNavigationDelegate {
  var allowedHost: String?
  var allowedPort: Int?

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    // Sub-frame / non-main navigations are permitted (e.g. assets, sockets).
    guard navigationAction.targetFrame?.isMainFrame == true else {
      decisionHandler(.allow)
      return
    }
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    let host = components?.host ?? ""
    let port = components?.port ?? (url.scheme == "https" ? 443 : 80)
    if allowedHost != nil && host == allowedHost && port == allowedPort {
      decisionHandler(.allow)
      return
    }
    decisionHandler(.cancel)
    if url.scheme == "http" || url.scheme == "https" {
      UIApplication.shared.open(url)
    }
  }
}
