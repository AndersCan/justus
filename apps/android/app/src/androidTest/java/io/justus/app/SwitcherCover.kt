package io.justus.app

import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.provider.MediaStore
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.File
import java.util.regex.Pattern
import org.junit.After
import org.junit.Before
import org.junit.Test

// With App lock on the app switcher must show no photo; with it off the photo shows.
// Shots go to <app external files>/switcher-cover; scripts/switcher-cover.sh checks them.
class SwitcherCover {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val device = UiDevice.getInstance(instrumentation)
  private val target = instrumentation.targetContext
  private val tile = Pattern.compile("View .*\\.jpg")

  @Before
  fun seedMarker() {
    device.executeShellCommand("locksettings set-pin 1111")
    val bitmap = Bitmap.createBitmap(1200, 900, Bitmap.Config.ARGB_8888)
    bitmap.eraseColor(Color.MAGENTA)
    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, "switcher-marker.jpg")
      put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
      put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Justus switcher")
      put(MediaStore.Images.Media.IS_PENDING, 1)
    }
    val resolver = target.contentResolver
    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
    resolver.openOutputStream(uri)!!.use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }
    values.clear()
    values.put(MediaStore.Images.Media.IS_PENDING, 0)
    resolver.update(uri, values, null, null)
  }

  @After
  fun clearPin() {
    device.executeShellCommand("locksettings clear --old 1111")
  }

  private fun find(text: String, seconds: Long): UiObject2 {
    val found = device.wait(Until.findObject(By.text(text)), seconds * 1000)
      ?: device.wait(Until.findObject(By.desc(text)), 1000)
    return found ?: fail("not found: $text", text)
  }

  private fun fail(message: String, text: String): Nothing {
    val hierarchy = java.io.ByteArrayOutputStream().also { device.dumpWindowHierarchy(it) }
    hierarchy.toString().chunked(3000).forEach { Log.e("SwitcherCover", it) }
    throw AssertionError(message + " [" + text + "]")
  }

  private fun typeInField(text: String) {
    val field = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 20000)
      ?: fail("no text field", text)
    field.click()
    device.executeShellCommand("input text " + text)
    device.pressEnter()
  }

  // The first tap can land before the web view binds its handlers, so tap Skip until the name field shows.
  private fun skipIntro() {
    repeat(5) {
      find("Skip", 60).click()
      if (device.wait(Until.hasObject(By.clazz("android.widget.EditText")), 5000)) return
    }
  }

  private fun launch(flags: Int) {
    val intent = target.packageManager.getLaunchIntentForPackage(target.packageName)!!.addFlags(flags)
    target.startActivity(intent)
  }

  private fun waitForTile() {
    val deadline = System.currentTimeMillis() + 60000
    while (device.findObjects(By.text(tile)).isEmpty()) {
      if (System.currentTimeMillis() > deadline) fail("photo tile", "View")
      Thread.sleep(500)
    }
  }

  private fun shot(name: String, fromHome: Boolean = false) {
    if (fromHome) device.pressHome()
    device.pressRecentApps()
    // The task card is the launcher's "snapshot" view, described "Justus". The launcher package name the
    // test reports differs from the one that draws the overview, so match on the view id.
    val card = By.res(Pattern.compile(".*:id/snapshot")).descContains("Justus")
    val inOverview = device.wait(Until.hasObject(card), 10000)
    if (!inOverview) fail("recents did not show the Justus task", "Justus")
    device.waitForIdle()
    val dir = File(target.getExternalFilesDir(null), "switcher-cover").apply { mkdirs() }
    val bitmap = instrumentation.uiAutomation.takeScreenshot()
    File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
  }

  @Test
  fun switcher() {
    launch(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    skipIntro()
    typeInField("Sam")
    find("Lock Justus?", 20)
    find("Enable", 5).click()
    Thread.sleep(1000)
    // The PIN pad takes the digits as key events; the Enter key submits only once the pad has them all.
    find("Unlock Justus", 20)
    device.executeShellCommand("input text 1111")
    find("PIN area", 5)
    device.executeShellCommand("input keyevent KEYCODE_ENTER")
    find("Start sharing", 20)
    typeInField("Switcher")
    find("No photos in this album yet.", 20)
    // The picker can open empty on a cold emulator: close it and open it again.
    var thumbs: List<UiObject2>? = null
    for (attempt in 1..3) {
      find("Add photos to Switcher", 20).click()
      Log.i("SwitcherCover", "picker attempt " + attempt)
      thumbs = device.wait(Until.findObjects(By.res(Pattern.compile(".*:id/icon_thumbnail"))), 10000)
        ?: device.wait(Until.findObjects(By.desc(Pattern.compile("Photo taken on .*"))), 10000)
      if (thumbs != null && thumbs.isNotEmpty()) break
      Log.i("SwitcherCover", "picker empty, pkg " + device.currentPackageName)
      // Back from Justus itself would leave the app: close only the picker.
      if (device.currentPackageName != target.packageName) device.pressBack()
      Thread.sleep(2000)
    }
    if (thumbs == null || thumbs.isEmpty()) fail("picker thumbnails", "icon_thumbnail")
    thumbs.first().click()
    Thread.sleep(500)
    val add = device.wait(Until.findObject(By.res(Pattern.compile(".*:id/button_add"))), 5000)
      ?: device.wait(Until.findObject(By.text(Pattern.compile("Add( .*)?"))), 5000)
      ?: fail("picker add button", "button_add")
    add.click()
    waitForTile()

    shot("switcher-lock-on")
    // Diagnostic: the snapshot path, Recents opened from the launcher rather than from the app.
    launch(Intent.FLAG_ACTIVITY_NEW_TASK)
    waitForTile()
    shot("switcher-lock-on-from-home", fromHome = true)

    device.executeShellCommand("locksettings clear --old 1111")
    launch(Intent.FLAG_ACTIVITY_NEW_TASK)
    waitForTile()
    shot("switcher-lock-off")
  }
}
