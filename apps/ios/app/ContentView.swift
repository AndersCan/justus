import BareHost
import SwiftUI
import WebKit

struct ContentView: View {
  let runtime: BareRuntime
  @ObservedObject var lock: AppLockController

  var body: some View {
    ZStack {
      BareWebView(runtime: runtime)
        .opacity(lock.state.hidden ? 0 : 1)
        .accessibilityHidden(lock.state.hidden)
      if lock.state.hidden {
        LockCover(onTap: lock.requestOpen)
      }
    }
    .ignoresSafeArea()
  }
}

/// Full-screen WKWebView. The page is served by the worklet's loopback HTTP
/// server (URL loaded after the origin/bootstrap handoff in `BareRuntime`).
struct BareWebView: UIViewRepresentable {
  let runtime: BareRuntime

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    let webView = WKWebView(frame: .zero, configuration: configuration)

    runtime.attach(webView: webView)

    return webView
  }

  func updateUIView(_ uiView: WKWebView, context: Context) {}
}