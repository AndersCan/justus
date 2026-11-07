package io.justus.app

import java.io.File

private fun hasStore(dir: File) = File(dir, "corestore").isDirectory

/** Moves a store from before justus#358 (layout 1: everything in cacheDir/bare) to
 * filesDir/bare (layout 2). Returns the dir the worklet must use this launch. */
fun moveLegacyStorage(legacy: File, target: File, log: (String) -> Unit = {}): File {
    if (!hasStore(legacy)) return target
    if (hasStore(target)) {
        log("storage: kept filesDir/bare; cacheDir/bare also has a store")
        return target
    }
    if (target.exists()) target.deleteRecursively()
    target.parentFile?.mkdirs()
    if (legacy.renameTo(target)) {
        log("storage: moved cacheDir/bare to filesDir/bare")
        return target
    }
    log("storage: move failed; using cacheDir/bare this launch")
    return legacy
}

private val leftoverDirs = setOf("imports", "asset-cache", "photos", "uploads")

private fun isLeftoverFile(name: String) =
    name.startsWith("upload-") || (name.startsWith("justus-log-") && name.endsWith(".jsonl"))

/** Deletes, from the storage dir, what layout 1 kept there but layout 2 keeps in the
 * cache dir. Idempotent; never touches anything not listed. */
fun removeLayout1Leftovers(storage: File) {
    val children = storage.listFiles() ?: return
    for (child in children) {
        val leftover = if (child.isDirectory) child.name in leftoverDirs else isLeftoverFile(child.name)
        if (leftover) child.deleteRecursively()
    }
}
