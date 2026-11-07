package io.justus.app

import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
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
import tools.fastlane.screengrab.FileWritingScreenshotCallback
import tools.fastlane.screengrab.Screengrab
import tools.fastlane.screengrab.ScreenshotCallback
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

    // The picker hands the app MediaStore ids, so tiles read "View 17.jpg", not the sample file names.
    val deadline = System.currentTimeMillis() + 60000
    while (device.findObjects(By.text(Pattern.compile("View .*\\.jpg"))).size < 3) {
      if (System.currentTimeMillis() > deadline) fail("photo tiles", "View")
      Thread.sleep(500)
    }
    Thread.sleep(1000)
    Screengrab.setDefaultScreenshotStrategy(UiAutomatorScreenshotStrategy())
    captioned("1_album", "Only people you accept see your photos")

    val tile = device.findObjects(By.text(Pattern.compile("View .*\\.jpg"))).first()
    tile.click()
    Thread.sleep(2000)
    captioned("2_photo", "You choose who joins. No cloud, no account")

    find("Close", 10).click()
    Thread.sleep(1000)
    var opened = false
    for (attempt in 1..4) {
      if (opened) break
      val invite = device.wait(Until.findObject(By.desc("Invite & members")), 10000) ?: fail("invite link", "Invite")
      invite.click()
      opened = device.wait(Until.hasObject(By.text(Pattern.compile("Copy (invite )?link"))), 5000)
      Thread.sleep(1000)
    }
    if (!opened) fail("invite page did not open", "Copy link")
    var tries = 0
    while (device.findObject(By.text(Pattern.compile("Copy (invite )?link"))) == null && tries++ < 6) {
      device.swipe(540, 1600, 540, 600, 20)
    }
    device.wait(Until.findObject(By.text(Pattern.compile("Copy (invite )?link"))), 5000) ?: fail("copy button", "Copy link")
    Thread.sleep(500)
    captioned("3_desktop", "Albums also open on desktop")
  }

  private fun captioned(name: String, caption: String) {
    val files = FileWritingScreenshotCallback(target.applicationContext, Screengrab.getLocale())
    Screengrab.screenshot(name, UiAutomatorScreenshotStrategy(), CaptionCallback(caption, files))
  }
}

// A plain caption band above the capture, which is scaled to fit under it.
private class CaptionCallback(private val caption: String, private val next: ScreenshotCallback) :
  ScreenshotCallback {
  override fun screenshotCaptured(screenshotName: String, screenshot: Bitmap) {
    val w = screenshot.width
    val h = screenshot.height
    val band = Math.round(h * 0.12f)
    val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    canvas.drawColor(Color.parseColor("#1B1B1F"))
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      typeface = Typeface.DEFAULT_BOLD
      textSize = band * 0.32f
      textAlign = Paint.Align.CENTER
    }
    while (paint.measureText(caption) > w * 0.9f) paint.textSize -= 1f
    canvas.drawText(caption, w / 2f, band / 2f - (paint.ascent() + paint.descent()) / 2f, paint)
    val scaledW = Math.round(w * (h - band).toFloat() / h)
    val scaled = Bitmap.createScaledBitmap(screenshot, scaledW, h - band, true)
    canvas.drawBitmap(scaled, (w - scaledW) / 2f, band.toFloat(), null)
    next.screenshotCaptured(screenshotName, out)
  }
}
