import XCTest

final class AppLockRuleTests: XCTestCase {
  func testLockDue() {
    XCTAssertFalse(lockDue(enabled: true, leftAt: 100, now: 129.999))
    XCTAssertTrue(lockDue(enabled: true, leftAt: 100, now: 130))
    XCTAssertTrue(lockDue(enabled: true, leftAt: 100, now: 99))
    XCTAssertTrue(lockDue(enabled: true, leftAt: nil, now: 0))
    XCTAssertFalse(lockDue(enabled: false, leftAt: nil, now: 0))
    XCTAssertFalse(lockDue(enabled: false, leftAt: 0, now: 999))
  }

  func testLaunched() {
    var on = AppLockState()
    on.launched(enabled: true)
    XCTAssertTrue(on.locked)
    XCTAssertTrue(on.hidden)
    var off = AppLockState()
    off.launched(enabled: false)
    XCTAssertFalse(off.locked)
    XCTAssertFalse(off.hidden)
  }

  func testCover() {
    var s = AppLockState()
    s.resigned(enabled: true)
    XCTAssertTrue(s.covered)
    XCTAssertTrue(s.hidden)
    _ = s.cameBack(enabled: true, secure: true, at: 1)
    XCTAssertFalse(s.covered)
    s.resigned(enabled: false)
    XCTAssertFalse(s.covered)
  }

  func testThirtySecondRule() {
    var s = AppLockState()
    s.left(at: 100)
    XCTAssertFalse(s.cameBack(enabled: true, secure: true, at: 129.9))
    XCTAssertFalse(s.locked)

    s.left(at: 100)
    XCTAssertTrue(s.cameBack(enabled: true, secure: true, at: 130))
    XCTAssertTrue(s.locked)

    s.resigned(enabled: true)
    XCTAssertFalse(s.cameBack(enabled: true, secure: true, at: 131))
    XCTAssertTrue(s.locked)
  }

  func testNoLeaveNeverLocks() {
    var s = AppLockState()
    XCTAssertFalse(s.cameBack(enabled: true, secure: true, at: 500))
    XCTAssertFalse(s.locked)
  }

  func testDisabledNeverLocks() {
    var s = AppLockState()
    s.left(at: 0)
    XCTAssertFalse(s.cameBack(enabled: false, secure: true, at: 999))
    XCTAssertFalse(s.locked)
  }

  func testLostScreenLockOpens() {
    var s = AppLockState()
    s.launched(enabled: true)
    XCTAssertFalse(s.cameBack(enabled: true, secure: false, at: 1))
    XCTAssertFalse(s.locked)
  }

  func testConfirmedThenLocksAgain() {
    var s = AppLockState()
    s.launched(enabled: true)
    XCTAssertTrue(s.cameBack(enabled: true, secure: true, at: 1))
    s.confirmed()
    XCTAssertFalse(s.locked)
    s.left(at: 10)
    XCTAssertTrue(s.cameBack(enabled: true, secure: true, at: 40))
  }

  func testToggleStep() {
    XCTAssertEqual(toggleStep(requested: nil, current: false, secure: true, promptOpen: false), .fail("Missing enabled"))
    XCTAssertEqual(toggleStep(requested: true, current: true, secure: false, promptOpen: false), .fail("No screen lock set"))
    XCTAssertEqual(toggleStep(requested: true, current: true, secure: true, promptOpen: true), .answer(enabled: true))
    XCTAssertEqual(toggleStep(requested: true, current: false, secure: true, promptOpen: true), .fail("Unlock already in progress"))
    XCTAssertEqual(toggleStep(requested: true, current: false, secure: true, promptOpen: false), .prompt)
  }
}
