package com.aurora.vpn

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Hosts the same web UI as the desktop build. JS calls window.AuroraAndroid.call(cmd,
 * argsJson, id); the answer comes back through window.__auroraResolve(id, ok, value),
 * and service events through window.__auroraEmit(name, payload).
 */
class MainActivity : ComponentActivity() {

    lateinit var web: WebView
    private val pool = Executors.newCachedThreadPool()
    private lateinit var commands: Commands

    private var vpnLatch: CountDownLatch? = null
    @Volatile private var vpnGranted = false
    private val vpnLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        vpnGranted = VpnService.prepare(this) == null
        vpnLatch?.countDown()
    }

    private val events = Core.Listener { name, payload -> emit(name, payload) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        commands = Commands(this)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#05070F"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            // The page is https (asset loader); the cores' Clash API is plain http on 127.0.0.1.
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            overScrollMode = WebView.OVER_SCROLL_NEVER
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    loader.shouldInterceptRequest(request.url)
            }
            addJavascriptInterface(Bridge(), "AuroraAndroid")
        }
        // WebView ignores its own padding, so the system-bar insets go on a container.
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#05070F"))
            addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        setContentView(root)

        // Keep the UI clear of the status and navigation bars.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("window.__auroraBack ? window.__auroraBack() : false") { r ->
                    if (r != "true") moveTaskToBack(true)
                }
            }
        })

        Core.addListener(events)
        web.loadUrl("https://appassets.androidplatform.net/assets/web/index.html")
    }

    override fun onDestroy() {
        Core.removeListener(events)
        web.destroy()
        super.onDestroy()
    }

    inner class Bridge {
        @JavascriptInterface
        fun call(cmd: String, args: String, id: Int) {
            pool.execute {
                val res = runCatching { commands.handle(cmd, if (args.isBlank()) JSONObject() else JSONObject(args)) }
                res.fold(
                    onSuccess = { resolve(id, true, it) },
                    onFailure = { resolve(id, false, it.message ?: it.toString()) },
                )
            }
        }
    }

    private fun toJs(v: Any?): String = when (v) {
        null, Unit -> "null"
        is String -> JSONObject.quote(v)
        is Boolean, is Number -> v.toString()
        is JSONObject, is JSONArray -> v.toString()
        is Map<*, *> -> JSONObject(v).toString()
        is List<*> -> JSONArray(v).toString()
        else -> JSONObject.quote(v.toString())
    }

    private fun resolve(id: Int, ok: Boolean, value: Any?) {
        val js = "window.__auroraResolve && window.__auroraResolve($id, $ok, ${toJs(value)})"
        runOnUiThread { web.evaluateJavascript(js, null) }
    }

    fun emit(name: String, payload: Any?) {
        val js = "window.__auroraEmit && window.__auroraEmit(${JSONObject.quote(name)}, ${toJs(payload)})"
        runOnUiThread { if (!isDestroyed) web.evaluateJavascript(js, null) }
    }

    /** Asks for the VPN permission if needed; blocks the calling (worker) thread. */
    fun ensureVpnPermission(): Boolean {
        val intent = VpnService.prepare(this) ?: return true
        val latch = CountDownLatch(1)
        vpnLatch = latch
        vpnGranted = false
        runOnUiThread { vpnLauncher.launch(intent) }
        latch.await(120, TimeUnit.SECONDS)
        return vpnGranted
    }

    fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            runOnUiThread { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 3) }
        }
    }

    /** Runs a block on the UI thread and waits for its result. */
    fun <T> onUi(block: () -> T): T {
        var out: Result<T>? = null
        val latch = CountDownLatch(1)
        runOnUiThread {
            out = runCatching(block)
            latch.countDown()
        }
        latch.await(10, TimeUnit.SECONDS)
        return out!!.getOrThrow()
    }
}
