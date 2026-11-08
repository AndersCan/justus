import XCTest

final class JSStringTests: XCTestCase {
  func testRoundTrip() throws {
    let samples = [
      "justus://join/abc?e=1", "a\"b", "back\\slash", "line\nbreak", "</script>", "ÆØÅ 😀",
    ]
    for s in samples {
      let decoded = try JSONSerialization.jsonObject(with: Data("[\(jsString(s))]".utf8))
      XCTAssertEqual(decoded as? [String], [s])
    }
  }

  func testQuoted() {
    let result = jsString("abc")
    XCTAssertTrue(result.hasPrefix("\""))
    XCTAssertTrue(result.hasSuffix("\""))
  }

  func testEmpty() {
    XCTAssertEqual(jsString(""), "\"\"")
  }
}
