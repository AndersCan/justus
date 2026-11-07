package io.justus.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockTest {
    @Test fun underThirtySecondsStaysOpen() = assertFalse(lockDue(true, 1_000L, 1_000L + 29_999L))

    @Test fun exactlyThirtySecondsLocks() = assertTrue(lockDue(true, 1_000L, 1_000L + 30_000L))

    @Test fun clockGoingBackwardsLocks() = assertTrue(lockDue(true, 5_000L, 4_000L))

    @Test fun coldStartLocks() = assertTrue(lockDue(true, null, 0L))

    @Test fun disabledNeverLocks() {
        assertFalse(lockDue(false, null, 0L))
        assertFalse(lockDue(false, 0L, 999_999L))
    }

    @Test fun ownScreenUsesLongerLimit() {
        assertFalse(lockDue(true, 0L, 299_999L, OWN_SCREEN_LOCK_AFTER_MS))
        assertTrue(lockDue(true, 0L, 300_000L, OWN_SCREEN_LOCK_AFTER_MS))
    }
}
