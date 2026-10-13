//! Aurora VPN backend.
//!
//! The frontend parses keys and builds core configs. This side owns everything that
//! touches the OS: spawning sing-box / Xray, the Windows system proxy, the tray,
//! TCP pings, subscription downloads and persistent state.

use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader, Read},
    net::{TcpStream, ToSocketAddrs},
    os::windows::{io::AsRawHandle, process::CommandExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    path::BaseDirectory,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State, WindowEvent,
};
use winreg::{enums::*, RegKey};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const INET_SETTINGS: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_NAME: &str = "AuroraVPN";
const TRAY_ON: &[u8] = include_bytes!("../icons/tray-on.png");
const TRAY_OFF: &[u8] = include_bytes!("../icons/tray-off.png");

struct CoreProc {
    name: &'static str,
    child: Child,
}

#[derive(Default)]
struct Inner {
    procs: Vec<CoreProc>,
    proxy_port: Option<u16>,
    session: u64,
}

struct AppState {
    inner: Mutex<Inner>,
    logs: Arc<Mutex<VecDeque<String>>>,
    quitting: AtomicBool,
    job: isize,
}

#[derive(Clone, Serialize)]
struct LogLine {
    src: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct CoreExit {
    name: String,
    code: Option<i32>,
    tail: String,
}

// ---------------------------------------------------------------- helpers

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn create_job() -> isize {
    use windows_sys::Win32::System::JobObjects::*;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job as isize == 0 {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        job as isize
    }
}

fn attach_to_job(job: isize, child: &Child) {
    if job == 0 {
        return;
    }
    unsafe {
        windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(
            job as _,
            child.as_raw_handle() as _,
        );
    }
}

fn refresh_inet() {
    use windows_sys::Win32::Networking::WinInet::InternetSetOptionW;
    unsafe {
        // INTERNET_OPTION_SETTINGS_CHANGED = 39, INTERNET_OPTION_REFRESH = 37
        InternetSetOptionW(std::ptr::null(), 39, std::ptr::null(), 0);
        InternetSetOptionW(std::ptr::null(), 37, std::ptr::null(), 0);
    }
}

fn apply_system_proxy(port: Option<u16>) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(INET_SETTINGS).map_err(|e| e.to_string())?;
    match port {
        Some(p) => {
            key.set_value("ProxyEnable", &1u32).map_err(|e| e.to_string())?;
            key.set_value("ProxyServer", &format!("127.0.0.1:{p}"))
                .map_err(|e| e.to_string())?;
            key.set_value(
                "ProxyOverride",
                &"localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>",
            )
            .map_err(|e| e.to_string())?;
        }
        None => {
            key.set_value("ProxyEnable", &0u32).map_err(|e| e.to_string())?;
        }
    }
    refresh_inet();
    Ok(())
}

/// Turns the system proxy off only when it still points at our local port.
fn clear_our_proxy(port: u16) {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey(INET_SETTINGS) {
        let server: String = key.get_value("ProxyServer").unwrap_or_default();
        let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
        if enabled == 1 && server == format!("127.0.0.1:{port}") {
            let _ = apply_system_proxy(None);
        }
    }
}

fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("aurora-vpn"));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Finds a bundled file: installed resources, next to the exe, or the dev tree.
fn resource(app: &AppHandle, rel: &str) -> PathBuf {
    let mut candidates = Vec::new();
    if let Ok(p) = app.path().resolve(rel, BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(rel));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel));
    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .unwrap_or_else(|| candidates.last().cloned().unwrap())
}

fn slash(p: &PathBuf) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn push_log(logs: &Arc<Mutex<VecDeque<String>>>, line: String) {
    let mut l = logs.lock().unwrap();
    if l.len() >= 400 {
        l.pop_front();
    }
    l.push_back(line);
}

fn log_tail(logs: &Arc<Mutex<VecDeque<String>>>, n: usize) -> String {
    let l = logs.lock().unwrap();
    let skip = l.len().saturating_sub(n);
    l.iter().skip(skip).cloned().collect::<Vec<_>>().join("\n")
}

