package com.aurora.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.service.quicksettings.TileService
import android.content.ComponentName
import libv2ray.CoreCallbackHandler
import libv2ray.CoreController
import libv2ray.Libv2ray
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.concurrent.thread

/**
 * Connection pipeline on Android:
 *
 *   apps -> VpnService TUN -> Xray (in-process, tun inbound) -> SOCKS 127.0.0.1:port
 *        -> sing-box (separate process: routing, DNS, all protocols) -> server
 *
 * The app itself is excluded from the VPN, so both cores reach the servers directly.
 * Keys that need Xray (XHTTP, mKCP) get an extra Xray SOCKS hop that sing-box chains to.
 */
class AuroraVpnService : VpnService() {

    companion object {
        const val ACTION_START = "com.aurora.vpn.START"
        const val ACTION_STOP = "com.aurora.vpn.STOP"
        private const val CHANNEL = "aurora"
        private const val NOTIF_ID = 7

        fun start(ctx: Context) {
            val i = Intent(ctx, AuroraVpnService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, AuroraVpnService::class.java).setAction(ACTION_STOP))
        }

        /** True when a previous connect left configs the tile can reuse. */
        fun hasLastConfig(ctx: Context) = File(Core.runDir(ctx), "meta.json").exists()
    }

    private var tun: ParcelFileDescriptor? = null
    private var singbox: Process? = null
    private var xray: CoreController? = null
    @Volatile private var stopping = false
    private var session = 0

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopAll(userStop = true)
                return START_NOT_STICKY
            }
            else -> {
                // null / android.net.VpnService: restarted by the system (after a crash, or
                // "Always-on VPN"). Reconnect with the last config if there is one.
                if (intent?.action != ACTION_START && !hasLastConfig(this)) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                if (Core.running || Core.connecting) return START_STICKY
                Core.connecting = true
                startForegroundCompat(buildNotification("Подключение…", ""))
                val my = ++session
                thread(name = "aurora-start") { startAll(my) }
            }
        }
        return START_STICKY
    }

    override fun onRevoke() {
        // Another VPN took over, or the user turned us off in system settings.
        Core.log("app", "VPN отключён системой")
        stopAll(userStop = false)
    }

    override fun onDestroy() {
        stopAll(userStop = true)
        super.onDestroy()
    }

    // ---------------------------------------------------------------- start

    private fun startAll(my: Int) {
        try {
            stopping = false
            Core.clearTail()
            Core.ensureRules(this)
            val run = Core.runDir(this)
            val meta = JSONObject(File(run, "meta.json").readText())
            val port = meta.getInt("port")

            // 1. sing-box as a local proxy.
            Core.killStrayCores()
            val exe = Core.singBox(this)
            val pb = ProcessBuilder(exe.absolutePath, "run", "-c", File(run, "singbox.json").absolutePath, "-D", run.absolutePath)
                .directory(run)
                .redirectErrorStream(true)
            val proc = pb.start()
            singbox = proc
            thread(name = "singbox-log") {
                // The stream closes when the process is destroyed: that is the normal end.
                try {
                    proc.inputStream.bufferedReader().forEachLine { Core.log("sing-box", it) }
                } catch (_: java.io.IOException) {
                }
            }
            if (!waitPort(port, proc, 6000)) {
                throw IllegalStateException("sing-box не запустился.\n${Core.tail(12)}")
            }

            // 2. TUN.
            val b = Builder()
                .setSession(meta.optString("name", "Aurora VPN"))
                .setMtu(1500)
                .addAddress("172.19.0.1", 30)
                .addRoute("0.0.0.0", 0)
                .addDnsServer("172.19.0.2")
                .addAddress("fdfe:dcba:9876::1", 126)
                .addRoute("::", 0)
            b.addDisallowedApplication(packageName)
            val bypass = meta.optJSONArray("bypass") ?: JSONArray()
            for (i in 0 until bypass.length()) {
                runCatching { b.addDisallowedApplication(bypass.getString(i)) }
            }
            if (Build.VERSION.SDK_INT >= 29) b.setMetered(false)
            val fd = b.establish() ?: throw IllegalStateException("Android не дал создать VPN (нет разрешения)")
            tun = fd

            // 3. Xray takes the TUN and feeds sing-box.
            Libv2ray.initCoreEnv(filesDir.absolutePath, "")
            val ctrl = Libv2ray.newCoreController(object : CoreCallbackHandler {
                override fun startup(): Long = 0
                override fun shutdown(): Long = 0
                override fun onEmitStatus(code: Long, msg: String?): Long {
                    if (!msg.isNullOrBlank()) Core.log("xray", msg)
                    return 0
                }
            })
            xray = ctrl
            ctrl.startLoop(xrayConfig(port, run), fd.fd)

            if (my != session) return
            Core.connecting = false
            Core.running = true
            notifyManager().notify(NOTIF_ID, buildNotification("Защищено", meta.optString("name")))
            Core.emit("vpn-state", JSONObject().put("running", true))
            refreshTile()
            watch(proc, my)
        } catch (e: Throwable) {
            Core.log("app", "Ошибка запуска: ${e.message}")
            val err = e.message ?: e.toString()
            stopAll(userStop = true)
            Core.emit("vpn-error", JSONObject().put("error", err))
        }
    }

    /** Xray config: TUN in, SOCKS to sing-box out; plus the optional Xray-only hop. */
    private fun xrayConfig(port: Int, run: File): String {
        val hopFile = File(run, "xray.json")
        val hop = if (hopFile.exists()) JSONObject(hopFile.readText()) else null
        val inbounds = JSONArray().put(
            JSONObject()
                .put("tag", "tun-in")
                .put("protocol", "tun")
                .put("settings", JSONObject().put("name", "xray0").put("MTU", 1500).put("userLevel", 0)),
        )
        val outbounds = JSONArray().put(
            JSONObject()
                .put("tag", "to-singbox")
                .put("protocol", "socks")
                .put("settings", JSONObject().put("servers", JSONArray().put(JSONObject().put("address", "127.0.0.1").put("port", port)))),
        )
        val rules = JSONArray().put(
            JSONObject().put("type", "field").put("inboundTag", JSONArray().put("tun-in")).put("outboundTag", "to-singbox"),
        )
        if (hop != null) {
            val hopIn = hop.getJSONArray("inbounds")
            for (i in 0 until hopIn.length()) inbounds.put(hopIn.get(i))
            val hopOut = hop.getJSONArray("outbounds")
            for (i in 0 until hopOut.length()) outbounds.put(hopOut.get(i))
            rules.put(JSONObject().put("type", "field").put("inboundTag", JSONArray().put("socks-in")).put("outboundTag", "proxy"))
        }
        return JSONObject()
            .put("log", JSONObject().put("loglevel", "warning"))
            .put("inbounds", inbounds)
            .put("outbounds", outbounds)
            .put("routing", JSONObject().put("domainStrategy", "AsIs").put("rules", rules))
            .toString()
    }

    private fun waitPort(port: Int, proc: Process, timeoutMs: Long): Boolean {
        val until = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < until) {
            if (!proc.isAlive) return false
            try {
                Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 300) }
                return true
            } catch (_: Exception) {
                Thread.sleep(150)
            }
        }
        return false
    }

    /** Reports an unexpected sing-box exit to the UI and tears the VPN down. */
    private fun watch(proc: Process, my: Int) = thread(name = "singbox-watch") {
        val code = runCatching { proc.waitFor() }.getOrDefault(-1)
        if (stopping || my != session) return@thread
        Core.log("app", "sing-box неожиданно завершился (код $code)")
        val tailText = Core.tail(12)
        stopAll(userStop = false)
        Core.emit("core-exit", JSONObject().put("name", "sing-box").put("code", code).put("tail", tailText))
    }

    // ---------------------------------------------------------------- stop

    @Synchronized
    private fun stopAll(userStop: Boolean) {
        stopping = true
        session++
        runCatching { xray?.stopLoop() }
        xray = null
        runCatching { singbox?.destroy() }
        singbox = null
        runCatching { tun?.close() }
        tun = null
        val was = Core.running || Core.connecting
        Core.running = false
        Core.connecting = false
        if (was) Core.emit("vpn-state", JSONObject().put("running", false).put("user", userStop))
        refreshTile()
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
        stopSelf()
    }

    // ---------------------------------------------------------------- notification

    private fun notifyManager() = getSystemService(NotificationManager::class.java)

    private fun buildNotification(title: String, text: String): Notification {
        val nm = notifyManager()
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "VPN", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, AuroraVpnService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        return b.setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Aurora VPN · $title")
            .setContentText(text)
            .setColor(0xFF29F2B8.toInt())
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Отключить", stop).build())
            .build()
    }

    private fun startForegroundCompat(n: Notification) {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    private fun refreshTile() {
        runCatching { TileService.requestListeningState(this, ComponentName(this, AuroraTileService::class.java)) }
    }
}
