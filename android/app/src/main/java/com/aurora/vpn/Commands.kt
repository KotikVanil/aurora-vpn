package com.aurora.vpn

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Base64
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Android implementations of the commands the desktop build gets from Rust
 * (src-tauri/src/lib.rs). Names and argument names match, so the web UI is shared.
 */
class Commands(private val act: MainActivity) {

    private val ctx get() = act.applicationContext
    private val updateRepo = "KotikVanil/aurora-vpn"

    fun handle(cmd: String, a: JSONObject): Any? = when (cmd) {
        "get_paths" -> JSONObject()
            .put("data_dir", ctx.filesDir.absolutePath)
            .put("run_dir", Core.runDir(ctx).absolutePath)
            .put("rules_dir", Core.rulesDir(ctx).absolutePath)
            .put("singbox", Core.singBox(ctx).absolutePath)
            .put("xray", "")
        "load_state" -> File(ctx.filesDir, "state.json").let { if (it.exists()) it.readText() else "" }
        "save_state" -> {
            val tmp = File(ctx.filesDir, "state.json.tmp")
            tmp.writeText(a.getString("json"))
            tmp.renameTo(File(ctx.filesDir, "state.json"))
            null
        }
        "check_config" -> checkConfig(a.getString("singbox"))
        "start_core" -> startCore(a)
        "stop_core" -> stopCore()
        "core_running" -> Core.running
        "ping_servers" -> ping(a.getJSONArray("targets"))
        "fetch_subscription" -> fetchSubscription(
            a.getString("url"),
            a.optString("userAgent").takeIf { it.isNotEmpty() && it != "null" },
            if (a.isNull("viaProxy")) null else a.optInt("viaProxy"),
        )
        "get_hwid" -> Core.hwid(ctx)
        "latency_test" -> latencyTest(a.getString("config"), a.getJSONArray("tags"), a.getInt("port"))
        "exit_ip" -> exitIp(a.getInt("port"))
        "read_clipboard" -> act.onUi {
            val cm = ctx.getSystemService(ClipboardManager::class.java)
            cm.primaryClip?.getItemAt(0)?.coerceToText(ctx)?.toString() ?: ""
        }
        "write_clipboard" -> act.onUi {
            ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Aurora", a.getString("text")))
            null
        }
        "get_apps" -> installedApps()
        "get_version" -> BuildConfig.VERSION_NAME
        "check_update" -> httpGet("https://github.com/$updateRepo/releases/latest/download/version.json", null, 20000)
        "install_update" -> installUpdate(a.getString("url"))
        "open_url" -> {
            act.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(a.getString("url"))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            null
        }
        "open_vpn_settings" -> {
            act.startActivity(Intent(Settings.ACTION_VPN_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            null
        }
        "quit_app" -> {
            AuroraVpnService.stop(ctx)
            act.runOnUiThread { act.finishAndRemoveTask() }
            null
        }
        "is_admin" -> true
        "launch_flags" -> JSONArray()
        "get_autostart" -> false
        "cleanup_proxy", "set_tray_state", "set_autostart", "open_data_dir", "relaunch_admin" -> null
        else -> throw IllegalArgumentException("Команда $cmd недоступна на Android")
    }

    // ---------------------------------------------------------------- cores

    private fun runCapture(vararg args: String): Pair<Int, String> {
        val p = ProcessBuilder(*args).directory(Core.runDir(ctx)).redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().readText()
        return p.waitFor() to out.replace(Regex("\u001B\\[[0-9;]*[A-Za-z]"), "").trim()
    }

    private fun checkConfig(json: String): String {
        Core.ensureRules(ctx)
        val f = File(Core.runDir(ctx), "check.json").apply { writeText(json) }
        val (code, out) = runCapture(Core.singBox(ctx).absolutePath, "check", "-c", f.absolutePath)
        if (code != 0) throw IllegalStateException(out.ifEmpty { "sing-box check: код $code" })
        return out
    }

    private fun startCore(a: JSONObject): Any? {
        if (!act.ensureVpnPermission()) throw IllegalStateException("Нужно разрешить VPN-подключение для Aurora")
        act.askNotifications()
        if (Core.running) stopCore()
        val run = Core.runDir(ctx)
        val singbox = a.getString("singbox")
        checkConfig(singbox)
        File(run, "singbox.json").writeText(singbox)
        val hop = File(run, "xray.json")
        if (a.isNull("xray")) hop.delete() else hop.writeText(a.getString("xray"))
        File(run, "meta.json").writeText(
            JSONObject()
                .put("port", a.optInt("mixedPort", 2080))
                .put("name", a.optString("serverName", "Aurora VPN"))
                .put("bypass", a.optJSONArray("bypass") ?: JSONArray())
                .toString(),
        )

        // Wait for the service to report success or failure.
        val result = AtomicReference<String?>(null)
        val latch = CountDownLatch(1)
        val l = Core.Listener { name, payload ->
            if (name == "vpn-state" && (payload as JSONObject).optBoolean("running")) latch.countDown()
            if (name == "vpn-error") {
                result.set((payload as JSONObject).optString("error"))
                latch.countDown()
            }
        }
        Core.addListener(l)
        try {
            AuroraVpnService.start(ctx)
            if (!latch.await(20, TimeUnit.SECONDS)) throw IllegalStateException("VPN не ответил за 20 секунд.\n${Core.tail(10)}")
        } finally {
            Core.removeListener(l)
        }
        result.get()?.let { throw IllegalStateException(it) }
        return null
    }

    private fun stopCore(): Any? {
        AuroraVpnService.stop(ctx)
        val until = System.currentTimeMillis() + 4000
        while ((Core.running || Core.connecting) && System.currentTimeMillis() < until) Thread.sleep(100)
        return null
    }

    // ---------------------------------------------------------------- network helpers

    private fun ping(targets: JSONArray): JSONArray {
        val pool = Executors.newFixedThreadPool(24)
        val out = JSONArray()
        val futures = (0 until targets.length()).map { i ->
            val t = targets.getJSONObject(i)
            pool.submit<JSONObject> {
                val start = System.nanoTime()
                val ms = try {
                    Socket().use { it.connect(InetSocketAddress(t.getString("host"), t.getInt("port")), 3000) }
                    (System.nanoTime() - start) / 1_000_000
                } catch (_: Exception) {
                    null
                }
                JSONObject().put("id", t.getString("id")).put("ms", ms ?: JSONObject.NULL)
            }
        }
        futures.forEach { out.put(it.get(8, TimeUnit.SECONDS)) }
        pool.shutdown()
        return out
    }

    private fun open(url: String, proxyPort: Int?, timeout: Int): HttpURLConnection {
        val u = URL(url)
        val c = (if (proxyPort != null) u.openConnection(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", proxyPort))) else u.openConnection()) as HttpURLConnection
        c.connectTimeout = 8000
        c.readTimeout = timeout
        c.instanceFollowRedirects = true
        return c
    }

    private fun httpGet(url: String, proxyPort: Int?, timeout: Int): String {
        val c = open(url, proxyPort, timeout)
        c.setRequestProperty("User-Agent", "AuroraVPN-android")
        try {
            if (c.responseCode >= 400) throw IOException("HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader().readText()
        } finally {
            c.disconnect()
        }
    }

    private fun fetchSubscription(url: String, ua: String?, viaProxy: Int?): JSONObject {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            throw IllegalArgumentException("Ссылка подписки должна начинаться с http:// или https://")
        }
        val c = open(url, viaProxy, 25000)
        c.setRequestProperty("User-Agent", ua ?: "v2rayN/7.10")
        // The same headers Happ / Incy send; device-limited providers need them.
        c.setRequestProperty("x-hwid", Core.hwid(ctx))
        c.setRequestProperty("x-device-os", "Android")
        c.setRequestProperty("x-ver-os", Build.VERSION.RELEASE)
        c.setRequestProperty("x-device-model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
        try {
            val code = try {
                c.responseCode
            } catch (e: IOException) {
                throw IOException("NET: ${e.message}")
            }
            if (code >= 400) throw IOException("HTTP $code")
            val body = c.inputStream.bufferedReader().readText()
            val headers = JSONObject()
            for (name in listOf("subscription-userinfo", "profile-title", "profile-update-interval", "support-url", "profile-web-page-url", "announce")) {
                c.getHeaderField(name)?.let { headers.put(name, it) }
            }
            return JSONObject().put("body", body).put("headers", headers)
        } finally {
            c.disconnect()
        }
    }

    private fun exitIp(port: Int): String {
        val urls = listOf("https://ipwho.is/", "http://ip-api.com/json/?fields=status,country,countryCode,city,isp,query")
        var last: Exception? = null
        for (u in urls) {
            try {
                return httpGet(u, port, 10000)
            } catch (e: Exception) {
                last = e
            }
        }
        throw last ?: IOException("no answer")
    }

    /** Same real-delay test as the desktop: a throwaway sing-box with only outbounds. */
    private fun latencyTest(config: String, tags: JSONArray, port: Int): JSONObject {
        val run = Core.runDir(ctx)
        val f = File(run, "latency.json").apply { writeText(config) }
        val p = ProcessBuilder(Core.singBox(ctx).absolutePath, "run", "-c", f.absolutePath, "-D", run.absolutePath)
            .directory(run).redirectErrorStream(true).start()
        val result = JSONObject()
        try {
            val base = "http://127.0.0.1:$port"
            val until = System.currentTimeMillis() + 6000
            while (true) {
                if (!p.isAlive) throw IllegalStateException("Тест не запустился: ${p.inputStream.bufferedReader().readText().take(300)}")
                if (runCatching { httpGet("$base/version", null, 1000) }.isSuccess) break
                if (System.currentTimeMillis() > until) throw IllegalStateException("Тест не запустился: ядро не ответило")
                Thread.sleep(120)
            }
            val pool = Executors.newFixedThreadPool(16)
            val jobs = (0 until tags.length()).map { i ->
                val tag = tags.getString(i)
                pool.submit<Pair<String, Long?>> {
                    val url = "$base/proxies/$tag/delay?timeout=6000&url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204"
                    val ms = runCatching { JSONObject(httpGet(url, null, 9000)).optLong("delay", 0) }.getOrNull()?.takeIf { it > 0 }
                    tag to ms
                }
            }
            for (j in jobs) {
                val (tag, ms) = j.get(15, TimeUnit.SECONDS)
                result.put(tag, ms ?: JSONObject.NULL)
            }
            pool.shutdown()
        } finally {
            p.destroy()
        }
        return result
    }

    // ---------------------------------------------------------------- apps for split tunnel

    private fun installedApps(): JSONArray {
        val pm = ctx.packageManager
        val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
            .filter { it.packageName != ctx.packageName }
            .filter { pm.checkPermission(android.Manifest.permission.INTERNET, it.packageName) == PackageManager.PERMISSION_GRANTED }
        val out = JSONArray()
        apps.map { info ->
            val system = info.flags and ApplicationInfo.FLAG_SYSTEM != 0 && info.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP == 0
            Triple(info, pm.getApplicationLabel(info).toString(), system)
        }.sortedWith(compareBy({ it.third }, { it.second.lowercase() })).forEach { (info, label, system) ->
            out.put(
                JSONObject()
                    .put("package", info.packageName)
                    .put("label", label)
                    .put("system", system)
                    .put("icon", runCatching { iconData(pm.getApplicationIcon(info)) }.getOrDefault("")),
            )
        }
        return out
    }

    private fun iconData(d: android.graphics.drawable.Drawable): String {
        val size = 72
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        d.setBounds(0, 0, size, size)
        d.draw(c)
        val bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 90, it) }.toByteArray()
        return "data:image/png;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    // ---------------------------------------------------------------- updates

    private fun installUpdate(url: String): Any? {
        if (!url.startsWith("https://github.com/$updateRepo/")) throw IllegalArgumentException("Обновление можно скачать только из репозитория Aurora")
        if (Build.VERSION.SDK_INT >= 26 && !ctx.packageManager.canRequestPackageInstalls()) {
            act.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            throw IllegalStateException("Разреши Aurora устанавливать приложения и нажми «Обновить» ещё раз")
        }
        val dir = File(ctx.cacheDir, "updates").apply { mkdirs() }
        val apk = File(dir, "aurora.apk")
        val c = open(url, null, 60000)
        c.setRequestProperty("User-Agent", "AuroraVPN-android")
        try {
            if (c.responseCode >= 400) throw IOException("HTTP ${c.responseCode}")
            val total = c.contentLengthLong
            var done = 0L
            var last = 0L
            c.inputStream.use { input ->
                apk.outputStream().use { out ->
                    val buf = ByteArray(256 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        if (System.currentTimeMillis() - last > 150) {
                            last = System.currentTimeMillis()
                            Core.emit("update-progress", JSONObject().put("done", done).put("total", total.coerceAtLeast(0)))
                        }
                    }
                }
            }
            if (total > 0 && done < total) throw IOException("Обновление скачалось не полностью")
            Core.emit("update-progress", JSONObject().put("done", done).put("total", done))
        } finally {
            c.disconnect()
        }
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", apk)
        act.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        return null
    }
}