fn pipe_logs<R: Read + Send + 'static>(
    app: AppHandle,
    logs: Arc<Mutex<VecDeque<String>>>,
    src: &'static str,
    stream: R,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = strip_ansi(String::from_utf8_lossy(&buf).trim_end());
                    if line.is_empty() {
                        continue;
                    }
                    push_log(&logs, format!("[{src}] {line}"));
                    let _ = app.emit("core-log", LogLine { src: src.into(), line });
                }
            }
        }
    });
}

fn spawn_core(
    app: &AppHandle,
    state: &AppState,
    name: &'static str,
    exe: &PathBuf,
    args: &[&str],
    cwd: &PathBuf,
) -> Result<Child, String> {
    if !exe.exists() {
        return Err(format!("Не найдено ядро {}: {}", name, exe.display()));
    }
    let mut child = Command::new(exe)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Не удалось запустить {name}: {e}"))?;
    attach_to_job(state.job, &child);
    if let Some(out) = child.stdout.take() {
        pipe_logs(app.clone(), state.logs.clone(), name, out);
    }
    if let Some(err) = child.stderr.take() {
        pipe_logs(app.clone(), state.logs.clone(), name, err);
    }
    Ok(child)
}

fn stop_internal(state: &AppState) {
    let mut inner = state.inner.lock().unwrap();
    inner.session += 1;
    for p in inner.procs.iter_mut() {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
    inner.procs.clear();
    if let Some(port) = inner.proxy_port.take() {
        clear_our_proxy(port);
    }
}

fn set_tray(app: &AppHandle, connected: bool, tooltip: &str) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(img) = Image::from_bytes(if connected { TRAY_ON } else { TRAY_OFF }) {
            let _ = tray.set_icon(Some(img));
        }
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ---------------------------------------------------------------- commands

#[derive(Serialize)]
struct Paths {
    data_dir: String,
    run_dir: String,
    rules_dir: String,
    singbox: String,
    xray: String,
}

#[tauri::command]
fn get_paths(app: AppHandle) -> Paths {
    let data = data_dir(&app);
    let run = data.join("run");
    let _ = std::fs::create_dir_all(&run);
    Paths {
        data_dir: slash(&data),
        run_dir: slash(&run),
        rules_dir: slash(&resource(&app, "bin/rules")),
        singbox: slash(&resource(&app, "bin/sing-box.exe")),
        xray: slash(&resource(&app, "bin/xray.exe")),
    }
}

#[tauri::command]
fn load_state(app: AppHandle) -> String {
    std::fs::read_to_string(data_dir(&app).join("state.json")).unwrap_or_default()
}

#[tauri::command]
fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    let dir = data_dir(&app);
    let tmp = dir.join("state.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("state.json")).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn check_config(app: AppHandle, singbox: String) -> Result<String, String> {
    let run = data_dir(&app).join("run");
    let _ = std::fs::create_dir_all(&run);
    let path = run.join("check.json");
    std::fs::write(&path, singbox).map_err(|e| e.to_string())?;
    let exe = resource(&app, "bin/sing-box.exe");
    let out = Command::new(&exe)
        .args(["check", "-c", &path.to_string_lossy()])
        .current_dir(&run)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("sing-box: {e}"))?;
    let text = strip_ansi(&format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    ));
    if out.status.success() {
        Ok(text)
    } else {
        Err(text.trim().to_string())
    }
}

