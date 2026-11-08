import Foundation

/// A JSON string literal for `value`, safe to splice into a JavaScript source.
func jsString(_ value: String) -> String {
  (try? JSONSerialization.data(withJSONObject: [value], options: []))
    .flatMap { String(data: $0, encoding: .utf8) }
    .map { String($0.dropFirst().dropLast()) } ?? "\"\""
}
