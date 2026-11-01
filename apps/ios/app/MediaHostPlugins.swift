import BareHost
import Foundation
import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Justus `vendor.media` host handlers (mirror of the ekrooh reference
/// `examples/ios-app/app/MediaHostPlugins.swift` and the Android host's
/// `registerMediaHostPlugins`): pick/capture natively, then return a staged file
/// path the worklet imports or serves — no media bytes cross the wire.
/// `justus.media.pickMany` is the multi-select variant Justus's web layer uses.
/// Simulators report a deterministic "camera unavailable" error
/// (`UIImagePickerController.isSourceTypeAvailable(.camera)` is false).
enum MediaHostPlugins {
  /// Where picks and captures are staged. `BareRuntime` points it inside the
  /// worklet's cache dir, an allowed `photos.add` import root (#93/#97); the
  /// system temp dir is not one.
  static var stagingDir = URL(fileURLWithPath: NSTemporaryDirectory())

  /// Mirrors `MAX_PICK` in packages/core/src/media/events.ts.
  static let maxPick = 50

  static func register(_ registry: HostPluginRegistry) {
    registry.register(pluginId: "vendor.media", event: "media.pick") { args, _, respond in
      MediaHostPlugins.pick(kind: Self.kind(from: args), limit: 1, respond: respond)
    }
    registry.register(pluginId: "vendor.media", event: "media.capture") { args, _, respond in
      MediaHostPlugins.capture(kind: Self.kind(from: args), respond: respond)
    }
    registry.register(pluginId: "justus.media", event: "media.pickMany") { args, _, respond in
      let asked = (args?["limit"] as? Int) ?? Self.maxPick
      MediaHostPlugins.pick(
        kind: Self.kind(from: args),
        limit: min(max(asked, 1), Self.maxPick),
        many: true,
        respond: respond
      )
    }
    registry.register(pluginId: "justus.media", event: "media.capture") { args, _, respond in
      MediaHostPlugins.capture(kind: Self.kind(from: args), copies: true, respond: respond)
    }
  }

  private static func kind(from args: [String: Any]?) -> String {
    (args?["kind"] as? String) ?? "image"
  }

  private static func pick(
    kind: String,
    limit: Int,
    many: Bool = false,
    respond: @escaping (HostPluginRegistry.HostInvokeOutcome) -> Void
  ) {
    Task { @MainActor in
      var config = PHPickerConfiguration(photoLibrary: .shared())
      config.filter = kind == "video" ? .videos : .images
      config.selectionLimit = limit
      if many, #available(iOS 15.0, *) { config.selection = .ordered }
      let picker = PHPickerViewController(configuration: config)
      // justus.media (`many`) shares copies the host makes; vendor.media
      // hands back the original.
      let controller = MediaPickerController(
        kind: kind, many: many, copies: many, respond: respond)
      picker.delegate = controller
      guard let top = Self.topViewController() else {
        respond(
          .fail(code: ErrorCodes.hostError, message: "No view controller to present from")
        )
        return
      }
      Self.retain(controller)
      top.present(picker, animated: true)
    }
  }

  private static func capture(
    kind: String,
    copies: Bool = false,
    respond: @escaping (HostPluginRegistry.HostInvokeOutcome) -> Void
  ) {
    Task { @MainActor in
      #if targetEnvironment(simulator)
      // Simulators have no camera — deterministic, testable failure regardless
      // of isSourceTypeAvailable (newer simulators report a camera).
      respond(.fail(code: ErrorCodes.hostError, message: "camera unavailable"))
      #else
      guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
        respond(.fail(code: ErrorCodes.hostError, message: "camera unavailable"))
        return
      }
      guard let top = Self.topViewController() else {
        respond(
          .fail(code: ErrorCodes.hostError, message: "No view controller to present from")
        )
        return
      }
      let picker = UIImagePickerController()
      picker.sourceType = .camera
      picker.mediaTypes =
        kind == "video" ? [UTType.movie.identifier] : [UTType.image.identifier]
      let controller = MediaPickerController(kind: kind, copies: copies, respond: respond)
      picker.delegate = controller
      Self.retain(controller)
      top.present(picker, animated: true)
      #endif
    }
  }

  private static func topViewController() -> UIViewController? {
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes
      where scene.activationState == .foregroundActive {
      var top = scene.windows.first { $0.isKeyWindow }?.rootViewController
      while let presented = top?.presentedViewController {
        top = presented
      }
      return top
    }
    return nil
  }

  private static var active = Set<MediaPickerController>()

  fileprivate static func retain(_ controller: MediaPickerController) {
    active.insert(controller)
  }

  fileprivate static func release(_ controller: MediaPickerController) {
    active.remove(controller)
  }
}