#[tauri::command(async)]
fn start_core(
    app: AppHandle,
    state: State<'_, AppState>,
    singbox: String,
    xray: Option<String>,
    system_proxy_port: Option<u16>,
) -> Result<(), String> {
    stop_internal(&state);
    state.logs.lock().unwrap().clear();

    let run = data_dir(&app).join("run");
    let _ = std::fs::create_dir_all(&run);
    let sb_path = run.join("singbox.json");
    std::fs::write(&sb_path, &singbox).map_err(|e| e.to_string())?;

    // Validate first: gives a clean error instead of a crashed process.
    check_config(app.clone(), singbox)?;

    let mut procs = Vec::new();
    if let Some(xcfg) = xray {
        let x_path = run.join("xray.json");
        std::fs::write(&x_path, xcfg).map_err(|e| e.to_string())?;
        let exe = resource(&app, "bin/xray.exe");
        let child = spawn_core(
            &app,
            &state,
            "xray",
            &exe,
            &["run", "-c", &x_path.to_string_lossy()],
            &run,
        )?;
        procs.push(CoreProc { name: "xray", child });
    }
    let exe = resource(&app, "bin/sing-box.exe");
    let child = spawn_core(
        &app,
        &state,
        "sing-box",
        &exe,
        &["run", "-c", &sb_path.to_string_lossy(), "-D", &run.to_string_lossy()],
        &run,
    )?;
    procs.push(CoreProc { name: "sing-box", child });

    // Give the cores a moment; most config/permission errors kill them right away.
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(1500) {
        thread::sleep(Duration::from_millis(100));
        let dead = procs
            .iter_mut()
            .find_map(|p| match p.child.try_wait() {
                Ok(Some(status)) => Some((p.name, status.code())),
                _ => None,
            });
        if let Some((name, code)) = dead {
            for q in procs.iter_mut() {
                let _ = q.child.kill();
            }
            thread::sleep(Duration::from_millis(150));
            return Err(format!(
                "{} завершился (код {:?}).\n{}",
                name,
                code,
                log_tail(&state.logs, 12)
            ));
        }
    }

    let session;
    {
        let mut inner = state.inner.lock().unwrap();
        inner.procs = procs;
        session = inner.session;
        if let Some(port) = system_proxy_port {
            apply_system_proxy(Some(port))?;
            inner.proxy_port = Some(port);
        }
    }

    // Watchdog: report an unexpected core exit to the UI.
    let app2 = app.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));
        let st = app2.state::<AppState>();
        let mut inner = st.inner.lock().unwrap();
        if inner.session != session {
            break;
        }
        let mut dead = None;
        for p in inner.procs.iter_mut() {
            if let Ok(Some(status)) = p.child.try_wait() {
                dead = Some((p.name, status.code()));
                break;
            }
        }
        if let Some((name, code)) = dead {
            drop(inner);
            stop_internal(&st);
            set_tray(&app2, false, "Aurora VPN: отключено");
            let _ = app2.emit(
                "core-exit",
                CoreExit { name: name.into(), code, tail: log_tail(&st.logs, 12) },
            );
            break;
        }
    });
    Ok(())
}

#[tauri::command(async)]
fn stop_core(state: State<'_, AppState>) {
    stop_internal(&state);
}

#[tauri::command]
fn core_running(state: State<'_, AppState>) -> bool {
    !state.inner.lock().unwrap().procs.is_empty()
}

#[tauri::command]
fn cleanup_proxy(port: u16) {
    clear_our_proxy(port);
}

#[derive(Deserialize)]
struct PingTarget {
    id: String,
    host: String,
    port: u16,
}

#[derive(Serialize)]
struct PingResult {
    id: String,
    ms: Option<u64>,
}

fn tcp_ping(host: &str, port: u16) -> Option<u64> {
    let addrs: Vec<_> = (host, port).to_socket_addrs().ok()?.collect();
    let addr = addrs.iter().find(|a| a.is_ipv4()).or(addrs.first())?;
    let start = Instant::now();
    TcpStream::connect_timeout(addr, Duration::from_millis(3000)).ok()?;
    Some(start.elapsed().as_millis() as u64)
}

#[tauri::command(async)]
fn ping_servers(targets: Vec<PingTarget>) -> Vec<PingResult> {
    let handles: Vec<_> = targets
        .into_iter()
        .map(|t| {
            thread::spawn(move || PingResult { ms: tcp_ping(&t.host, t.port), id: t.id })
        })
        .collect();
    handles.into_iter().filter_map(|h| h.join().ok()).collect()
}

