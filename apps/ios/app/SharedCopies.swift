import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Makes the copies an album shares from a picked or captured photo: a display
/// copy and a thumbnail. The original never leaves the device. Mirrors
/// packages/core/src/photos/renditions.ts.
///
/// JPEG, which every Web layer Justus ships can show. Re-encoding
/// without the source's properties drops its EXIF, location included; the
/// date taken is read here and passed on instead.
enum SharedCopies {
  static let displayEdge = 2560
  static let thumbEdge = 640

  struct Copies {
    let display: URL
    let thumb: URL
    let takenAt: String?
  }

  /// Nil when ImageIO can't read the photo; the caller then shares it as is.
  static func make(from original: URL, in dir: URL) -> Copies? {
    guard let source = CGImageSourceCreateWithURL(original as CFURL, nil) else { return nil }
    let stem = "copy-\(original.deletingPathExtension().lastPathComponent)"
    guard
      let display = encode(
        source, edge: displayEdge, to: dir.appendingPathComponent("\(stem)-display"),
        quality: 0.85),
      let thumb = encode(
        source, edge: thumbEdge, to: dir.appendingPathComponent("\(stem)-thumb"),
        quality: 0.78)
    else { return nil }
    return Copies(display: display, thumb: thumb, takenAt: takenAt(source))
  }

  private static func encode(_ source: CGImageSource, edge: Int, to base: URL, quality: Double)
    -> URL?
  {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      // Bakes in the EXIF orientation, so the copy is upright without it.
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: edge,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    else { return nil }
    let url = base.appendingPathExtension("jpg")
    guard
      let dest = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(
      dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(dest) ? url : nil
  }

  /// EXIF date taken as `YYYY-MM-DDTHH:MM:SS[±HH:MM]` (see `TAKEN_AT_RE`).
  private static func takenAt(_ source: CGImageSource) -> String? {
    guard
      let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any],
      let raw = (exif[kCGImagePropertyExifDateTimeOriginal]
        ?? exif[kCGImagePropertyExifDateTimeDigitized]) as? String
    else { return nil }
    let parts = raw.split(whereSeparator: { $0 == ":" || $0 == " " })
    guard parts.count == 6, parts.allSatisfy({ Int($0) != nil }) else { return nil }
    var out = "\(parts[0])-\(parts[1])-\(parts[2])T\(parts[3]):\(parts[4]):\(parts[5])"
    if let offset = exif[kCGImagePropertyExifOffsetTimeOriginal] as? String,
      offset.range(of: #"^[+-]\d{2}:\d{2}$"#, options: .regularExpression) != nil
    {
      out += offset
    }
    return out
  }
}
