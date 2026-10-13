package com.aurora.vpn

import android.annotation.SuppressLint
import android.content.Context
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Shared state between the VPN service, the UI bridge and the quick-settings tile.
 * Listeners get core logs, exits and status changes; the WebView turns them into
 * the same events the desktop (Tauri) build emits.
 */
object Core {
    fun interface Listener {
        fun onEvent(name: String, payload: Any?)
    }

    @Volatile var running = false
    @Volatile var connecting = false
    private val listeners = CopyOnWriteArraySet<Listener>()
    private val tail = ArrayDeque<String>()

    fun addListener(l: Listener) = listeners.add(l)
    fun removeListener(l: Listener) = listeners.remove(l)

    fun emit(name: String, payload: Any?) {
        for (l in listeners) runCatching { l.onEvent(name, payload) }
    }

    fun log(src: String, line: String) {
        val clean = line.replace(Regex("\u001B\\[[0-9;]*[A-Za-z]"), "").trimEnd()
        if (clean.isEmpty()) return
        synchronized(tail) {
            if (tail.size >= 300) tail.removeFirst()
            tail.addLast("[$src] $clean")
        }
        android.util.Log.i("Aurora", "[$src] $clean")
        emit("core-log", JSONObject().put("src", src).put("line", clean))
    }

    fun tail(n: Int): String = synchronized(tail) { tail.toList().takeLast(n).joinToString("\n") }
    fun clearTail() = synchronized(tail) { tail.clear() }

    // ---------------------------------------------------------------- paths

    fun runDir(ctx: Context): File = File(ctx.filesDir, "run").apply { mkdirs() }
    fun rulesDir(ctx: Context): File = File(ctx.filesDir, "rules")
    fun singBox(ctx: Context): File = File(ctx.applicationInfo.nativeLibraryDir, "libsingbox.so")

    /** Rule sets ship in assets; sing-box needs real files. */
    fun ensureRules(ctx: Context) {
        val dir = rulesDir(ctx).apply { mkdirs() }
        for (name in ctx.assets.list("rules").orEmpty()) {
            val out = File(dir, name)
            if (out.exists() && out.length() > 0) continue
            ctx.assets.open("rules/$name").use { i -> out.outputStream().use { i.copyTo(it) } }
        }
    }

    /**
     * A sing-box left behind by a crashed app process keeps holding the proxy port.
     * Same uid, so we may kill it: find it through /proc.
     */
    fun killStrayCores() {
        val me = android.os.Process.myPid()
        File("/proc").listFiles()?.forEach { dir ->
            val pid = dir.name.toIntOrNull() ?: return@forEach
            if (pid == me) return@forEach
            val cmd = runCatching { File(dir, "cmdline").readText() }.getOrNull() ?: return@forEach
            if (cmd.contains("libsingbox.so")) {
                android.os.Process.killProcess(pid)
                log("app", "Остановлен старый процесс sing-box ($pid)")
            }
        }
    }

    // ---------------------------------------------------------------- device id

    private fun fnv1a(s: String): ULong {
        var h = 0xcbf29ce484222325uL
        for (b in s.toByteArray()) {
            h = h xor (b.toUByte().toULong())
            h *= 0x100000001b3uL
        }
        return h
    }

    /**
     * Stable device id for providers with a device limit (Remnawave HWID), the same
     * scheme as the desktop build but seeded from ANDROID_ID.
     */
    @SuppressLint("HardwareIds")
    fun hwid(ctx: Context): String {
        val id = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: "aurora-fallback"
        return "%016x%016x".format(fnv1a("aurora-hwid-a:$id").toLong(), fnv1a("aurora-hwid-b:$id").toLong())
    }
}
