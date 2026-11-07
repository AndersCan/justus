package io.justus.app

import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.annotation.TargetApi
import android.provider.MediaStore
import android.util.Log
import android.view.WindowInsets
import android.view.WindowInsetsController
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.regex.Pattern
import org.junit.After
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

  // System UI demo mode: full battery, no notifications, fixed clock. Shell commands, so no app permission.
  private fun demo(vararg args: String) {
    device.executeShellCommand("am broadcast -a com.android.systemui.demo -e command " + args.joinToString(" "))
  }

  @Before
  fun cleanStatusBar() {
    device.executeShellCommand("settings put global sysui_demo_allowed 1")
    // Hiding the navigation bar otherwise shows the "Viewing full screen" overlay.
    device.executeShellCommand("settings put secure immersive_mode_confirmations confirmed")
    demo("enter")
    demo("clock -e hhmm 1200")
    demo("battery -e level 100 -e plugged false")
    demo("network -e wifi show -e level 4 -e mobile hide")
    demo("notifications -e visible false")
  }

  @After
  fun restoreStatusBar() {
    demo("exit")
  }

  // Dark status-bar icons (the app is light) and no gesture pill over the bottom tabs.
  @TargetApi(30)
  private fun cleanBars() {
    instrumentation.runOnMainSync {
      val activity = ActivityLifecycleMonitorRegistry.getInstance()
        .getActivitiesInStage(Stage.RESUMED).firstOrNull() ?: return@runOnMainSync
      val controller = activity.window.insetsController ?: return@runOnMainSync
      controller.setSystemBarsAppearance(
        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS,
        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
      )
      controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsets.Type.navigationBars())
    }
    Thread.sleep(500)
  }

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
    cleanBars()
    captioned("1_album", "Only people you accept see your photos")

    val tile = device.findObjects(By.text(Pattern.compile("View .*\\.jpg"))).first()
    tile.click()
    Thread.sleep(5000)
    // The viewer's name and Remove sit in a card under the photo: crop the shot above it.
    // The photo's alt text and the card's name both read "18.jpg"; the card is the lower one.
    // If the name is not exposed as text, fall back to a fixed 78% of the screen height.
    val card = device.findObjects(By.text(Pattern.compile("[0-9]+\\.jpg"))).maxByOrNull { it.visibleBounds.top }
    val density = target.resources.displayMetrics.density
    val cropAt = if (card != null) card.visibleBounds.top - Math.round(28 * density)
    else Math.round(device.displayHeight * 0.78f)
    captioned("3_photo", "Every photo at full size", cropAt)

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
    // A real request needs a second phone, so the owner's side is shown by the invite card,
    // which says they choose who gets in.
    captioned("2_invite", "You choose who joins. Nobody sees a photo until you accept")

    // Help is a row in Settings. It opens on "What is Justus?", which explains there is no
    // server in the middle.
    find("Settings", 10).click()
    find("Help", 10).click()
    find("What is Justus?", 10).click()
    Thread.sleep(1000)
    captioned("4_help", "No server in the middle. Photos go phone to phone")
  }

  private fun captioned(name: String, caption: String, cropBottomAt: Int? = null) {
    val files = FileWritingScreenshotCallback(target.applicationContext, Screengrab.getLocale())
    Screengrab.screenshot(name, UiAutomatorScreenshotStrategy(), CaptionCallback(caption, cropBottomAt, files))
  }
}

// A 1080x1920 opaque (RGB, no alpha) image: a caption band on top, the capture scaled to fit
// under it. Play wants 9:16 and no alpha. cropBottomAt cuts the capture at that pixel row.
private class CaptionCallback(
  private val caption: String,
  private val cropBottomAt: Int?,
  private val next: ScreenshotCallback
) : ScreenshotCallback {
  override fun screenshotCaptured(screenshotName: String, screenshot: Bitmap) {
    val w = 1080
    val h = 1920
    val band = Math.round(h * 0.12f)
    val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    out.setHasAlpha(false)
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
    val cropH = (cropBottomAt ?: screenshot.height).coerceIn(1, screenshot.height)
    val source = Bitmap.createBitmap(screenshot, 0, 0, screenshot.width, cropH)
    val scale = minOf((h - band).toFloat() / cropH, w.toFloat() / source.width)
    val scaledW = Math.round(source.width * scale)
    val scaledH = Math.round(cropH * scale)
    val scaled = Bitmap.createScaledBitmap(source, scaledW, scaledH, true)
    canvas.drawBitmap(scaled, (w - scaledW) / 2f, band.toFloat(), null)
    next.screenshotCaptured(screenshotName, out)
  }
}
