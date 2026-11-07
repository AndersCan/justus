package io.justus.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class StorageDirsTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun write(dir: File, path: String, text: String) {
        val f = File(dir, path)
        f.parentFile!!.mkdirs()
        f.writeText(text)
    }

    private fun text(dir: File, path: String) = File(dir, path).readText()

    private fun legacyWithStore(): File {
        val legacy = File(tmp.root, "cache/bare")
        write(legacy, "corestore/db/x", "legacy-x")
        write(legacy, "justus.json", "legacy-json")
        return legacy
    }

    private fun target() = File(tmp.root, "files/bare")

    @Test fun freshInstallCreatesNothing() {
        val legacy = File(tmp.root, "cache/bare")
        val result = moveLegacyStorage(legacy, target())
        assertEquals(target(), result)
        assertFalse(legacy.exists())
        assertFalse(target().exists())
    }

    @Test fun legacyStoreIsMoved() {
        val legacy = legacyWithStore()
        val logs = mutableListOf<String>()
        val result = moveLegacyStorage(legacy, target()) { logs += it }
        assertEquals(target(), result)
        assertEquals("legacy-x", text(target(), "corestore/db/x"))
        assertEquals("legacy-json", text(target(), "justus.json"))
        assertFalse(legacy.exists())
        assertTrue(logs.single().contains("moved"))
    }

    @Test fun alreadyMovedIsUntouchedAndRepeatable() {
        val legacy = File(tmp.root, "cache/bare")
        write(target(), "corestore/db/x", "new-x")
        repeat(2) {
            assertEquals(target(), moveLegacyStorage(legacy, target()))
            assertEquals("new-x", text(target(), "corestore/db/x"))
            assertFalse(legacy.exists())
        }
    }

    @Test fun targetWithoutStoreIsReplaced() {
        val legacy = legacyWithStore()
        write(target(), "handoff.json", "stale")
        assertEquals(target(), moveLegacyStorage(legacy, target()))
        assertEquals("legacy-x", text(target(), "corestore/db/x"))
        assertFalse(File(target(), "handoff.json").exists())
    }

    @Test fun bothHaveStoreKeepsTarget() {
        val legacy = legacyWithStore()
        write(target(), "corestore/db/x", "new-x")
        val logs = mutableListOf<String>()
        assertEquals(target(), moveLegacyStorage(legacy, target()) { logs += it })
        assertEquals("new-x", text(target(), "corestore/db/x"))
        assertEquals("legacy-x", text(legacy, "corestore/db/x"))
        assertTrue(logs.single().contains("kept"))
    }

    @Test fun failedRenameUsesLegacy() {
        val legacy = legacyWithStore()
        val blocker = File(tmp.root, "blocker").apply { writeText("file") }
        val badTarget = File(blocker, "bare")
        val logs = mutableListOf<String>()
        assertEquals(legacy, moveLegacyStorage(legacy, badTarget) { logs += it })
        assertEquals("legacy-x", text(legacy, "corestore/db/x"))
        assertTrue(logs.single().contains("failed"))
    }

    @Test fun legacyWithoutStoreIsLeftAlone() {
        val legacy = File(tmp.root, "cache/bare")
        write(legacy, "imports/a.jpg", "img")
        assertEquals(target(), moveLegacyStorage(legacy, target()))
        assertEquals("img", text(legacy, "imports/a.jpg"))
        assertFalse(target().exists())
    }

    @Test fun leftoversAreRemovedAndDurableKept() {
        val s = File(tmp.root, "storage")
        val durable = listOf("corestore/db/x", "justus.json", "presence.json", "friends.json", "grant-ledger.json", "notes.txt")
        val gone = listOf("imports/a", "asset-cache/b", "photos/a/b.jpg", "uploads/c", "upload-1.jpg", "justus-log-1.jsonl")
        (durable + gone).forEach { write(s, it, "x") }
        removeLayout1Leftovers(s)
        durable.forEach { assertTrue(it, File(s, it).exists()) }
        gone.forEach { assertFalse(it, File(s, it).exists()) }
        removeLayout1Leftovers(s)
        removeLayout1Leftovers(File(tmp.root, "missing"))
        assertArrayEquals(durable.map { it.substringBefore('/') }.toSet().sorted().toTypedArray(), s.list()!!.sorted().toTypedArray())
    }
}
