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
import org.json.JSONArray
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Justus Android host: starts the Bare worklet (apps/backend bundle), wires
 * the vendor.media and justus.media pick/capture host plugins, and loads the built web app from
 * the worklet's loopback server (cookie auth via the handoff bootstrap nonce).
 */
class MainActivity : AppCompatActivity() {
    private lateinit var worklet: Worklet
    private lateinit var ipc: IPC
    private lateinit var webView: WebView
    private val webViewClient = BareWebViewClient()
    private val hostPlugins = HostPluginRegistry()
    private lateinit var storageDir: File
    private lateinit var webappDir: File
    private val mainHandler = Handler(Looper.getMainLooper())

    // Debug builds get a much longer handoff window so slow cold emulator boots (AAR + worklet
    // bundle) don't make the WebView give up before handoff.json appears (release keeps 15s).
    private val handoffTimeoutMs: Long =
        if (BuildConfig.DEBUG) 90_000L else 15_000L

    private lateinit var pickLauncher: ActivityResultLauncher<PickVisualMediaRequest>
    private lateinit var pickManyLauncher: ActivityResultLauncher<PickVisualMediaRequest>
    private lateinit var imageCaptureLauncher: ActivityResultLauncher<Uri>
    private lateinit var videoCaptureLauncher: ActivityResultLauncher<Uri>
    @Volatile
    private var pendingMedia: ((HostPluginRegistry.HostInvokeOutcome) -> Unit)? = null
    @Volatile
    private var pendingCaptureFile: File? = null
    @Volatile
    private var pendingCaptureName = false

    /** Picked/captured files are staged here: inside the worklet's storage dir,
     * which (with no third argv dir) is also its cache dir and therefore an
     * allowed `photos.add` import root (#93/#97). Cleared on every launch. */
    private lateinit var importsDir: File

    /** Copies picked files off the main thread (a batch can be many MB). */
    private val stagingExecutor = Executors.newSingleThreadExecutor()

    // A justus://join/... link that opened the app before the page loaded;
    // handed to the web layer as window.__justusInvite at document start.
    private var pendingInvite: String? = null
    private var pageLoaded = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        pendingInvite = inviteFrom(intent)

