package io.justus.app

import android.content.ContentValues
import android.content.Intent
import android.provider.MediaStore
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.regex.Pattern
import org.junit.Before
import org.junit.Test
import tools.fastlane.screengrab.Screengrab
import tools.fastlane.screengrab.UiAutomatorScreenshotStrategy

// Play listing screenshots. The names here must match SCREENSHOTS in fastlane/Fastfile.
// The photo picker is a system surface: its selectors are the thumbnail and the
// "Add" button of the provider's picker (com.android.providers.media.module or
// com.google.android.providers.media.module on the API 36 google_apis image).
class ListingScreenshots {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val device = UiDevice.getInstance(instrumentation)
  private val target = instrumentation.targetContext
  private val photos = listOf("happy-dog.jpg", "swing.jpg", "vacation.jpg")

  @Before
  fun seedPhotos() {
    photos.forEach { name ->
      val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, name)
        put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
        put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Justus samples")
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }
      val resolver = target.contentResolver
      val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
      resolver.openOutputStream(uri)!!.use { out ->
        instrumentation.context.assets.open(name).use { it.copyTo(out) }
      }
      values.clear()
      values.put(MediaStore.Images.Media.IS_PENDING, 0)
      resolver.update(uri, values, null, null)
    }
  }

  private fun find(text: String, seconds: Long): UiObject2 {
    val found = device.wait(Until.findObject(By.text(text)), seconds * 1000)
      ?: device.wait(Until.findObject(By.desc(text)), 1000)
    return found ?: fail("not found: $text", text)
  }

  private fun fail(message: String, text: String): Nothing {
    val hierarchy = java.io.ByteArrayOutputStream().also { device.dumpWindowHierarchy(it) }
    hierarchy.toString().chunked(3000).forEach { Log.e("ListingShots", it) }
    throw AssertionError(message + " [" + text + "]")
  }

  // The fields are web inputs whose label is only a hint, so take the one EditText on screen.
  private fun typeInField(text: String) {
    val field = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 20000)
      ?: fail("no text field", text)
    field.click()
    type(text)
  }

  private fun type(text: String) {
    device.executeShellCommand("input text " + text)
    device.pressEnter()
  }

  @Test
  fun listing() {
    val intent = target.packageManager.getLaunchIntentForPackage(target.packageName)!!
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    target.startActivity(intent)
    find("Skip", 60).click()
    typeInField("Sam")
    find("Start sharing", 20)
    find("Start sharing", 20)
    typeInField("Summer%s2026")
    find("No photos in this album yet.", 20)
    find("Add photos to Summer 2026", 20).click()

    val thumbs = device.wait(
      Until.findObjects(By.res(Pattern.compile(".*:id/icon_thumbnail"))), 20000
    )
    if (thumbs == null || thumbs.size < 3) {
      fail("picker thumbnails: " + thumbs?.size, "icon_thumbnail")
    }
    thumbs.take(3).forEach { it.click(); Thread.sleep(500) }
    val add = device.wait(Until.findObject(By.res(Pattern.compile(".*:id/button_add"))), 5000)
      ?: fail("picker add button", "button_add")
    add.click()

    photos.forEach { find("View " + it, 60) }
    Thread.sleep(1000)
    Screengrab.setDefaultScreenshotStrategy(UiAutomatorScreenshotStrategy())
    Screengrab.screenshot("1_album")
  }
}
