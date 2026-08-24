package io.justus.app

import android.annotation.SuppressLint
import android.net.Uri
import android.provider.OpenableColumns
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import to.holepunch.bare.android.BareWebViewClient
import to.holepunch.bare.android.ErrorCodes
import to.holepunch.bare.android.HostIpcCoordinator
import to.holepunch.bare.android.HostPluginRegistry
import to.holepunch.bare.android.registerDefaultHostPlugins
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet
import java.io.File

/**
 * Justus Android host: starts the Bare worklet (apps/backend bundle), wires
 * the vendor.media pick/capture host plugins, and loads the built web app from
 * the worklet's loopback server (cookie auth via the handoff token).
 */
class MainActivity : AppCompatActivity() {
    private lateinit var worklet: Worklet
    private lateinit var ipc: IPC
    private lateinit var webView: WebView
    private val hostPlugins = HostPluginRegistry()
    private lateinit var storageDir: File
    private lateinit var webappDir: File
    private val mainHandler = Handler(Looper.getMainLooper())

    // Debug builds get a much longer handoff window so slow cold emulator boots (AAR + worklet
    // bundle) don't make the WebView give up before handoff.json appears (release keeps 15s).
    private val handoffTimeoutMs: Long =
        if (BuildConfig.DEBUG) 90_000L else 15_000L

    private lateinit var pickLauncher: ActivityResultLauncher<PickVisualMediaRequest>
    private lateinit var imageCaptureLauncher: ActivityResultLauncher<Uri>
    private lateinit var videoCaptureLauncher: ActivityResultLauncher<Uri>
    @Volatile
    private var pendingMedia: ((HostPluginRegistry.HostInvokeOutcome) -> Unit)? = null
    @Volatile
    private var pendingCaptureFile: File? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // bare-fs cannot read APK assets by path — copy the built web app out
        // of assets/ into the cache dir for the worklet to serve over loopback.
        storageDir = File(cacheDir, "bare").apply { mkdirs() }
        webappDir = File(cacheDir, "webapp")
        copyWebAssets(webappDir)

        // A previous run may have left a handoff file pointing at a dead
        // ephemeral port; remove it so polling never loads a stale origin.
        File(storageDir, "handoff.json").delete()

        worklet = Worklet(
            Worklet.Options()
                .memoryLimit(128 * 1024 * 1024)
                .assets(File(storageDir, "asset-cache").absolutePath),
        )

        try {
            assets.open("main.core.bundle").use { bundleStream ->
                worklet.start(
                    "/main.core.bundle",
                    bundleStream,
                    arrayOf(webappDir.absolutePath, storageDir.absolutePath),
                )
            }
            ipc = IPC(worklet)
            registerDefaultHostPlugins(hostPlugins)
            registerMediaHostPlugins(hostPlugins)
            HostIpcCoordinator(ipc, hostPlugins).start()
        } catch (e: Exception) {
            Log.e("JUSTUS_ANDROID", "Failed to start worklet", e)
        }

        webView = findViewById(R.id.webview)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        webView.webViewClient = BareWebViewClient()