        // bare-fs cannot read APK assets by path — copy the built web app out
        // of assets/ into the cache dir for the worklet to serve over loopback.
        storageDir = File(cacheDir, "bare").apply { mkdirs() }
        importsDir = File(storageDir, "imports")
        importsDir.deleteRecursively()
        importsDir.mkdirs()
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
        // The page is served over loopback HTTP; it never needs file:// or
        // content:// access, so a hostile document cannot reach them either.
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.webViewClient = webViewClient

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

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        val invite = inviteFrom(intent) ?: return
        if (pageLoaded) {
            // The web layer listens for this and shows the join consent sheet.
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('justus:invite',{detail:${JSONObject.quote(invite)}}))",
                null,
            )
        } else {
            pendingInvite = invite
        }
    }

    private fun inviteFrom(intent: android.content.Intent?): String? =
        if (intent?.action == android.content.Intent.ACTION_VIEW && intent.data?.scheme == "justus") {
            intent.dataString
        } else {
            null
        }

    /** Polls the worklet's `handoff.json`, injects the one-time bootstrap nonce, loads the
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
                    val bootstrap = json.getString("bootstrap")
                    WebViewCompat.addDocumentStartJavaScript(
                        webView,
                        "window.__ekrooh={bootstrap:${JSONObject.quote(bootstrap)}};window.BareShell=true;" +
                            (pendingInvite?.let { "window.__justusInvite=${JSONObject.quote(it)};" } ?: ""),
                        setOf("http://127.0.0.1:$port"),
                    )
                    pendingInvite = null
                    // Confine the WebView to this origin before the first load.
                    webViewClient.allowedOrigin = "http://127.0.0.1:$port"
                    webView.loadUrl("$origin/index.html")
                    pageLoaded = true
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
        stagingExecutor.shutdown()
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
            stagingExecutor.execute {
                // Answer on the main thread, where the picker callback started.
                val reply = { o: HostPluginRegistry.HostInvokeOutcome -> mainHandler.post { respond(o) } }
                val staged = copyUriToCache(uri)
                if (staged == null) {
                    reply(
                        HostPluginRegistry.HostInvokeOutcome.Fail(
                            ErrorCodes.HOST_ERROR,
                            "Failed to copy picked media",
                        ),
                    )
                } else {
                    reply(HostPluginRegistry.HostInvokeOutcome.Ok(staged.toJson()))
                }
            }
        }
        // justus.media pickMany: the system picker in multi-select mode. Each
        // URI is staged in turn; any that fail to copy are dropped, and the
        // invoke only fails when nothing could be staged.
        pickManyLauncher =
            registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_PICK)) { uris ->
                val respond = pendingMedia ?: return@registerForActivityResult
                pendingMedia = null
                if (uris.isEmpty()) {
                    respond(
                        HostPluginRegistry.HostInvokeOutcome.Fail(
                            ErrorCodes.HOST_ERROR,
                            "Media pick cancelled",
                        ),
                    )
                    return@registerForActivityResult
                }
                stagingExecutor.execute {
                    // Answer on the main thread, where the picker callback started.
                    val reply = { o: HostPluginRegistry.HostInvokeOutcome -> mainHandler.post { respond(o) } }
                    val items = JSONArray()
                    for (uri in uris) copyUriToCache(uri)?.let { items.put(it.toJson()) }
                    if (items.length() == 0) {
                        reply(
                            HostPluginRegistry.HostInvokeOutcome.Fail(
                                ErrorCodes.HOST_ERROR,
                                "Failed to copy picked media",
                            ),
                        )
                    } else {
                        reply(HostPluginRegistry.HostInvokeOutcome.Ok(JSONObject().put("items", items)))
                    }
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
            launchCapture(args?.optString("kind") ?: "image", respond, named = false)
        }
        registry.register("justus.media", "media.pickMany") { _, _, respond ->
            pendingMedia = respond
            val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
            mainHandler.post { pickManyLauncher.launch(request) }
        }
        registry.register("justus.media", "media.capture") { args, _, respond ->
            launchCapture(args?.optString("kind") ?: "image", respond, named = true)
        }
    }

    /** Opens the camera, writing straight into the imports dir. `named` adds
     * a dated display name (justus.media) so the photo isn't called
     * `capture-<millis>.jpg`. */
    private fun launchCapture(
        kind: String,
        respond: (HostPluginRegistry.HostInvokeOutcome) -> Unit,
        named: Boolean,
    ) {
        pendingMedia = respond
        pendingCaptureName = named
        val ext = if (kind == "video") ".mp4" else ".jpg"
        val file = File(importsDir, "capture-${System.currentTimeMillis()}$ext")
        pendingCaptureFile = file
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        mainHandler.post {
            if (kind == "video") videoCaptureLauncher.launch(uri) else imageCaptureLauncher.launch(uri)
        }
    }

    private fun finishCapture(success: Boolean) {
        val respond = pendingMedia ?: return
        pendingMedia = null
        val file = pendingCaptureFile ?: return
        pendingCaptureFile = null
        if (success && file.exists() && file.length() > 0L) {
            val json = JSONObject().put("path", file.absolutePath)
            if (pendingCaptureName) {
                val stamp = java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.US)
                    .format(java.util.Date())
                json.put("name", "IMG_$stamp.${file.extension}")
            }
            respond(HostPluginRegistry.HostInvokeOutcome.Ok(json))
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
    private data class StagedMedia(val path: String, val name: String?) {
        fun toJson(): JSONObject = JSONObject().put("path", path).apply { if (name != null) put("name", name) }
    }

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
            // A UUID, not a timestamp: a batch stages many files per millisecond.
            val dest = File(importsDir, "media-${UUID.randomUUID()}$ext")
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

    private companion object {
        /** Mirrors `MAX_PICK` in packages/core/src/media/events.ts. */
        const val MAX_PICK = 50
    }
}