#[derive(Serialize)]
struct SubResponse {
    body: String,
    headers: HashMap<String, String>,
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// Stable per-PC device id for providers with a device limit (Remnawave HWID).
/// Derived from the Windows MachineGuid, so reinstalling the app keeps the same id.
fn machine_hwid() -> String {
    let guid: String = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SOFTWARE\Microsoft\Cryptography", KEY_READ | KEY_WOW64_64KEY)
        .and_then(|k| k.get_value("MachineGuid"))
        .unwrap_or_else(|_| "aurora-fallback".into());
    format!(
        "{:016x}{:016x}",
        fnv1a(&format!("aurora-hwid-a:{guid}")),
        fnv1a(&format!("aurora-hwid-b:{guid}"))
    )
}

#[tauri::command]
fn get_hwid() -> String {
    machine_hwid()
}

#[tauri::command(async)]
fn fetch_subscription(
    url: String,
    user_agent: Option<String>,
    via_proxy: Option<u16>,
) -> Result<SubResponse, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Ссылка подписки должна начинаться с http:// или https://".into());
    }
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout(Duration::from_secs(25));
    // Optional route through our own running core, for hosts unreachable directly.
    if let Some(port) = via_proxy {
        let proxy = ureq::Proxy::new(format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?;
        builder = builder.proxy(proxy);
    }
    let agent = builder.build();
    // The x-* headers are what Happ / Incy send; providers with a device limit
    // answer clients without them with a "not supported" stub.
    let resp = agent
        .get(&url)
        .set("User-Agent", user_agent.as_deref().unwrap_or("v2rayN/7.10"))
        .set("x-hwid", &machine_hwid())
        .set("x-device-os", "Windows")
        .set("x-ver-os", "10")
        .set("x-device-model", "Aurora VPN")
        .call()
        .map_err(|e| match e {
            // The server answered: another User-Agent may still work.
            ureq::Error::Status(code, _) => format!("HTTP {code}"),
            // No connection at all: the frontend stops retrying (prefix NET:).
            ureq::Error::Transport(t) => format!("NET: {t}"),
        })?;
    let mut headers = HashMap::new();
    for name in [
        "subscription-userinfo",
        "profile-title",
        "profile-update-interval",
        "support-url",
        "profile-web-page-url",
        "announce",
    ] {
        if let Some(v) = resp.header(name) {
            headers.insert(name.to_string(), v.to_string());
        }
    }
    let body = resp.into_string().map_err(|e| e.to_string())?;
    Ok(SubResponse { body, headers })
}

