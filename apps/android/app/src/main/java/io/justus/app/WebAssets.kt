package io.justus.app

import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream

/** Copies the asset folder `from` (and everything under it) into `to`, so that
 * `<from>/x/y` lands at `<to>/x/y`. `list` gives a folder's entries (empty or
 * null for a file), `open` reads a file. */
fun copyAssetDir(
    list: (String) -> Array<String>?,
    open: (String) -> InputStream,
    from: String,
    to: File,
) {
    fun walk(path: String) {
        for (name in list(path) ?: return) {
            val child = "$path/$name"
            val dest = File(to, child.removePrefix("$from/"))
            val children = list(child)
            if (children != null && children.isNotEmpty()) {
                dest.mkdirs()
                walk(child)
            } else {
                try {
                    open(child).use { input ->
                        dest.parentFile?.mkdirs()
                        dest.outputStream().use { input.copyTo(it) }
                    }
                } catch (e: FileNotFoundException) {
                    dest.mkdirs()
                }
            }
        }
    }
    walk(from)
}
