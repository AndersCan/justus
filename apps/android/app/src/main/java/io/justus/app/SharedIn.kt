package io.justus.app

import java.io.File

/**
 * Photos another app shares to Justus wait in `<worklet cache>/shared-in/<id>/`
 * until a person adds them to an album. The layout and the manifest are the
 * contract in packages/core/src/share/inbox.ts; the backend reads them.
 * Plain Kotlin, so JVM tests can call it.
 */
object SharedIn {
    /** Mirrors `SHARED_IN_DIR`. */
    const val DIR = "shared-in"
    const val MANIFEST = "batch.json"

    /** Mirrors `MAX_PICK` in packages/core/src/media/events.ts. */
    const val MAX_ITEMS = 50

    /** Mirrors `MAX_UPLOAD_BYTES` in apps/backend/src/upload-route.ts. */
    const val MAX_BYTES = 50L * 1024 * 1024

    data class Source(val uri: String, val mime: String?, val displayName: String?)

    data class Item(
        val file: String,
        val name: String?,
        val display: String?,
        val thumb: String?,
        val takenAt: String?,
    )

    data class Staged(val id: String, val items: Int, val dropped: Int)

    /** Only content:// from another app. Never file://, and never Justus's own
     * provider, so a sender cannot make Justus copy its private files. */
    fun acceptedSource(scheme: String?, authority: String?, ownAuthority: String): Boolean =
        scheme == "content" && authority != null && authority.substringAfterLast('@') != ownAuthority

    /** UTC ISO with milliseconds, always, so batches sort as text. */
    fun receivedAt(now: java.time.Instant): String =
        java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
            .withZone(java.time.ZoneOffset.UTC)
            .format(now)

    /** Mirrors `SHARED_IN_EXTS`. */
    fun extForMime(mime: String?): String? =
        when (mime?.lowercase()) {
            "image/jpeg", "image/jpg" -> "jpeg"
            "image/png" -> "png"
            "image/gif" -> "gif"
            "image/webp" -> "webp"
            "image/heic", "image/heif" -> "heic"
            else -> null
        }

    /** Drops `/`, `\` and control characters, cuts to 255. Null when nothing is left. */
    fun cleanName(raw: String?): String? {
        val kept = raw?.filter { it != '/' && it != '\\' && !it.isISOControl() }?.take(255)
        return kept?.takeIf { it.isNotEmpty() }
    }

    /** Compact JSON in the fixture's key order (packages/core/fixtures/shared-in-batch.v1.json). */
    fun manifestJson(id: String, receivedAt: String, items: List<Item>): String {
        val entries = items.joinToString(",") { item ->
            val fields = buildList {
                add("\"file\":${quote(item.file)}")
                item.name?.let { add("\"name\":${quote(it)}") }
                item.display?.let { add("\"display\":${quote(it)}") }
                item.thumb?.let { add("\"thumb\":${quote(it)}") }
                item.takenAt?.let { add("\"takenAt\":${quote(it)}") }
            }
            "{${fields.joinToString(",")}}"
        }
        return "{\"version\":1,\"id\":${quote(id)},\"receivedAt\":${quote(receivedAt)},\"items\":[$entries]}"
    }

    private fun quote(s: String): String {
        val out = StringBuilder("\"")
        for (c in s) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c < ' ' -> out.append("\\u%04x".format(c.code))
                else -> out.append(c)
            }
        }
        return out.append('"').toString()
    }

    /**
     * Writes one batch into `batchRoot/<id>/`: everything in `.tmp-<id>`, the
     * manifest last, then a rename, so a reader never sees half a batch.
     * `copy` writes a source to the file and returns its size, or null when it
     * could not (it may leave a partial file). Returns null, leaving nothing
     * behind, when no source was usable.
     */
    fun stage(
        batchRoot: File,
        id: String,
        receivedAt: String,
        sources: List<Source>,
        copy: (Source, File) -> Long?,
        makeCopies: (File, File) -> SharedCopies.Copies?,
    ): Staged? {
        val tmp = File(batchRoot, ".tmp-$id")
        tmp.deleteRecursively()
        if (!tmp.mkdirs()) return null
        val items = mutableListOf<Item>()
        for (source in sources.take(MAX_ITEMS)) {
            val ext = extForMime(source.mime) ?: continue
            val dest = File(tmp, "${items.size}.$ext")
            val size = copy(source, dest)
            if (size == null || size > MAX_BYTES) {
                dest.delete()
                continue
            }
            val copies = makeCopies(dest, tmp)
            items.add(
                Item(
                    file = dest.name,
                    name = cleanName(source.displayName),
                    display = copies?.display?.name,
                    thumb = copies?.thumb?.name,
                    takenAt = copies?.takenAt,
                ),
            )
        }
        if (items.isEmpty()) {
            tmp.deleteRecursively()
            return null
        }
        File(tmp, MANIFEST).writeText(manifestJson(id, receivedAt, items))
        if (!tmp.renameTo(File(batchRoot, id))) {
            tmp.deleteRecursively()
            return null
        }
        return Staged(id, items.size, sources.size - items.size)
    }
}
