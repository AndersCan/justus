package io.justus.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class WebAssetsTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun write(dir: File, path: String, text: String) {
        val f = File(dir, path)
        f.parentFile!!.mkdirs()
        f.writeText(text)
    }

    @Test
    fun everyFileNextToIndexHtmlReachesTheServedFolder() {
        val apk = tmp.newFolder("apk")
        write(apk, "web/index.html", "i")
        write(apk, "web/theme-boot.js", "t")
        write(apk, "web/favicon.svg", "f")
        write(apk, "web/assets/index-abc.js", "a")
        write(apk, "main.core.bundle", "b")
        val out = tmp.newFolder("out")

        copyAssetDir({ File(apk, it).list() }, { File(apk, it).inputStream() }, "web", out)

        val files = out.walkTopDown().filter { it.isFile }
            .map { it.relativeTo(out).path }.sorted().toList()
        assertEquals(
            listOf("assets/index-abc.js", "favicon.svg", "index.html", "theme-boot.js"),
            files,
        )
        assertEquals("t", File(out, "theme-boot.js").readText())
        assertFalse(File(out, "web").exists())
    }
}