func registerMediaHostPlugins(_ registry: HostPluginRegistry) {
  MediaHostPlugins.register(registry)
}

/// Retains the respond closure until the native picker/camera finishes, then
/// stages the result as a temp file and responds with its path. Kept strongly
/// referenced by `MediaHostPlugins.active` because UIKit delegates are weak.
private final class MediaPickerController: NSObject, PHPickerViewControllerDelegate,
  UIImagePickerControllerDelegate, UINavigationControllerDelegate
{
  private let kind: String
  /// Answer `{items: [...]}` (justus.media.pickMany) instead of one `{path}`.
  private let many: Bool
  /// Answer with the copies the album shares (`PickedMedia` in
  /// packages/core/src/media/events.ts) instead of the original alone.
  private let copies: Bool
  private let respond: (HostPluginRegistry.HostInvokeOutcome) -> Void

  init(
    kind: String, many: Bool = false, copies: Bool = false,
    respond: @escaping (HostPluginRegistry.HostInvokeOutcome) -> Void
  ) {
    self.kind = kind
    self.many = many
    self.copies = copies
    self.respond = respond
  }

  /// One `PickedMedia`. With `copies`, `path` is the display copy and the
  /// original rides along only to be hashed and dated; a photo ImageIO can't
  /// read is shared as is.
  private func item(_ staged: URL, name: String?) -> [String: Any] {
    var item: [String: Any] = ["path": staged.path]
    if let name, !name.isEmpty { item["name"] = name }
    guard copies, kind == "image",
      let made = SharedCopies.make(from: staged, in: MediaHostPlugins.stagingDir)
    else { return item }
    item["path"] = made.display.path
    item["thumb"] = made.thumb.path
    item["original"] = staged.path
    if let takenAt = made.takenAt { item["takenAt"] = takenAt }
    return item
  }

  private func abort(_ message: String) {
    respond(.fail(code: ErrorCodes.hostError, message: message))
    MediaHostPlugins.release(self)
  }

  private func finish(_ path: URL, name: String? = nil) {
    // Encoding the copies takes a moment: keep it off the main thread.
    DispatchQueue.global(qos: .userInitiated).async {
      let item = self.item(path, name: name)
      DispatchQueue.main.async {
        self.respond(.ok(item))
        MediaHostPlugins.release(self)
      }
    }
  }

  private func stage(from source: URL) -> URL? {
    let ext =
      source.pathExtension.isEmpty
      ? (kind == "video" ? "mov" : "heic") : source.pathExtension
    let dest = MediaHostPlugins.stagingDir
      .appendingPathComponent("media-\(UUID().uuidString).\(ext)")
    do {
      try FileManager.default.copyItem(at: source, to: dest)
      return dest
    } catch {
      return nil
    }
  }

  // MARK: - PHPickerViewControllerDelegate

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    if many {
      finishMany(results)
      return
    }
    guard let result = results.first else {
      abort("No item selected")
      return
    }
    let type = kind == "video" ? UTType.movie.identifier : UTType.image.identifier
    result.itemProvider.loadFileRepresentation(forTypeIdentifier: type) {
      [weak self] url, error in
      guard let self else { return }
      guard let url, error == nil else {
        self.abort("Failed to load picked file: \(error?.localizedDescription ?? "unknown")")
        return
      }
      guard let dest = self.stage(from: url) else {
        self.abort("Failed to stage picked file")
        return
      }
      // Thread the picker's original display name through (#99) so the stored
      // photo keeps the user's file name instead of the temp staging name.
      self.finish(dest, name: result.itemProvider.suggestedName)
    }
  }

  /// Stages every picked item in parallel, keeping the picker's order. Items
  /// that fail to load are dropped; the invoke fails only if none staged.
  private func finishMany(_ results: [PHPickerResult]) {
    if results.isEmpty {
      abort("Media pick cancelled")
      return
    }
    let type = kind == "video" ? UTType.movie.identifier : UTType.image.identifier
    var staged = [(url: URL, name: String?)?](repeating: nil, count: results.count)
    let lock = NSLock()
    let group = DispatchGroup()
    for (index, result) in results.enumerated() {
      group.enter()
      // The URL is only valid inside the callback: stage it there.
      result.itemProvider.loadFileRepresentation(forTypeIdentifier: type) {
        [weak self] url, _ in
        defer { group.leave() }
        guard let self, let url, let dest = self.stage(from: url) else { return }
        lock.lock()
        staged[index] = (dest, result.itemProvider.suggestedName)
        lock.unlock()
      }
    }
    // One photo at a time: each decode holds a full-size bitmap, and fifty at
    // once would get the app killed for memory.
    group.notify(queue: .global(qos: .userInitiated)) { [weak self] in
      guard let self else { return }
      let items = staged.compactMap { $0 }.map { self.item($0.url, name: $0.name) }
      DispatchQueue.main.async {
        if items.isEmpty {
          self.abort("Failed to stage picked files")
          return
        }
        self.respond(.ok(["items": items]))
        MediaHostPlugins.release(self)
      }
    }
  }

  // MARK: - UIImagePickerControllerDelegate

  func imagePickerController(
    _ picker: UIImagePickerController,
    didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
  ) {
    picker.dismiss(animated: true)
    if kind == "video" {
      guard let url = info[.mediaURL] as? URL, let dest = stage(from: url) else {
        abort("Failed to stage captured video")
        return
      }
      finish(dest)
      return
    }
    guard let image = info[.originalImage] as? UIImage else {
      abort("No captured image")
      return
    }
    let dest = MediaHostPlugins.stagingDir
      .appendingPathComponent("media-\(UUID().uuidString).jpg")
    // Keep the camera's metadata on the staged original: its date taken (and
    // orientation) feed the shared copies. `originalImage` alone carries none.
    let metadata = info[.mediaMetadata] as? [CFString: Any]
    guard Self.writeJPEG(image, metadata: metadata, to: dest) else {
      abort("Failed to stage captured image")
      return
    }
    // A dated name, so the photo isn't listed as `media-<uuid>.jpg`.
    let stamp = DateFormatter()
    stamp.locale = Locale(identifier: "en_US_POSIX")
    stamp.dateFormat = "yyyyMMdd_HHmmss"
    finish(dest, name: "IMG_\(stamp.string(from: Date())).jpg")
  }

  private static func writeJPEG(_ image: UIImage, metadata: [CFString: Any]?, to url: URL) -> Bool {
    guard let cgImage = image.cgImage, let metadata,
      let dest = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
    else {
      guard let data = image.jpegData(compressionQuality: 0.9) else { return false }
      return (try? data.write(to: url)) != nil
    }
    var props = metadata
    props[kCGImageDestinationLossyCompressionQuality] = 0.9
    CGImageDestinationAddImage(dest, cgImage, props as CFDictionary)
    return CGImageDestinationFinalize(dest)
  }

  func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
    picker.dismiss(animated: true)
    abort("Capture cancelled")
  }
}