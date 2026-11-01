package io.justus.app

import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.media.ExifInterface
import android.util.Log
import java.io.File
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Makes the copies an album shares from a picked or captured photo: a display
 * copy and a thumbnail. The original never leaves the device. Mirrors
 * packages/core/src/photos/renditions.ts.
 *
 * JPEG, which every Web layer Justus ships can show. Re-encoding drops the
 * original's EXIF, location included; the date taken is read here and passed
 * on instead.
 */
object SharedCopies {
    private const val DISPLAY_EDGE = 2560
    private const val THUMB_EDGE = 640
    private const val TAG = "JUSTUS_ANDROID"

    data class Copies(val display: File, val thumb: File, val takenAt: String?)

    /** Null when the photo can't be decoded here; the caller then shares the
     * original as it is. */
    fun make(original: File, dir: File): Copies? {
        return try {
            val stem = "copy-${original.nameWithoutExtension}"
            val display = encode(decode(original, DISPLAY_EDGE), File(dir, "$stem-display.jpg"), 85)
            val thumb = encode(decode(original, THUMB_EDGE), File(dir, "$stem-thumb.jpg"), 78)
            Copies(display, thumb, takenAt(original))
        } catch (e: Exception) {
            Log.e(TAG, "Could not make shared copies of ${original.name}", e)
            null
        }
    }

    /** Decodes straight to the target size; ImageDecoder applies the EXIF
     * orientation, so the copies are upright without it. */
    private fun decode(file: File, edge: Int): Bitmap =
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
            val scale = min(1.0, edge.toDouble() / max(info.size.width, info.size.height))
            val w = max(1, (info.size.width * scale).roundToInt())
            val h = max(1, (info.size.height * scale).roundToInt())
            decoder.setTargetSize(w, h)
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }

    private fun encode(bitmap: Bitmap, file: File, quality: Int): File {
        try {
            file.outputStream().use { out ->
                check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)) { "JPEG encode failed" }
            }
            return file
        } finally {
            bitmap.recycle()
        }
    }

    /** EXIF date taken as `YYYY-MM-DDTHH:MM:SS[±HH:MM]` (see `TAKEN_AT_RE`). */
    private fun takenAt(file: File): String? {
        val exif = try {
            ExifInterface(file)
        } catch (e: Exception) {
            return null
        }
        val raw = exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)
            ?: exif.getAttribute(ExifInterface.TAG_DATETIME_DIGITIZED)
            ?: return null
        val m = Regex("""^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})""").find(raw) ?: return null
        val (y, mo, d, h, mi, s) = m.destructured
        val offset = exif.getAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL)
            ?.takeIf { Regex("""^[+-]\d{2}:\d{2}$""").matches(it) } ?: ""
        return "$y-$mo-${d}T$h:$mi:$s$offset"
    }
}