/// Asks an IP-info service through our own local proxy, to show the exit node.
#[tauri::command(async)]
fn exit_ip(port: u16) -> Result<String, String> {
    let proxy = ureq::Proxy::new(format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?;
    let agent = ureq::AgentBuilder::new()
        .proxy(proxy)
        .timeout(Duration::from_secs(10))
        .build();
    let urls = [
        "https://ipwho.is/",
        "http://ip-api.com/json/?fields=status,country,countryCode,city,isp,query",
    ];
    let mut last = String::new();
    for u in urls {
        match agent.get(u).call() {
            Ok(r) => return r.into_string().map_err(|e| e.to_string()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

/// Real delay test, like Happ's: a throwaway sing-box (no inbounds, so nothing on
/// the PC goes through it) gets every server as an outbound, and its Clash API
/// measures an HTTP request through each one. Works for UDP protocols too.
#[tauri::command(async)]
fn latency_test(
    app: AppHandle,
    config: String,
    tags: Vec<String>,
    port: u16,
) -> Result<HashMap<String, Option<u64>>, String> {
    let run = data_dir(&app).join("run");
    let _ = std::fs::create_dir_all(&run);
    let path = run.join("latency.json");
    std::fs::write(&path, config).map_err(|e| e.to_string())?;
    let state = app.state::<AppState>();
    let exe = resource(&app, "bin/sing-box.exe");
    let mut child = Command::new(&exe)
        .args(["run", "-c", &path.to_string_lossy(), "-D", &run.to_string_lossy()])
        .current_dir(&run)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("sing-box: {e}"))?;
    attach_to_job(state.job, &child);

    let base = format!("http://127.0.0.1:{port}");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(9))
        .build();
    // Wait for the Clash API to come up (or the core to die on a bad config).
    let started = Instant::now();
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = e.read_to_string(&mut err);
            }
            return Err(format!("Тест не запустился: {}", strip_ansi(err.trim())));
        }
        if agent.get(&format!("{base}/version")).call().is_ok() {
            break;
        }
        if started.elapsed() > Duration::from_secs(5) {
            let _ = child.kill();
            return Err("Тест не запустился: ядро не ответило".into());
        }
        thread::sleep(Duration::from_millis(100));
    }

    let mut results = HashMap::new();
    for chunk in tags.chunks(16) {
        let handles: Vec<_> = chunk
            .iter()
            .cloned()
            .map(|tag| {
                let agent = agent.clone();
                let url = format!(
                    "{base}/proxies/{tag}/delay?timeout=6000&url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204"
                );
                thread::spawn(move || {
                    let ms = agent
                        .get(&url)
                        .call()
                        .ok()
                        .and_then(|r| r.into_string().ok())
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                        .and_then(|v| v.get("delay").and_then(|d| d.as_u64()))
                        .filter(|d| *d > 0);
                    (tag, ms)
                })
            })
            .collect();
        for h in handles {
            if let Ok((tag, ms)) = h.join() {
                results.insert(tag, ms);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(results)
}

// ---------------------------------------------------------------- updates

const UPDATE_REPO: &str = "KotikVanil/aurora-vpn";

#[tauri::command]
fn get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Reads version.json from the latest GitHub release. Uses the releases/latest
/// download redirect, not the API (the API is rate-limited behind shared VPN IPs).
#[tauri::command(async)]
fn check_update() -> Result<String, String> {
    let url = format!("https://github.com/{UPDATE_REPO}/releases/latest/download/version.json");
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .get(&url)
        .set("User-Agent", "AuroraVPN-updater")
        .call()
        .map_err(|e| format!("Не удалось проверить обновления: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
struct UpdateProgress {
    done: u64,
    total: u64,
}

/// Downloads the new installer, then hands over to a small PowerShell helper that
/// waits for this process to exit, installs silently and starts Aurora again.
#[tauri::command(async)]
fn install_update(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with(&format!("https://github.com/{UPDATE_REPO}/")) {
        return Err("Обновление можно скачать только из репозитория Aurora".into());
    }
    let dir = std::env::temp_dir().join("aurora-update");
    let _ = std::fs::create_dir_all(&dir);
    let installer = dir.join("Aurora-VPN-setup.exe");
    let resp = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .build()
        .get(&url)
        .set("User-Agent", "AuroraVPN-updater")
        .call()
        .map_err(|e| format!("Обновление не скачалось: {e}"))?;
    let total: u64 = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&installer).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut done: u64 = 0;
    let mut last_emit = Instant::now();
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Обновление не скачалось: {e}"))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if last_emit.elapsed() > Duration::from_millis(150) {
            last_emit = Instant::now();
            let _ = app.emit("update-progress", UpdateProgress { done, total });
        }
    }
    drop(file);
    if total > 0 && done < total {
        return Err("Обновление скачалось не полностью".into());
    }
    let _ = app.emit("update-progress", UpdateProgress { done, total: done });

    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let script = dir.join("apply-update.ps1");
    let ps = r#"param([int]$ProcId, [string]$Installer, [string]$Fallback)
$p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
if ($p) { $null = $p.WaitForExit(20000) }
Get-Process sing-box, xray -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*Aurora*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $Installer -ArgumentList '/S' -Wait
$loc = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq 'Aurora VPN' } | Select-Object -First 1 -ExpandProperty InstallLocation
$exe = $Fallback
if ($loc) {
  $cand = Join-Path ($loc -replace '"', '') 'aurora-vpn.exe'
  if (Test-Path $cand) { $exe = $cand }
}
Start-Process -FilePath $exe
"#;
    std::fs::write(&script, ps).map_err(|e| e.to_string())?;
    Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            &script.to_string_lossy(),
            "-ProcId",
            &std::process::id().to_string(),
            "-Installer",
            &installer.to_string_lossy(),
            "-Fallback",
            &current.to_string_lossy(),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Не удалось запустить установку: {e}"))?;

    let st = app.state::<AppState>();
    st.quitting.store(true, Ordering::SeqCst);
    stop_internal(&st);
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn read_clipboard() -> Result<String, String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.get_text())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn write_clipboard(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn is_admin() -> bool {
    unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 }
}

fn shell_execute(verb: &str, file: &str, args: &str) -> bool {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let (v, f, a) = (wide(verb), wide(file), wide(args));
    let r = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            v.as_ptr(),
            f.as_ptr(),
            if args.is_empty() { std::ptr::null() } else { a.as_ptr() },
            std::ptr::null(),
            1,
        )
    };
    r as isize > 32
}

