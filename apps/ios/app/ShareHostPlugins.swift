import BareHost
import Foundation
import UIKit

/// justus.share host handler: opens the system share sheet and answers once it
/// is on screen. Closing the sheet is not reported.
func registerShareHostPlugins(_ registry: HostPluginRegistry) {
  registry.register(pluginId: "justus.share", event: "share.send") { args, _, respond in
    Task { @MainActor in
      guard let text = args?["text"] as? String, !text.isEmpty else {
        respond(.fail(code: ErrorCodes.hostError, message: "Missing text"))
        return
      }
      guard let top = MediaHostPlugins.topViewController() else {
        respond(.fail(code: ErrorCodes.hostError, message: "No view controller to present from"))
        return
      }
      let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
      // iPad presents the sheet as a popover and crashes without an anchor.
      if let popover = sheet.popoverPresentationController {
        popover.sourceView = top.view
        popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
        popover.permittedArrowDirections = []
      }
      top.present(sheet, animated: true) { respond(.ok(["shown": true])) }
    }
  }
}