        // Maestro drives WebView content via Chrome DevTools; only meaningful in debug.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        waitForHandoffAndLoad()

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (!::webView.isInitialized) {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        return
                    }
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            },
        )
    }

    /** Polls the worklet's `handoff.json`, injects the session token, loads the
     * page from the loopback origin. */
    private fun waitForHandoffAndLoad() {
        val handoff = File(storageDir, "handoff.json")
        val deadline = System.currentTimeMillis() + handoffTimeoutMs
        fun poll() {
            val text = if (handoff.exists()) handoff.readText() else null
            if (text != null) {
                try {
                    val json = JSONObject(text)
                    val origin = json.getString("origin")
                    val port = json.getInt("port")
                    val token = json.getString("token")
                    WebViewCompat.addDocumentStartJavaScript(
                        webView,
                        "window.__ekrooh={token:${JSONObject.quote(token)}};window.BareShell=true;",
                        setOf("http://127.0.0.1:$port"),
                    )
                    webView.loadUrl("$origin/index.html")
                    return
                } catch (e: Exception) {
                    Log.e("JUSTUS_ANDROID", "Handoff malformed", e)
                }
            }
            if (System.currentTimeMillis() < deadline) {
                mainHandler.postDelayed({ poll() }, 100)
            } else {
                Log.e("JUSTUS_ANDROID", "Timed out waiting for worklet handoff file")
            }
        }
        poll()
    }

    /** Copies `index.html` and the `assets/` directory out of the APK so the
     * worklet can serve them from the filesystem. */
    private fun copyWebAssets(destDir: File) {
        destDir.deleteRecursively()
        destDir.mkdirs()
        try {
            assets.open("index.html").use { input ->
                File(destDir, "index.html").outputStream().use { input.copyTo(it) }
            }
            copyAssetTree("assets", destDir)
        } catch (e: Exception) {
            Log.e("JUSTUS_ANDROID", "Failed to copy web assets", e)
        }
    }

    private fun copyAssetTree(prefix: String, destDir: File) {
        val names = assets.list(prefix) ?: return
        for (name in names) {
            val assetPath = if (prefix.isEmpty()) name else "$prefix/$name"
            val dest = File(destDir, assetPath)
            val children = assets.list(assetPath)
            if (children != null && children.isNotEmpty()) {
                dest.mkdirs()
                copyAssetTree(assetPath, destDir)
            } else {
                try {
                    assets.open(assetPath).use { input ->
                        dest.parentFile?.mkdirs()
                        dest.outputStream().use { input.copyTo(it) }
                    }
                } catch (e: java.io.FileNotFoundException) {
                    dest.mkdirs()
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        mainHandler.removeCallbacksAndMessages(null)
        if (::ipc.isInitialized) ipc.close()
        if (::worklet.isInitialized) worklet.terminate()
    }

    /** vendor.media host handlers: pick/capture natively, return a filesystem
     * path the worklet serves over loopback. */
    private fun registerMediaHostPlugins(registry: HostPluginRegistry) {
        pickLauncher = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            val respond = pendingMedia ?: return@registerForActivityResult
            pendingMedia = null
            if (uri == null) {
                respond(
                    HostPluginRegistry.HostInvokeOutcome.Fail(
                        ErrorCodes.HOST_ERROR,
                        "Media pick cancelled",
                    ),
                )
                return@registerForActivityResult
            }
            val staged = copyUriToCache(uri)
            if (staged == null) {
                respond(
                    HostPluginRegistry.HostInvokeOutcome.Fail(
                        ErrorCodes.HOST_ERROR,
                        "Failed to copy picked media",
                    ),
                )
            } else {
                val json = JSONObject().put("path", staged.path)
                if (staged.name != null) json.put("name", staged.name)
                respond(HostPluginRegistry.HostInvokeOutcome.Ok(json))
            }
        }
        imageCaptureLauncher = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
            finishCapture(ok)
        }
        videoCaptureLauncher =
            registerForActivityResult(ActivityResultContracts.TakeVideo()) { thumbnail ->
                finishCapture(thumbnail != null)
            }

        registry.register("vendor.media", "media.pick") { args, _, respond ->
            val kind = args?.optString("kind") ?: "image"
            pendingMedia = respond
            val selector =
                if (kind == "video") {
                    ActivityResultContracts.PickVisualMedia.VideoOnly
                } else {
                    ActivityResultContracts.PickVisualMedia.ImageOnly
                }
            mainHandler.post { pickLauncher.launch(PickVisualMediaRequest(selector)) }
        }
        registry.register("vendor.media", "media.capture") { args, _, respond ->
            val kind = args?.optString("kind") ?: "image"
            pendingMedia = respond
            val ext = if (kind == "video") ".mp4" else ".jpg"
            val file = File(cacheDir, "capture-${System.currentTimeMillis()}$ext")
            pendingCaptureFile = file
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            mainHandler.post {
                if (kind == "video") videoCaptureLauncher.launch(uri) else imageCaptureLauncher.launch(uri)
            }
        }
    }

    private fun finishCapture(success: Boolean) {
        val respond = pendingMedia ?: return
        pendingMedia = null
        val file = pendingCaptureFile ?: return
        pendingCaptureFile = null
        if (success && file.exists() && file.length() > 0L) {
            respond(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("path", file.absolutePath)))
        } else {
            respond(
                HostPluginRegistry.HostInvokeOutcome.Fail(
                    ErrorCodes.HOST_ERROR,
                    "Capture cancelled or failed",
                ),
            )
        }
    }

    /** Copies a picker content:// URI into the app cache so the worklet can
     * serve it from the filesystem. */
    private data class StagedMedia(val path: String, val name: String?)

    private fun copyUriToCache(uri: Uri): StagedMedia? {
        return try {
            // Preserve the real media type from the content MIME subtype instead
            // of forcing .jpg/.mp4 by class: a picked PNG/WebP/HEIC must keep its
            // own extension so the loopback spool serves it with the right content
            // type (#102). The native capture path encodes to JPEG/MP4 explicitly,
            // so only the picker (which copies the original bytes) needs this.
            val ext =
                contentResolver.getType(uri)?.let { mime ->
                    val sub = mime.substringAfter("/", "")
                    if (sub.isNotEmpty() && !sub.contains('*')) ".$sub" else null
                } ?: ".bin"
            val dest = File(cacheDir, "media-${System.currentTimeMillis()}$ext")
            val copied =
                contentResolver.openInputStream(uri)?.use { input ->
                    dest.outputStream().use { output -> input.copyTo(output) }
                }
            if (copied == null) {
                null
            } else {
                // Thread the picker's original display name through (#99) so the
                // stored photo keeps the user's file name rather than the temp
                // staging name. Some providers omit DISPLAY_NAME — the backend
                // falls back to the basename in that case.
                val name =
                    contentResolver
                        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                        ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
                StagedMedia(dest.absolutePath, name)
            }
        } catch (e: Exception) {
            Log.e("JUSTUS_ANDROID", "Failed to copy picked media", e)
            null
        }
    }
}