#[tauri::command]
fn relaunch_admin(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    stop_internal(&state);
    if shell_execute("runas", &exe.to_string_lossy(), "--elevated") {
        state.quitting.store(true, Ordering::SeqCst);
        app.exit(0);
        Ok(())
    } else {
        Err("Запуск от администратора отменён".into())
    }
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("tg://")) {
        return Err("Неподдерживаемая ссылка".into());
    }
    shell_execute("open", &url, "");
    Ok(())
}

#[tauri::command]
fn open_data_dir(app: AppHandle) {
    let dir = data_dir(&app);
    shell_execute("open", &dir.to_string_lossy(), "");
}

#[tauri::command]
fn get_autostart() -> bool {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(RUN_KEY)
        .and_then(|k| k.get_value::<String, _>(AUTOSTART_NAME))
        .is_ok()
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(RUN_KEY)
        .map_err(|e| e.to_string())?;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        key.set_value(AUTOSTART_NAME, &format!("\"{}\" --minimized", exe.display()))
            .map_err(|e| e.to_string())
    } else {
        let _ = key.delete_value(AUTOSTART_NAME);
        Ok(())
    }
}

#[tauri::command]
fn launch_flags() -> Vec<String> {
    std::env::args().skip(1).collect()
}

#[tauri::command]
fn set_tray_state(app: AppHandle, connected: bool, tooltip: String) {
    set_tray(&app, connected, &tooltip);
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<'_, AppState>) {
    state.quitting.store(true, Ordering::SeqCst);
    stop_internal(&state);
    app.exit(0);
}

// ---------------------------------------------------------------- entry

pub fn run() {
    let app = tauri::Builder::default()
        // A second launch just brings the running window forward (one tray icon, one core).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .manage(AppState {
            inner: Mutex::new(Inner::default()),
            logs: Arc::new(Mutex::new(VecDeque::new())),
            quitting: AtomicBool::new(false),
            job: create_job(),
        })
        .setup(|app| {
            let show = MenuItemBuilder::with_id("show", "Открыть Aurora").build(app)?;
            let toggle = MenuItemBuilder::with_id("toggle", "Подключить / отключить").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Выход").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&show, &toggle])
                .separator()
                .items(&[&quit])
                .build()?;
            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(TRAY_OFF)?)
                .tooltip("Aurora VPN: отключено")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main(app),
                    "toggle" => {
                        let _ = app.emit("tray-toggle", ());
                    }
                    "quit" => {
                        let st = app.state::<AppState>();
                        st.quitting.store(true, Ordering::SeqCst);
                        stop_internal(&st);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            if !std::env::args().any(|a| a == "--minimized") {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let st = window.app_handle().state::<AppState>();
                if !st.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_paths,
            load_state,
            save_state,
            check_config,
            start_core,
            stop_core,
            core_running,
            cleanup_proxy,
            ping_servers,
            fetch_subscription,
            get_hwid,
            latency_test,
            get_version,
            check_update,
            install_update,
            exit_ip,
            read_clipboard,
            write_clipboard,
            is_admin,
            relaunch_admin,
            open_url,
            open_data_dir,
            get_autostart,
            set_autostart,
            launch_flags,
            set_tray_state,
            quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Aurora VPN");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let st = handle.state::<AppState>();
            stop_internal(&st);
        }
    });
}
