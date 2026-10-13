// Bridge to the Rust side. Outside Tauri (plain browser preview) a mock backend
// answers instead, so the UI can be viewed without touching the network.

export const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
// Android build: the Kotlin host injects window.AuroraAndroid (see android/.../MainActivity.kt).
export const IS_ANDROID = typeof window !== "undefined" && !!window.AuroraAndroid;
// Phone layout: the Android app, or ?mobile in a browser preview.
export const IS_MOBILE = IS_ANDROID || (typeof location !== "undefined" && /[?&]mobile\b/.test(location.search));

const androidPending = new Map();
const androidListeners = {};
let androidSeq = 0;
if (IS_ANDROID) {
  window.__auroraResolve = (id, ok, value) => {
    const p = androidPending.get(id);
    if (!p) return;
    androidPending.delete(id);
    if (ok) p.resolve(value);
    else p.reject(new Error(value));
  };
  window.__auroraEmit = (name, payload) => (androidListeners[name] || []).forEach((f) => f(payload));
}

let tauri = null;
async function api() {
  if (!tauri) {
    const [core, event, win] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
      import("@tauri-apps/api/window"),
    ]);
    tauri = { invoke: core.invoke, listen: event.listen, win: win.getCurrentWindow() };
  }
  return tauri;
}

const mockState = { running: false, state: localStorage.getItem("aurora-mock-state") || "" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = {
  get_paths: () => ({ data_dir: "C:/mock", run_dir: "C:/mock/run", rules_dir: "C:/mock/rules", singbox: "", xray: "" }),
  load_state: () => mockState.state,
  save_state: ({ json }) => {
    mockState.state = json;
    localStorage.setItem("aurora-mock-state", json);
  },
  start_core: async () => {
    await sleep(1200);
    mockState.running = true;
  },
  stop_core: async () => {
    await sleep(200);
    mockState.running = false;
  },
  core_running: () => mockState.running,
  cleanup_proxy: () => {},
  ping_servers: async ({ targets }) => {
    await sleep(500);
    return targets.map((t) => ({ id: t.id, ms: Math.random() < 0.1 ? null : Math.round(30 + Math.random() * 220) }));
  },
  fetch_subscription: async () => {
    throw new Error("В демо-режиме подписки не загружаются");
  },
  exit_ip: async () => JSON.stringify({ ip: "203.0.113.42", country: "Germany", country_code: "DE", city: "Frankfurt", connection: { isp: "Demo Hosting" } }),
  read_clipboard: async () => navigator.clipboard?.readText?.() ?? "",
  write_clipboard: async ({ text }) => navigator.clipboard?.writeText?.(text),
  is_admin: () => false,
  relaunch_admin: () => {
    throw new Error("Демо-режим");
  },
  open_url: ({ url }) => window.open(url, "_blank"),
  open_data_dir: () => {},
  get_autostart: () => false,
  set_autostart: () => {},
  launch_flags: () => [],
  set_tray_state: () => {},
  quit_app: () => {},
  check_config: () => "",
  get_hwid: () => "demo0000demo0000",
  latency_test: async ({ tags }) => {
    await sleep(1500);
    return Object.fromEntries(tags.map((t) => [t, Math.random() < 0.15 ? null : Math.round(90 + Math.random() * 400)]));
  },
  get_version: () => "1.2.0",
  check_update: async () => {
    await sleep(600);
    return JSON.stringify({ version: "1.2.0", notes: "", url: "" });
  },
  install_update: () => {
    throw new Error("В демо-режиме обновление не ставится");
  },
  get_apps: async () => {
    await sleep(400);
    return [
      ["Telegram", "org.telegram.messenger"],
      ["Сбербанк Онлайн", "ru.sberbankmobile"],
      ["Госуслуги", "ru.rostel"],
      ["YouTube", "com.google.android.youtube"],
      ["Яндекс Карты", "ru.yandex.yandexmaps"],
      ["Chrome", "com.android.chrome"],
    ].map(([label, pkg], i) => ({ label, package: pkg, system: i > 4, icon: "" }));
  },
  open_vpn_settings: () => {},
};

export async function call(cmd, args = {}) {
  if (IS_ANDROID) {
    return new Promise((resolve, reject) => {
      const id = ++androidSeq;
      androidPending.set(id, { resolve, reject });
      window.AuroraAndroid.call(cmd, JSON.stringify(args), id);
    });
  }
  if (!IS_TAURI) {
    const fn = mock[cmd];
    if (!fn) throw new Error(`mock: ${cmd}`);
    return fn(args);
  }
  const t = await api();
  return t.invoke(cmd, args);
}

export async function on(event, handler) {
  if (IS_ANDROID) {
    (androidListeners[event] ||= []).push(handler);
    return () => (androidListeners[event] = androidListeners[event].filter((f) => f !== handler));
  }
  if (!IS_TAURI) return () => {};
  const t = await api();
  return t.listen(event, (e) => handler(e.payload));
}

export async function windowAction(action) {
  if (!IS_TAURI || IS_ANDROID) return;
  const t = await api();
  if (action === "minimize") return t.win.minimize();
  if (action === "maximize") return t.win.toggleMaximize();
  if (action === "hide") return t.win.hide();
  if (action === "drag") return t.win.startDragging();
}

export const isMock = !IS_TAURI && !IS_ANDROID;
