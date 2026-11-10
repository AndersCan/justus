package io.justus.app

import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.annotation.TargetApi
import android.provider.MediaStore
import android.util.Log
import android.view.WindowInsets
import android.view.WindowInsetsController
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.File
import java.util.regex.Pattern
import org.junit.After
import org.junit.Before
import org.junit.Test
import tools.fastlane.screengrab.Screengrab
import tools.fastlane.screengrab.ScreenshotCallback
import tools.fastlane.screengrab.UiAutomatorScreenshotStrategy

// Raw full-screen captures for the images in store-listing/: no caption, no scaling, so the
// store page never has to enlarge them. Separate from ListingScreenshots, which feeds the
// release. Files go to <app external files>/store-captures; android-device.yml pulls them.
class StoreCaptures {
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
    device.executeShellCommand("settings put secure immersive_mode_confirmations confirmed")
    demo("enter")
    demo("clock -e hhmm 1200")
    demo("battery -e level 100 -e plugged false")
    demo("network -e wifi show -e level 4 -e fully true -e mobile hide")
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
    hierarchy.toString().chunked(3000).forEach { Log.e("StoreCaptures", it) }
    throw AssertionError(message + " [" + text + "]")
  }

  // The fields are web inputs whose label is only a hint, so take the one EditText on screen.
  private fun typeInField(text: String) {
    val field = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 20000)
      ?: fail("no text field", text)
    field.click()
    type(text)
  }

  // The first tap can land before the web view binds its handlers, so tap Skip until the name field shows.
  private fun skipIntro() {
    repeat(5) {
      find("Skip", 60).click()
      if (device.wait(Until.hasObject(By.clazz("android.widget.EditText")), 5000)) return
    }
  }

  private fun type(text: String) {
    device.executeShellCommand("input text " + text)
    device.pressEnter()
  }

  private fun swipeUp() {
    device.swipe(device.displayWidth / 2, device.displayHeight * 3 / 4, device.displayWidth / 2, device.displayHeight / 4, 20)
    Thread.sleep(500)
  }

  @Test
  fun captures() {
    val intent = target.packageManager.getLaunchIntentForPackage(target.packageName)!!
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    target.startActivity(intent)
    skipIntro()
    typeInField("Sam")
    find("Start sharing", 20)
    typeInField("Summer%s2026")
    find("No photos in this album yet.", 20)
    // The picker can open empty on a cold emulator: close it and open it again.
    var thumbs: List<UiObject2>? = null
    for (attempt in 1..3) {
      find("Add photos to Summer 2026", 20).click()
      // The older picker ids its thumbnails; the newer Compose picker only describes them "Photo taken on ...".
      thumbs = device.wait(Until.findObjects(By.res(Pattern.compile(".*:id/icon_thumbnail"))), 10000)
        ?: device.wait(Until.findObjects(By.desc(Pattern.compile("Photo taken on .*"))), 10000)
      if (thumbs != null && thumbs.size >= 3) break
      device.pressBack()
      Thread.sleep(2000)
    }
    if (thumbs == null || thumbs.size < 3) {
      fail("picker thumbnails: " + thumbs?.size, "icon_thumbnail")
    }
    thumbs.take(3).forEach { it.click(); Thread.sleep(500) }
    val add = device.wait(Until.findObject(By.res(Pattern.compile(".*:id/button_add"))), 5000)
      ?: device.wait(Until.findObject(By.text(Pattern.compile("Add( .*)?"))), 5000)
      ?: fail("picker add button", "button_add")
    add.click()

    // The picker hands the app MediaStore ids, so tiles read "View 17.jpg", not the sample file names.
    val deadline = System.currentTimeMillis() + 60000
    while (device.findObjects(By.text(Pattern.compile("View .*\\.jpg"))).size < 3) {
      if (System.currentTimeMillis() > deadline) fail("photo tiles", "View")
      Thread.sleep(500)
    }
    Thread.sleep(1000)
    cleanBars()
    capture("album")

    device.findObjects(By.text(Pattern.compile("View .*\\.jpg"))).first().click()
    Thread.sleep(5000)
    capture("photo")

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
    capture("invite")

    // The App lock card appears after a status read, and the tap on Settings can land before the web view
    // binds its handlers: on a miss go to Photos and back to Settings.
    var locked = false
    for (attempt in 1..4) {
      try {
        find("Settings", 10).click()
      } catch (e: StaleObjectException) {
        continue
      }
      locked = device.wait(Until.hasObject(By.text(Pattern.compile("Require unlock to open Justus.*"))), 10000)
      if (locked) break
      try {
        find("Photos", 10).click()
      } catch (e: StaleObjectException) {
        continue
      }
      Thread.sleep(1000)
    }
    if (!locked) fail("settings did not show App lock", "Require unlock")
    // Scroll once so the whole App lock card is on screen, then assert the switch right before the capture:
    // the card can disappear while the status reloads, so retry the assert, not the test.
    // A short swipe (about 700 px) keeps the Profile card clear of the status bar.
    device.swipe(device.displayWidth / 2, device.displayHeight * 3 / 4, device.displayWidth / 2, device.displayHeight * 3 / 4 - 760, 20)
    Thread.sleep(500)
    var lockShown = false
    for (attempt in 1..10) {
      lockShown = device.hasObject(By.text(Pattern.compile("Require unlock to open Justus.*")))
      if (lockShown) break
      Thread.sleep(1000)
    }
    if (!lockShown) fail("App lock switch not visible before the settings capture", "Require unlock")
    capture("settings")

    // Help is a row below App lock, possibly under the fold.
    repeat(4) {
      if (device.findObject(By.text("Help")) == null) swipeUp()
    }
    find("Help", 10).click()
    find("What is Justus?", 10).click()
    Thread.sleep(1000)
    capture("help")
  }

  private fun capture(name: String) {
    val dir = File(target.getExternalFilesDir(null), "store-captures").apply { mkdirs() }
    Screengrab.screenshot(name, UiAutomatorScreenshotStrategy(), ScreenshotCallback { shotName, bitmap ->
      File(dir, "$shotName.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    })
  }
}
