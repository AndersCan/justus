package io.justus.app

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedInTest {
    private val fixture = File("../../../packages/core/fixtures/shared-in-batch.v1.json")
    private fun tempDir(): File = Files.createTempDirectory("shared-in").toFile()
    private fun src(i: Int, mime: String? = "image/jpeg") = SharedIn.Source("content://x/$i", mime, "p$i.jpg")
    private val writeBytes: (SharedIn.Source, File) -> Long? = { _, f -> f.writeText("x"); 1L }
    private val noCopies: (File, File) -> SharedCopies.Copies? = { _, _ -> null }

    @Test
    fun manifestJsonEqualsTheFixture() {
        val text = SharedIn.manifestJson(
            "6f1c2a9e-3b7d-4c55-9a10-2f8e4d7b0c11",
            "2026-11-17T21:30:00.000Z",
            listOf(
                SharedIn.Item("0.jpeg", "Beach.jpg", "copy-0-display.jpg", "copy-0-thumb.jpg", "2026-08-01T12:00:00+02:00"),
                SharedIn.Item("1.png", "Map.png", null, null, null),
            ),
        )
        assertEquals(fixture.readText().trim(), text)
    }

    @Test
    fun manifestJsonEscapes() {
        val text = SharedIn.manifestJson("a", "b", listOf(SharedIn.Item("0.png", "a\"b\u0001", null, null, null)))
        assertTrue(text.contains("\"name\":\"a\\\"b\\u0001\""))
    }

    @Test
    fun acceptedSourceOnlyTakesOtherAppsContent() {
        val own = "io.justus.app.fileprovider"
        assertFalse(SharedIn.acceptedSource("file", null, own))
        assertFalse(SharedIn.acceptedSource("content", own, own))
        assertFalse(SharedIn.acceptedSource("content", null, own))
        assertFalse(SharedIn.acceptedSource(null, "media", own))
        assertTrue(SharedIn.acceptedSource("content", "media", own))
    }

    @Test
    fun extForMime() {
        assertEquals("jpeg", SharedIn.extForMime("image/jpeg"))
        assertEquals("heic", SharedIn.extForMime("image/heif"))
        assertEquals("png", SharedIn.extForMime("IMAGE/PNG"))
        assertNull(SharedIn.extForMime("image/svg+xml"))
        assertNull(SharedIn.extForMime(null))
    }

    @Test
    fun cleanName() {
        assertEquals("..a.jpg", SharedIn.cleanName("../a\u0000.jpg"))
        assertEquals("ab", SharedIn.cleanName("a\\b"))
        assertNull(SharedIn.cleanName("/\u0000"))
        assertNull(SharedIn.cleanName(null))
        assertEquals(255, SharedIn.cleanName("a".repeat(300))?.length)
    }

    @Test
    fun stageWritesTheBatchAndManifestLast() {
        val root = tempDir()
        val staged = SharedIn.stage(root, "id1", "t", listOf(src(0), src(1, "image/png")), writeBytes, noCopies)
        assertEquals(SharedIn.Staged("id1", 2, 0), staged)
        val dir = File(root, "id1")
        assertEquals(listOf("0.jpeg", "1.png", "batch.json"), dir.list()!!.sorted())
        assertFalse(File(root, ".tmp-id1").exists())
        assertEquals(
            "{\"version\":1,\"id\":\"id1\",\"receivedAt\":\"t\",\"items\":[{\"file\":\"0.jpeg\",\"name\":\"p0.jpg\"},{\"file\":\"1.png\",\"name\":\"p1.jpg\"}]}",
            File(dir, "batch.json").readText(),
        )
    }

    @Test
    fun stageKeepsTheFirst50() {
        val root = tempDir()
        val staged = SharedIn.stage(root, "id", "t", (0 until 51).map { src(it) }, writeBytes, noCopies)
        assertEquals(50, staged?.items)
        assertEquals(1, staged?.dropped)
        assertEquals(51, File(root, "id").list()!!.size)
    }

    @Test
    fun stageDropsACopyFailureAnAnUnsupportedTypeAndAnOversizedFile() {
        val root = tempDir()
        val sources = listOf(src(0), src(1, "image/svg+xml"), src(2), src(3))
        val copy: (SharedIn.Source, File) -> Long? = { s, f ->
            f.writeText("x")
            when (s.uri) {
                "content://x/0" -> null
                "content://x/2" -> SharedIn.MAX_BYTES + 1
                else -> 1L
            }
        }
        val staged = SharedIn.stage(root, "id", "t", sources, copy, noCopies)
        assertEquals(SharedIn.Staged("id", 1, 3), staged)
        assertEquals(listOf("0.jpeg", "batch.json"), File(root, "id").list()!!.sorted())
    }

    @Test
    fun stageWithNothingUsableLeavesNoDir() {
        val root = tempDir()
        assertNull(SharedIn.stage(root, "id", "t", listOf(src(0)), { _, _ -> null }, noCopies))
        assertEquals(0, root.list()!!.size)
    }

    @Test
    fun stageRecordsTheCopies() {
        val root = tempDir()
        val make: (File, File) -> SharedCopies.Copies? = { _, dir ->
            SharedCopies.Copies(File(dir, "copy-0-display.jpg"), File(dir, "copy-0-thumb.jpg"), "2026-08-01T12:00:00")
        }
        assertNotNull(SharedIn.stage(root, "id", "t", listOf(src(0)), writeBytes, make))
        assertTrue(
            File(root, "id/batch.json").readText().contains(
                "\"display\":\"copy-0-display.jpg\",\"thumb\":\"copy-0-thumb.jpg\",\"takenAt\":\"2026-08-01T12:00:00\"",
            ),
        )
    }
}
