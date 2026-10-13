import qrcode from "qrcode-generator";
import { call, on, windowAction, isMock } from "./backend.js";
import { startAurora, PALETTES } from "./aurora.js";
import { play, sound } from "./sound.js";
import {
  classifyInput,
  parseLink,
  parseSubscriptionBody,
  parseUserInfo,
  decodeTitle,
  cleanName,
  protocolLabel,
  needsXray,
  isUdpProtocol,
  newId,
  SUB_USER_AGENTS,
} from "./core/links.js";
import { buildConfigs, buildLatencyConfig, DEFAULT_SETTINGS, CLASH_PORT } from "./core/config.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ================================================================= state

const state = {
  profiles: [],
  subs: [],
  selectedId: null,
  settings: { ...DEFAULT_SETTINGS },
  app: {
    accent: "aurora",
    sounds: true,
    autoConnect: false,
    autoReconnect: true,
    autoUpdateCheck: true,
    subUpdateHours: 12,
    pendingConnect: false,
  },
};

const rt = {
  status: "off", // off | connecting | on
  paths: null,
  admin: false,
  startedAt: 0,
  totals: { up: 0, down: 0 },
  hist: [],
  lastSampleAt: 0,
  ws: null,
  mockTimer: null,
  userStop: false,
  reconnects: 0,
  logs: [],
  engine: "",
  realDelay: null,
  busy: false,
};

let aurora = { energy: 0, targetEnergy: 0, pulse: 0, warp: 0, palette: PALETTES.aurora };
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => call("save_state", { json: JSON.stringify(state) }).catch(() => {}), 250);
}

async function load() {
  try {
    const raw = await call("load_state");
    if (!raw) return;
    const s = JSON.parse(raw);
    state.profiles = Array.isArray(s.profiles) ? s.profiles : [];
    state.subs = Array.isArray(s.subs) ? s.subs : [];
    state.selectedId = s.selectedId || null;
    state.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    state.app = { ...state.app, ...(s.app || {}) };
  } catch {
    /* fresh start */
  }
}

const current = () => state.profiles.find((p) => p.id === state.selectedId) || null;

// ================================================================= helpers

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
const fmtSpeed = (n) => `${fmtBytes(n)}/с`;

function fmtShort(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${Math.round(n)}Б`;
  if (n < 1048576) return `${Math.round(n / 1024)}К`;
  return `${(n / 1048576).toFixed(1)}М`;
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${h}:${m}:${String(s % 60).padStart(2, "0")}`;
}

function ago(ts) {
  if (!ts) return "никогда";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

const GLOBE = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/></svg>`;
function flagHtml(cc) {
  return cc && /^[A-Z]{2}$/i.test(cc) ? `<span class="fi fi-${cc.toLowerCase()}"></span>` : GLOBE;
}

function pingClass(ms) {
  if (ms == null) return "";
  if (ms < 120) return "good";
  if (ms < 300) return "mid";
  return "bad";
}

function pingText(p) {
  if (p.pinging) return "···";
  if (isUdpProtocol(p) && p.ping == null) return "UDP";
  if (p.ping === -1) return "нет связи";
  if (p.ping == null) return "—";
  return `${p.ping} мс`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 30);
  }
}

// ================================================================= toasts, modal, logs

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<i></i><div>${esc(msg)}</div>`;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  }, kind === "err" ? 6000 : 3200);
}

function openModal(html, mount) {
  $("#modal").innerHTML = html;
  $("#modalBack").hidden = false;
  mount?.($("#modal"));
}
function closeModal() {
  $("#modalBack").hidden = true;
  $("#modal").innerHTML = "";
}
$("#modalBack").addEventListener("mousedown", (e) => {
  if (e.target.id === "modalBack") closeModal();
});

function showError(title, detail) {
  openModal(
    `<h2>${esc(title)}</h2>
     <p>Подробности из журнала ядра. Частые причины: ключ устарел, сервер недоступен, порт ${esc(state.settings.port)} занят другой программой.</p>
     <pre>${esc(detail)}</pre>
     <div class="modal-btns">
       <button class="btn ghost" data-act="logs">Открыть журнал</button>
       <button class="btn primary" data-act="ok">Понятно</button>
     </div>`,
    (m) => {
      m.querySelector('[data-act="ok"]').onclick = closeModal;
      m.querySelector('[data-act="logs"]').onclick = () => {
        closeModal();
        showPage("logs");
      };
    },
  );
}

function logLine(src, line) {
  const cls = /\b(ERROR|FATAL|error|failed)\b/.test(line) ? "l-err" : /\bWARN|warning\b/.test(line) ? "l-warn" : src === "app" ? "l-app" : "";
  const time = new Date().toLocaleTimeString("ru-RU");
  rt.logs.push({ src, line, cls, time });
  if (rt.logs.length > 1500) rt.logs.splice(0, 300);
  if ($("#page-logs").classList.contains("active")) appendLogDom(rt.logs[rt.logs.length - 1]);
}
const appLog = (line) => logLine("app", line);

function logMatches(l) {
  const f = $("#logFilter").value.trim().toLowerCase();
  return !f || l.line.toLowerCase().includes(f) || l.src.includes(f);
}

function appendLogDom(l) {
  if (!logMatches(l)) return;
  const box = $("#logBox");
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const div = document.createElement("div");
  div.className = l.cls;
  div.textContent = `${l.time}  [${l.src}] ${l.line}`;
  box.appendChild(div);
  while (box.childElementCount > 1200) box.firstChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

function renderLogs() {
  const box = $("#logBox");
  box.innerHTML = "";
  rt.logs.filter(logMatches).slice(-1200).forEach(appendLogDom);
  box.scrollTop = box.scrollHeight;
}

// ================================================================= navigation & segments

function showPage(name) {
  $$(".nav").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${name}`));
  if (name === "logs") renderLogs();
  if (name === "servers") renderServers();
  if (name === "home") requestAnimationFrame(layoutSegs);
}
$$(".nav").forEach((b) =>
  b.addEventListener("click", () => {
    play("click");
    showPage(b.dataset.page);
  }),
);

function setSeg(el, value) {
  el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === value));
  layoutSeg(el);
}
function layoutSeg(el) {
  const on = el.querySelector("button.on");
  const g = el.querySelector(".seg-glider");
  if (!on || !g) return;
  g.style.width = `${on.offsetWidth}px`;
  g.style.transform = `translateX(${on.offsetLeft - 4}px)`;
}
function layoutSegs() {
  $$(".seg").forEach(layoutSeg);
}
addEventListener("resize", layoutSegs);

$("#modeSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.dataset.v === state.settings.mode) return;
  play("click");
  state.settings.mode = b.dataset.v;
  setSeg($("#modeSeg"), state.settings.mode);
  save();
  if (b.dataset.v === "tun" && !rt.admin) toast("TUN-режиму нужны права администратора, спрошу при подключении", "warn");
  reconnectIfOn("Режим изменён");
});
$("#routeSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.dataset.v === state.settings.routing) return;
  play("click");
  state.settings.routing = b.dataset.v;
  setSeg($("#routeSeg"), state.settings.routing);
  $("#optSmart").checked = state.settings.routing === "smart";
  save();
  reconnectIfOn("Маршрутизация изменена");
});

// ================================================================= window chrome

$$(".win-btn").forEach((b) => b.addEventListener("click", () => windowAction(b.dataset.win)));
$(".titlebar").addEventListener("dblclick", (e) => {
  if (!e.target.closest(".win-btns")) windowAction("maximize");
});

// ================================================================= home rendering

function setStatus(s) {
  rt.status = s;
  document.body.classList.toggle("connecting", s === "connecting");
  document.body.classList.toggle("connected", s === "on");
  aurora.targetEnergy = s === "on" ? 1 : s === "connecting" ? 0.45 : 0;
  const p = current();
  const title = $("#statusTitle");
  const sub = $("#statusSub");
  if (s === "on") {
    title.textContent = "Защищено";
    sub.textContent = `${cleanName(p?.name) || ""} · ${state.settings.mode === "tun" ? "TUN, весь трафик" : "системный прокси"} · ${rt.engine}`;
  } else if (s === "connecting") {
    title.textContent = "Подключение…";
    sub.textContent = `${cleanName(p?.name) || ""}`;
  } else {
    title.textContent = "Не подключено";
    sub.textContent = p ? "Нажми на сферу или пробел" : "Добавь ключ во вкладке «Серверы»";
  }
  $("#btnRealDelay").disabled = s !== "on";
  $("#titleStatus").textContent = s === "on" ? `● ${cleanName(p?.name)}` : "";
  $("#orb").setAttribute("aria-label", s === "on" ? "Отключить" : "Подключить");
  call("set_tray_state", {
    connected: s === "on",
    tooltip: s === "on" ? `Aurora VPN: ${cleanName(p?.name)}` : "Aurora VPN: отключено",
  }).catch(() => {});
}

function renderHome() {
  const p = current();
  $("#curFlag").innerHTML = flagHtml(p?.country);
  $("#curName").textContent = p ? cleanName(p.name) : "Сервер не выбран";
  $("#curProto").textContent = p ? `${protocolLabel(p)}${needsXray(p) ? " · через Xray" : ""}` : "Добавь ключ во вкладке «Серверы»";
  const pill = $("#curPing");
  if (p && rt.status === "on" && rt.realDelay != null) {
    pill.textContent = rt.realDelay < 0 ? "таймаут" : `${rt.realDelay} мс`;
    pill.className = `ping-pill ${rt.realDelay < 0 ? "bad" : pingClass(rt.realDelay)}`;
    pill.title = "Реальная задержка через туннель";
  } else {
    pill.textContent = p ? pingText(p) : "—";
    pill.className = `ping-pill ${p ? pingClass(p.ping === -1 ? 9999 : p.ping) : ""} ${p?.pinging ? "loading" : ""}`;
    pill.title = "TCP-пинг до сервера";
  }
  setSeg($("#modeSeg"), state.settings.mode);
  setSeg($("#routeSeg"), state.settings.routing);
  renderSubCard();
  if (rt.status !== "connecting") setStatus(rt.status);
}

function renderSubCard() {
  const p = current();
  const sub = p?.subId ? state.subs.find((s) => s.id === p.subId) : null;
  const card = $("#subCard");
  if (!sub) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("#subTitle").textContent = sub.title || "Подписка";
  const ui = sub.userinfo || {};
  const used = (ui.upload || 0) + (ui.download || 0);
  const fill = $("#subFill");
  if (ui.total) {
    const pct = Math.min(100, (used / ui.total) * 100);
    fill.style.width = `${pct}%`;
    $("#subUsage").textContent = `Использовано ${fmtBytes(used)} из ${fmtBytes(ui.total)} (${pct.toFixed(0)}%)`;
  } else {
    fill.style.width = "100%";
    fill.style.opacity = 0.35;
    $("#subUsage").textContent = used ? `Использовано ${fmtBytes(used)} · безлимит` : "Безлимитный трафик";
  }
  const ex = $("#subExpire");
  if (ui.expire) {
    const days = Math.ceil((ui.expire * 1000 - Date.now()) / 86400000);
    ex.textContent = days < 0 ? "Истекла" : days === 0 ? "Истекает сегодня" : `Осталось ${days} дн.`;
    ex.className = `sub-expire ${days <= 0 ? "bad" : days <= 3 ? "warn" : ""}`;
  } else {
    ex.textContent = "";
  }
}

// ================================================================= servers rendering

const MENU_BTN = (id) =>
  `<button class="icon-btn srv-menu" data-menu="${id}" title="Действия"><svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/></svg></button>`;

/** Section entries ("──── 🌐 ДЛЯ ВСЕГО ────") span the row like headers in Happ. */
function sectionHtml(p) {
  const sel = p.id === state.selectedId ? "selected" : "";
  const label = p.name.replace(/^[\s─━—–=\-_~•·]+|[\s─━—–=\-_~•·]+$/g, "");
  return `<div class="srv section ${sel}" data-id="${p.id}" title="${esc(p.desc || "Раздел провайдера, тоже рабочий сервер")}">
    <span class="sec-line"></span>
    <div class="sec-label">${esc(label)}</div>
    <span class="sec-line"></span>
    <div class="srv-proto">${esc(protocolLabel(p))}</div>
    <div class="ping-pill ${pingClass(p.ping === -1 ? 9999 : p.ping)} ${p.pinging ? "loading" : ""}">${pingText(p)}</div>
    ${MENU_BTN(p.id)}
  </div>`;
}

function srvHtml(p) {
  if (p.isSection) return sectionHtml(p);
  const sel = p.id === state.selectedId ? "selected" : "";
  const x = needsXray(p) ? `<span class="badge-x">Xray</span>` : "";
  return `<div class="srv ${sel}" data-id="${p.id}" title="${esc(p.desc || `${p.server}:${p.port}`)}">
    <div class="flag">${flagHtml(p.country)}</div>
    <div class="srv-text">
      <div class="srv-name">${esc(cleanName(p.name))}</div>
      <div class="srv-proto">${esc(protocolLabel(p))} ${x}</div>
    </div>
    <div class="ping-pill ${pingClass(p.ping === -1 ? 9999 : p.ping)} ${p.pinging ? "loading" : ""}">${pingText(p)}</div>
    ${MENU_BTN(p.id)}
  </div>`;
}

function filteredProfiles(list) {
  const q = $("#serverSearch").value.trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) => `${p.name} ${p.country} ${protocolLabel(p)} ${p.server}`.toLowerCase().includes(q));
}

function renderServers() {
  const root = $("#serverGroups");
  let html = "";
  for (const sub of state.subs) {
    const items = filteredProfiles(state.profiles.filter((p) => p.subId === sub.id));
    const ui = sub.userinfo || {};
    const count = state.profiles.filter((p) => p.subId === sub.id && !p.isSection).length;
    const meta = [`${count} серв.`];
    if (sub.userinfo) meta.push(`${fmtBytes((ui.upload || 0) + (ui.download || 0))} / ${ui.total ? fmtBytes(ui.total) : "∞"}`);
    if (ui.expire) meta.push(`до ${new Date(ui.expire * 1000).toLocaleDateString("ru-RU")}`);
    meta.push(`обновлено ${ago(sub.updatedAt)}`);
    html += `<div class="group">
      <div class="group-head">
        <svg viewBox="0 0 24 24" style="width:18px;height:18px;color:var(--a1)"><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.5"/></svg>
        <div class="group-title">${esc(sub.title || hostOf(sub.url))}</div>
        <div class="group-meta">${esc(meta.join(" · "))}</div>
        ${sub.supportUrl ? `<button class="btn ghost sm" data-support="${sub.id}">Поддержка</button>` : ""}
        <button class="icon-btn" data-subrefresh="${sub.id}" title="Обновить подписку"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg></button>
        <button class="icon-btn" data-subdel="${sub.id}" title="Удалить подписку"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button>
      </div>
      ${sub.announce ? `<div class="muted" style="margin:0 4px 10px">📣 ${esc(sub.announce)}</div>` : ""}
      <div class="server-list">${items.map(srvHtml).join("")}</div>
    </div>`;
  }
  const manual = filteredProfiles(state.profiles.filter((p) => !p.subId));
  if (manual.length) {
    html += `<div class="group">
      <div class="group-head">
        <svg viewBox="0 0 24 24" style="width:18px;height:18px;color:var(--a3)"><path d="M15 7a4 4 0 1 1-3.5 6L4 20.5V17h3v-3h3l1.5-1.5"/></svg>
        <div class="group-title">Мои ключи</div>
        <div class="group-meta">${manual.length} серв.</div>
      </div>
      <div class="server-list">${manual.map(srvHtml).join("")}</div>
    </div>`;
  }
  root.innerHTML = html;
  $("#serversEmpty").hidden = state.profiles.length > 0;
  root.querySelectorAll(".srv").forEach((el, i) => (el.style.animationDelay = `${Math.min(i, 20) * 25}ms`));
}

$("#serverGroups").addEventListener("click", async (e) => {
  const menu = e.target.closest("[data-menu]");
  if (menu) {
    e.stopPropagation();
    return openServerMenu(menu.dataset.menu);
  }
  const refresh = e.target.closest("[data-subrefresh]");
  if (refresh) {
    const sub = state.subs.find((s) => s.id === refresh.dataset.subrefresh);
    refresh.classList.add("spin");
    try {
      const n = await refreshSub(sub);
      toast(`Подписка обновлена: ${n} серверов`);
    } catch (err) {
      toast(String(err.message || err), "err");
    }
    refresh.classList.remove("spin");
    save();
    renderAll();
    return;
  }
  const del = e.target.closest("[data-subdel]");
  if (del) return confirmDeleteSub(del.dataset.subdel);
  const sup = e.target.closest("[data-support]");
  if (sup) {
    const sub = state.subs.find((s) => s.id === sup.dataset.support);
    return call("open_url", { url: sub.supportUrl }).catch((err) => toast(String(err), "err"));
  }
  const srv = e.target.closest(".srv");
  if (srv) selectServer(srv.dataset.id);
});
$("#serverSearch").addEventListener("input", renderServers);

function selectServer(id) {
  if (id === state.selectedId) return;
  state.selectedId = id;
  rt.realDelay = null;
  play("click");
  save();
  renderAll();
  reconnectIfOn("Сервер изменён");
}

function confirmDeleteSub(id) {
  const sub = state.subs.find((s) => s.id === id);
  openModal(
    `<h2>Удалить подписку?</h2><p>«${esc(sub.title || hostOf(sub.url))}» и все её серверы исчезнут из списка. Саму подписку у провайдера это не трогает.</p>
     <div class="modal-btns"><button class="btn ghost" data-act="no">Отмена</button><button class="btn primary" data-act="yes">Удалить</button></div>`,
    (m) => {
      m.querySelector('[data-act="no"]').onclick = closeModal;
      m.querySelector('[data-act="yes"]').onclick = () => {
        state.subs = state.subs.filter((s) => s.id !== id);
        state.profiles = state.profiles.filter((p) => p.subId !== id);
        if (!current()) state.selectedId = state.profiles[0]?.id || null;
        save();
        closeModal();
        renderAll();
      };
    },
  );
}

function qrSvg(text) {
  qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: false });
}

function openServerMenu(id) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  openModal(
    `<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
       <div class="flag-big">${flagHtml(p.country)}</div>
       <div><h2 style="margin:0">${esc(cleanName(p.name))}</h2><div class="muted">${esc(protocolLabel(p))} · ${esc(p.server)}:${p.port}</div></div>
     </div>
     <div class="qr-box" id="qrBox" hidden></div>
     <div class="modal-btns" style="justify-content:flex-start">
       <button class="btn ghost" data-act="connect">Подключиться</button>
       <button class="btn ghost" data-act="qr">QR для телефона</button>
       <button class="btn ghost" data-act="copy">Копировать ключ</button>
       <button class="btn ghost" data-act="ping">Пинг</button>
       ${p.subId ? "" : `<button class="btn ghost danger" data-act="del">Удалить</button>`}
     </div>`,
    (m) => {
      m.querySelector('[data-act="connect"]').onclick = () => {
        closeModal();
        state.selectedId = p.id;
        save();
        renderAll();
        if (rt.status === "on") reconnectIfOn("Сервер изменён");
        else connect();
      };
      m.querySelector('[data-act="qr"]').onclick = () => {
        const box = m.querySelector("#qrBox");
        box.innerHTML = qrSvg(p.raw);
        box.hidden = false;
        play("click");
      };
      m.querySelector('[data-act="copy"]').onclick = async () => {
        await call("write_clipboard", { text: p.raw }).catch(() => {});
        toast("Ключ скопирован");
      };
      m.querySelector('[data-act="ping"]').onclick = () => {
        closeModal();
        pingProfiles([p]);
      };
      const del = m.querySelector('[data-act="del"]');
      if (del)
        del.onclick = () => {
          state.profiles = state.profiles.filter((x) => x.id !== p.id);
          if (state.selectedId === p.id) state.selectedId = state.profiles[0]?.id || null;
          save();
          closeModal();
          renderAll();
        };
    },
  );
}

function openPicker() {
  if (!state.profiles.length) {
    showPage("servers");
    return;
  }
  openModal(
    `<h2>Выбор сервера</h2>
     <input id="pickSearch" placeholder="Поиск…" style="width:100%" />
     <div class="pick-list" id="pickList"></div>
     <div class="modal-btns"><button class="btn ghost" data-act="close">Закрыть</button></div>`,
    (m) => {
      const draw = () => {
        const q = m.querySelector("#pickSearch").value.trim().toLowerCase();
        const list = state.profiles.filter((p) => !q || `${p.name} ${p.country} ${protocolLabel(p)}`.toLowerCase().includes(q));
        m.querySelector("#pickList").innerHTML = list.map(srvHtml).join("");
      };
      draw();
      m.querySelector("#pickSearch").oninput = draw;
      m.querySelector("#pickSearch").focus();
      m.querySelector('[data-act="close"]').onclick = closeModal;
      m.querySelector("#pickList").onclick = (e) => {
        if (e.target.closest("[data-menu]")) return;
        const srv = e.target.closest(".srv");
        if (!srv) return;
        closeModal();
        selectServer(srv.dataset.id);
      };
    },
  );
}

// ================================================================= import

async function importText(text) {
  if (!text?.trim()) {
    toast("Пусто: нечего добавлять", "warn");
    return;
  }
  const { links, subs, errors } = classifyInput(text);
  let added = 0;
  const firstNew = [];
  for (const l of links) {
    try {
      const p = parseLink(l);
      if (state.profiles.some((x) => x.raw === l)) continue;
      state.profiles.push(p);
      firstNew.push(p.id);
      added++;
    } catch (e) {
      errors.push(e.message);
    }
  }
  for (const url of subs) {
    const existing = state.subs.find((s) => s.url === url);
    const sub = existing || { id: newId(), url };
    try {
      toast(`Загружаю подписку ${hostOf(url)}…`);
      const n = await refreshSub(sub);
      if (!existing) state.subs.push(sub);
      firstNew.push(state.profiles.find((p) => p.subId === sub.id)?.id);
      added += n;
      appLog(`Подписка ${sub.title}: ${n} серверов`);
    } catch (e) {
      const msg = String(e.message || e);
      errors.push(msg);
      // Unreachable host: keep the subscription so ⟳ can retry it later.
      if (!existing && /не отвечает/.test(msg)) {
        sub.title = hostOf(url);
        state.subs.push(sub);
      }
    }
  }
  if (!state.selectedId || !current()) state.selectedId = firstNew.find(Boolean) || state.profiles[0]?.id || null;
  save();
  renderAll();
  if (added) {
    play("connect");
    toast(`Добавлено серверов: ${added}`);
    $("#importText").value = "";
  }
  errors.slice(0, 3).forEach((e) => toast(e, "err"));
  if (!added && !errors.length) toast("Эти серверы уже есть в списке", "warn");
  if (added) pingProfiles(state.profiles.filter((p) => p.ping == null));
}

async function refreshSub(sub) {
  // Providers choose the format (or a stub page) by User-Agent: try several,
  // starting with the one that worked last time.
  let res = null;
  let parsed = null;
  let lastErr = null;
  let viaProxy = null;
  // The format that worked last time goes first: normally one request per refresh,
  // so providers' anti-abuse limits never see a burst from us.
  const uas = [...new Set([sub.ua, ...SUB_USER_AGENTS].filter(Boolean))];
  for (let i = 0; i < uas.length; i++) {
    const ua = uas[i];
    try {
      res = await call("fetch_subscription", { url: sub.url, userAgent: ua, viaProxy });
      parsed = parseSubscriptionBody(res.body);
      if (sub.ua !== ua) appLog(`Подписка ${hostOf(sub.url)}: формат получен как ${ua.split(/[/ ]/)[0]}`);
      sub.ua = ua;
      break;
    } catch (e) {
      const msg = String(e.message || e);
      appLog(`Подписка ${hostOf(sub.url)} (${ua}${viaProxy ? ", через VPN" : ""}): ${msg}`);
      if (msg.startsWith("NET:")) {
        // The host does not answer at all: other formats will not help.
        if (!viaProxy && rt.status === "on") {
          viaProxy = Number(state.settings.port);
          appLog("Сервер подписки недоступен напрямую, пробую через подключённый VPN");
          i--;
          continue;
        }
        lastErr = new Error(
          `Сервер подписки ${hostOf(sub.url)} не отвечает с этого компьютера. ` +
            (rt.status === "on"
              ? "Через VPN тоже не открылся."
              : "Если включён другой VPN (например WireGuard), выключи его или подключись в Aurora к любому серверу и нажми ⟳.") +
            " Старый список серверов сохранён.",
        );
        break;
      }
      lastErr = e;
    }
  }
  if (!parsed) throw lastErr || new Error("Подписка не загрузилась");
  const { profiles, errors } = parsed;
  const h = res.headers || {};
  sub.title = decodeTitle(h["profile-title"]) || sub.title || hostOf(sub.url);
  sub.userinfo = parseUserInfo(h["subscription-userinfo"]) || sub.userinfo || null;
  sub.supportUrl = h["support-url"] || h["profile-web-page-url"] || sub.supportUrl || "";
  sub.announce = decodeTitle(h["announce"] || "");
  sub.updatedAt = Date.now();
  sub.interval = Number(h["profile-update-interval"]) || 0;
  const selRaw = current()?.raw;
  const old = new Map(state.profiles.filter((p) => p.subId === sub.id).map((p) => [p.raw, p]));
  state.profiles = state.profiles.filter((p) => p.subId !== sub.id);
  for (const p of profiles) {
    p.subId = sub.id;
    const prev = old.get(p.raw);
    if (prev) {
      p.id = prev.id;
      p.ping = prev.ping;
    }
  }
  state.profiles.push(...profiles);
  if (selRaw) {
    const m = profiles.find((p) => p.raw === selRaw);
    if (m) state.selectedId = m.id;
  }
  if (errors.length) appLog(`Подписка ${sub.title}: пропущено ${errors.length} ключей (${errors[0]})`);
  return profiles.length;
}

async function autoUpdateSubs() {
  const hours = Number(state.app.subUpdateHours) || 0;
  if (!hours) return;
  for (const sub of state.subs) {
    // The provider's own profile-update-interval wins when it asks for more often.
    const every = sub.interval > 0 ? Math.min(hours, sub.interval) : hours;
    // Subscriptions saved before the section/JSON support get one refresh right away.
    const stale = !state.profiles.some((p) => p.subId === sub.id && "isSection" in p);
    if (!stale && Date.now() - (sub.updatedAt || 0) < every * 3600000) continue;
    try {
      await refreshSub(sub);
      appLog(`Подписка «${sub.title}» обновлена автоматически`);
    } catch (e) {
      appLog(`Подписка «${sub.title}» не обновилась: ${e.message || e}`);
    }
  }
  save();
  renderAll();
}

$("#btnImport").addEventListener("click", () => importText($("#importText").value));
$("#btnPaste").addEventListener("click", async () => {
  try {
    const text = await call("read_clipboard");
    $("#importText").value = text;
    importText(text);
  } catch (e) {
    toast(`Буфер недоступен: ${e}`, "err");
  }
});
$("#importText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || !e.shiftKey)) {
    e.preventDefault();
    importText($("#importText").value);
  }
});
const importCard = $("#importCard");
importCard.addEventListener("dragover", (e) => {
  e.preventDefault();
  importCard.classList.add("drop");
});
importCard.addEventListener("dragleave", () => importCard.classList.remove("drop"));
importCard.addEventListener("drop", (e) => {
  e.preventDefault();
  importCard.classList.remove("drop");
  const t = e.dataTransfer.getData("text");
  if (t) importText(t);
});

// ================================================================= ping

async function pingProfiles(list) {
  const tcp = list.filter((p) => !isUdpProtocol(p));
  if (!tcp.length) return;
  if (rt.status === "on" && state.settings.mode === "tun") toast("В TUN-режиме пинг идёт через туннель и может быть неточным", "warn");
  tcp.forEach((p) => (p.pinging = true));
  renderServers();
  renderHome();
  try {
    const res = await call("ping_servers", { targets: tcp.map((p) => ({ id: p.id, host: p.server, port: p.port })) });
    for (const r of res) {
      const p = state.profiles.find((x) => x.id === r.id);
      if (p) p.ping = r.ms == null ? -1 : r.ms;
    }
    play("ping");
  } catch (e) {
    toast(`Пинг не удался: ${e}`, "err");
  }
  tcp.forEach((p) => delete p.pinging);
  save();
  renderServers();
  renderHome();
}

// Real delay test through a throwaway core (like Happ): an HTTP request through every
// server, so UDP protocols (Hysteria, TUIC, WireGuard) get a number too.
const LATENCY_PORT = 19190;
let realTesting = false;
async function realTest(list) {
  if (realTesting || !list.length) return;
  realTesting = true;
  const items = list.filter((p) => !needsXray(p));
  const skipped = list.length - items.length;
  items.forEach((p) => (p.pinging = true));
  $("#btnPingAll").disabled = true;
  renderServers();
  renderHome();
  try {
    const { config, tags } = buildLatencyConfig(items, { rulesDir: rt.paths?.rules_dir, runDir: rt.paths?.run_dir }, LATENCY_PORT);
    const res = await call("latency_test", { config: JSON.stringify(config), tags: Object.keys(tags), port: LATENCY_PORT });
    let ok = 0;
    for (const [tag, ms] of Object.entries(res)) {
      const p = state.profiles.find((x) => x.id === tags[tag]);
      if (!p) continue;
      p.ping = ms == null ? -1 : ms;
      if (ms != null) ok++;
    }
    play("ping");
    toast(`Отвечают ${ok} из ${items.length}${skipped ? ` · ${skipped} xhttp/kcp проверяются только при подключении` : ""}`);
  } catch (e) {
    toast(String(e.message || e), "err");
  }
  items.forEach((p) => delete p.pinging);
  realTesting = false;
  $("#btnPingAll").disabled = false;
  save();
  renderServers();
  renderHome();
}

$("#btnPingAll").addEventListener("click", () => realTest(state.profiles));
$("#btnSortPing").addEventListener("click", () => {
  // Sort inside each provider section, so "── ⚡ БЫСТРЫЕ ──" headers keep their servers.
  const key = (p) => (p.ping == null || p.ping < 0 ? 1e9 : p.ping);
  const out = [];
  let block = [];
  const flush = () => {
    block.sort((a, b) => key(a) - key(b));
    out.push(...block);
    block = [];
  };
  for (const p of state.profiles) {
    if (p.isSection) {
      flush();
      out.push(p);
    } else block.push(p);
  }
  flush();
  state.profiles = out;
  save();
  renderServers();
  toast("Отсортировано по пингу");
});

async function pickBest() {
  if (!state.profiles.length) return showPage("servers");
  toast("Ищу самый быстрый сервер…");
  await realTest(state.profiles);
  const ok = state.profiles.filter((p) => p.ping != null && p.ping >= 0);
  if (!ok.length) return toast("Ни один сервер не ответил на пинг", "err");
  const best = ok.reduce((a, b) => (b.ping < a.ping ? b : a));
  toast(`Лучший: ${cleanName(best.name)} (${best.ping} мс)`);
  if (best.id !== state.selectedId) selectServer(best.id);
}
$("#btnBest").addEventListener("click", pickBest);
$("#btnPickServer").addEventListener("click", openPicker);

// ================================================================= connect / disconnect

async function connect() {
  if (rt.busy) return;
  const p = current();
  if (!p) {
    toast("Сначала добавь сервер", "warn");
    shakeOrb();
    showPage("servers");
    return;
  }
  if (state.settings.mode === "tun" && !rt.admin && !isMock) return askAdmin();
  rt.busy = true;
  rt.userStop = false;
  rt.realDelay = null;
  setStatus("connecting");
  play("charge");
  try {
    const { singbox, xray, engine } = buildConfigs(p, state.settings, { rulesDir: rt.paths.rules_dir, runDir: rt.paths.run_dir });
    rt.engine = engine;
    appLog(`Подключаюсь к «${cleanName(p.name)}» (${protocolLabel(p)}), ядро: ${engine}, режим: ${state.settings.mode === "tun" ? "TUN" : "прокси"}`);
    await call("start_core", {
      singbox: JSON.stringify(singbox, null, 2),
      xray: xray ? JSON.stringify(xray, null, 2) : null,
      systemProxyPort: state.settings.mode === "proxy" ? Number(state.settings.port) : null,
    });
    onConnected();
  } catch (e) {
    setStatus("off");
    play("error");
    shakeOrb();
    appLog(`Ошибка подключения: ${e}`);
    showError("Не удалось подключиться", String(e.message || e));
  } finally {
    rt.busy = false;
  }
}

function onConnected() {
  rt.startedAt = Date.now();
  rt.totals = { up: 0, down: 0 };
  rt.hist = [];
  setStatus("on");
  play("connect");
  aurora.warp = 1.2;
  burstParticles();
  startTraffic();
  setTimeout(fetchExitIp, 1500);
  setTimeout(realDelay, 900);
  setTimeout(() => {
    if (rt.status === "on") rt.reconnects = 0;
  }, 60000);
  appLog("Подключено");
}

async function disconnect(silent = false) {
  if (rt.busy) return;
  rt.busy = true;
  rt.userStop = true;
  stopTraffic();
  try {
    await call("stop_core");
  } catch {
    /* already stopped */
  }
  rt.busy = false;
  setStatus("off");
  if (!silent) play("disconnect");
  rt.realDelay = null;
  $("#ipAddr").textContent = "—";
  $("#ipGeo").textContent = "появится после подключения";
  $("#ipFlag").innerHTML = GLOBE;
  renderHome();
  appLog("Отключено");
}

async function toggle() {
  if (rt.status === "on") await disconnect();
  else if (rt.status === "off") await connect();
}

async function reconnectIfOn(reason) {
  if (rt.status !== "on") return;
  toast(`${reason}: переподключаюсь`);
  await disconnect(true);
  await connect();
}

function askAdmin() {
  openModal(
    `<h2>TUN нужны права администратора</h2>
     <p>TUN создаёт виртуальную сетевую карту и пускает через VPN весь трафик ПК, включая игры и Discord. Без прав администратора Windows не даст это сделать.</p>
     <div class="modal-btns">
       <button class="btn ghost" data-act="proxy">Подключить через прокси</button>
       <button class="btn primary" data-act="admin">Перезапустить от админа</button>
     </div>`,
    (m) => {
      m.querySelector('[data-act="proxy"]').onclick = () => {
        closeModal();
        state.settings.mode = "proxy";
        save();
        renderHome();
        connect();
      };
      m.querySelector('[data-act="admin"]').onclick = async () => {
        state.app.pendingConnect = true;
        await call("save_state", { json: JSON.stringify(state) });
        try {
          await call("relaunch_admin");
        } catch (e) {
          state.app.pendingConnect = false;
          save();
          closeModal();
          toast(String(e), "err");
        }
      };
    },
  );
}

function shakeOrb() {
  const o = $("#orb");
  o.classList.remove("shake");
  void o.offsetWidth;
  o.classList.add("shake");
}

$("#orb").addEventListener("click", (e) => {
  ripple(e);
  toggle();
});

function ripple(e) {
  const r = $("#orb").getBoundingClientRect();
  const cx = e.clientX || r.left + r.width / 2;
  const cy = e.clientY || r.top + r.height / 2;
  for (let i = 0; i < 18; i++) spawnParticle(cx - r.left + 105, cy - r.top + 105, true);
}

// ================================================================= traffic & stats

function startTraffic() {
  stopTraffic();
  rt.lastSampleAt = performance.now();
  if (isMock) {
    rt.mockTimer = setInterval(() => {
      const t = Date.now() / 1000;
      const down = Math.max(0, 900000 + 700000 * Math.sin(t / 3) + Math.random() * 600000);
      const up = Math.max(0, 80000 + 60000 * Math.sin(t / 2) + Math.random() * 40000);
      onSample(up, down);
    }, 1000);
    return;
  }
  const open = () => {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${CLASH_PORT}/traffic`);
      ws.onmessage = (m) => {
        try {
          const d = JSON.parse(m.data);
          onSample(d.up || 0, d.down || 0);
        } catch {
          /* skip */
        }
      };
      ws.onclose = () => {
        if (rt.status === "on" && rt.ws === ws) setTimeout(open, 1500);
      };
      rt.ws = ws;
    } catch {
      setTimeout(open, 1500);
    }
  };
  setTimeout(open, 400);
}

function stopTraffic() {
  clearInterval(rt.mockTimer);
  const ws = rt.ws;
  rt.ws = null;
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  onSample(0, 0, true);
}

function onSample(up, down, reset = false) {
  if (reset) {
    rt.hist = [];
    $("#spDown").textContent = fmtSpeed(0);
    $("#spUp").textContent = fmtSpeed(0);
    $("#miniDown").textContent = "0";
    $("#miniUp").textContent = "0";
    return;
  }
  rt.totals.up += up;
  rt.totals.down += down;
  rt.hist.push({ up, down });
  if (rt.hist.length > 62) rt.hist.shift();
  rt.lastSampleAt = performance.now();
  $("#spDown").textContent = fmtSpeed(down);
  $("#spUp").textContent = fmtSpeed(up);
  $("#miniDown").textContent = fmtShort(down);
  $("#miniUp").textContent = fmtShort(up);
  $("#totDown").textContent = fmtBytes(rt.totals.down);
  $("#totUp").textContent = fmtBytes(rt.totals.up);
  aurora.pulse = Math.min(1, aurora.pulse + Math.min(0.6, down / 4e6));
}

setInterval(() => {
  $("#timer").textContent = rt.status === "on" ? fmtDuration(Date.now() - rt.startedAt) : "00:00:00";
  if (rt.status === "on") $("#titleStatus").textContent = `● ${cleanName(current()?.name)} · ${fmtDuration(Date.now() - rt.startedAt)}`;
}, 1000);

async function fetchExitIp() {
  if (rt.status !== "on") return;
  const btn = $("#btnIpRefresh");
  btn.classList.add("spin");
  $("#ipGeo").textContent = "определяю…";
  try {
    const raw = await call("exit_ip", { port: Number(state.settings.port) });
    const j = JSON.parse(raw);
    const ip = j.ip || j.query;
    const cc = j.country_code || j.countryCode;
    const isp = j.connection?.isp || j.isp || "";
    $("#ipAddr").textContent = ip || "?";
    $("#ipGeo").textContent = [j.city, j.country].filter(Boolean).join(", ") + (isp ? ` · ${isp}` : "");
    $("#ipFlag").innerHTML = flagHtml(cc);
    appLog(`Внешний IP: ${ip} (${j.country || "?"})`);
  } catch (e) {
    $("#ipGeo").textContent = "не удалось определить";
    appLog(`IP не определён: ${e}`);
  }
  btn.classList.remove("spin");
}
$("#btnIpRefresh").addEventListener("click", fetchExitIp);

async function realDelay() {
  if (rt.status !== "on") return;
  const pill = $("#curPing");
  pill.classList.add("loading");
  try {
    let delay;
    if (isMock) delay = Math.round(60 + Math.random() * 90);
    else {
      const url = encodeURIComponent("https://www.gstatic.com/generate_204");
      const r = await fetch(`http://127.0.0.1:${CLASH_PORT}/proxies/proxy/delay?timeout=6000&url=${url}`);
      const j = await r.json();
      delay = j.delay ?? -1;
    }
    rt.realDelay = delay;
  } catch {
    rt.realDelay = -1;
  }
  renderHome();
}
$("#btnRealDelay").addEventListener("click", realDelay);

// ================================================================= speed graph

const graph = $("#graph");
const gctx = graph.getContext("2d");
function cssVar(n) {
  return getComputedStyle(document.body).getPropertyValue(n).trim();
}
let accentCache = {};
function refreshAccentCache() {
  accentCache = { a1: cssVar("--a1"), a2: cssVar("--a2"), a3: cssVar("--a3") };
}

function drawGraph(now) {
  const dpr = devicePixelRatio || 1;
  const w = graph.clientWidth;
  const h = graph.clientHeight;
  if (graph.width !== Math.round(w * dpr)) {
    graph.width = Math.round(w * dpr);
    graph.height = Math.round(h * dpr);
  }
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gctx.clearRect(0, 0, w, h);
  // grid
  gctx.strokeStyle = "rgba(160,180,255,0.06)";
  gctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    gctx.beginPath();
    gctx.moveTo(0, (h / 4) * i);
    gctx.lineTo(w, (h / 4) * i);
    gctx.stroke();
  }
  const H = rt.hist;
  if (H.length > 1) {
    const max = Math.max(65536, ...H.map((s) => Math.max(s.down, s.up))) * 1.15;
    const step = w / 60;
    const shift = Math.min(1, (now - rt.lastSampleAt) / 1000) * step;
    const series = (key, color, fill) => {
      const pts = H.map((s, i) => [w - (H.length - 1 - i) * step - shift + step, h - (s[key] / max) * (h - 8) - 2]);
      gctx.beginPath();
      gctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        const mx = (x0 + x1) / 2;
        gctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
      }
      gctx.strokeStyle = color;
      gctx.lineWidth = 2;
      gctx.shadowColor = color;
      gctx.shadowBlur = 10;
      gctx.stroke();
      gctx.shadowBlur = 0;
      if (fill) {
        gctx.lineTo(pts[pts.length - 1][0], h);
        gctx.lineTo(pts[0][0], h);
        gctx.closePath();
        const g = gctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, color + "55");
        g.addColorStop(1, color + "00");
        gctx.fillStyle = g;
        gctx.fill();
      }
    };
    series("down", accentCache.a1 || "#29f2b8", true);
    series("up", accentCache.a3 || "#d94dff", false);
  } else {
    gctx.fillStyle = "rgba(139,147,184,0.6)";
    gctx.font = "12px Segoe UI";
    gctx.textAlign = "center";
    gctx.fillText(rt.status === "on" ? "ожидаю трафик…" : "график появится после подключения", w / 2, h / 2 + 4);
  }
}

// ================================================================= orb particles

const pcan = $("#orbParticles");
const pctx = pcan.getContext("2d");
const particles = [];
const CX = 210;
const CY = 210;
for (let i = 0; i < 70; i++) {
  particles.push({ a: Math.random() * Math.PI * 2, r: 120 + Math.random() * 70, s: 0.2 + Math.random() * 0.6, z: Math.random(), c: i % 3 });
}
const sparks = [];
function spawnParticle(x, y, outward) {
  const ang = Math.random() * Math.PI * 2;
  const sp = outward ? 2 + Math.random() * 4 : 1;
  sparks.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1, c: Math.floor(Math.random() * 3) });
}
function burstParticles() {
  for (let i = 0; i < 80; i++) spawnParticle(CX, CY, true);
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!document.hidden) {
    drawGraph(now);
    pctx.clearRect(0, 0, 420, 420);
    pctx.globalCompositeOperation = "lighter";
    const cols = [accentCache.a1 || "#29f2b8", accentCache.a2 || "#5a73ff", accentCache.a3 || "#d94dff"];
    const on = rt.status === "on";
    const conn = rt.status === "connecting";
    const energy = aurora.energy ?? 0;
    for (const p of particles) {
      const speed = conn ? 3.5 : on ? 0.6 + aurora.pulse * 2 : 0.15;
      p.a += dt * p.s * speed;
      let r = p.r;
      if (conn) r = 110 + ((p.r - 110 + now / 20) % 80);
      const x = CX + Math.cos(p.a) * r;
      const y = CY + Math.sin(p.a) * r * (0.92 + p.z * 0.08);
      const alpha = (0.15 + energy * 0.75) * (0.4 + p.z * 0.6);
      const size = 0.8 + p.z * 1.8 + energy;
      pctx.fillStyle = cols[p.c];
      pctx.globalAlpha = alpha;
      pctx.beginPath();
      pctx.arc(x, y, size, 0, Math.PI * 2);
      pctx.fill();
      if (on) {
        pctx.globalAlpha = alpha * 0.25;
        pctx.beginPath();
        pctx.arc(x, y, size * 3.5, 0, Math.PI * 2);
        pctx.fill();
      }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.x += s.vx;
      s.y += s.vy;
      s.vx *= 0.96;
      s.vy *= 0.96;
      s.life -= dt * 1.2;
      if (s.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      pctx.globalAlpha = s.life;
      pctx.fillStyle = cols[s.c];
      pctx.beginPath();
      pctx.arc(s.x, s.y, 1.5 + s.life * 2, 0, Math.PI * 2);
      pctx.fill();
    }
    pctx.globalAlpha = 1;
    pctx.globalCompositeOperation = "source-over";
  }
  requestAnimationFrame(frame);
}

// ================================================================= rules & settings binding

function renderRules() {
  $("#optSmart").checked = state.settings.routing === "smart";
  $("#optAds").checked = !!state.settings.blockAds;
  $("#optProxyDomains").value = (state.settings.proxyDomains || []).join("\n");
  $("#optDirectDomains").value = (state.settings.directDomains || []).join("\n");
  $("#optDirectApps").value = (state.settings.directApps || []).join("\n");
}

const lines = (s) =>
  s
    .split(/[\s,;]+/)
    .map((x) => x.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);

$("#optSmart").addEventListener("change", (e) => {
  state.settings.routing = e.target.checked ? "smart" : "global";
  save();
  renderHome();
  reconnectIfOn("Маршрутизация изменена");
});
$("#optAds").addEventListener("change", (e) => {
  state.settings.blockAds = e.target.checked;
  save();
  reconnectIfOn("Блокировка рекламы изменена");
});
$("#btnSaveRules").addEventListener("click", () => {
  state.settings.proxyDomains = lines($("#optProxyDomains").value);
  state.settings.directDomains = lines($("#optDirectDomains").value);
  state.settings.directApps = lines($("#optDirectApps").value).map((a) => (/\.exe$/i.test(a) ? a : `${a}.exe`));
  renderRules();
  save();
  play("click");
  if (rt.status === "on") reconnectIfOn("Правила сохранены");
  else toast("Правила сохранены");
});

function renderSettings() {
  const s = state.settings;
  $("#setEngine").value = s.engine;
  $("#setDns").value = s.dns;
  $("#setPort").value = s.port;
  $("#setStack").value = s.tunStack;
  $("#setFragment").checked = !!s.fragment;
  $("#setLan").checked = !!s.allowLan;
  $("#setLog").value = s.logLevel;
  $("#setAutoConnect").checked = !!state.app.autoConnect;
  $("#setAutoReconnect").checked = !!state.app.autoReconnect;
  $("#setSounds").checked = !!state.app.sounds;
  $("#setSubUpdate").value = String(state.app.subUpdateHours);
  $("#setAutoUpdate").checked = !!state.app.autoUpdateCheck;
  $$("#accents button").forEach((b) => b.classList.toggle("on", b.dataset.accent === state.app.accent));
}

function bindSetting(id, apply, coreSetting = true) {
  $(id).addEventListener("change", (e) => {
    apply(e.target.type === "checkbox" ? e.target.checked : e.target.value);
    save();
    play("click");
    if (coreSetting && rt.status === "on") toast("Применится при следующем подключении");
  });
}
bindSetting("#setEngine", (v) => (state.settings.engine = v));
bindSetting("#setDns", (v) => (state.settings.dns = v));
bindSetting("#setPort", (v) => {
  const n = Math.min(65535, Math.max(1025, parseInt(v, 10) || 2080));
  state.settings.port = n;
  $("#setPort").value = n;
});
bindSetting("#setStack", (v) => (state.settings.tunStack = v));
bindSetting("#setFragment", (v) => (state.settings.fragment = v));
bindSetting("#setLan", (v) => (state.settings.allowLan = v));
bindSetting("#setLog", (v) => (state.settings.logLevel = v));
bindSetting("#setAutoConnect", (v) => (state.app.autoConnect = v), false);
bindSetting("#setAutoReconnect", (v) => (state.app.autoReconnect = v), false);
bindSetting("#setSounds", (v) => (sound.enabled = state.app.sounds = v), false);
bindSetting("#setSubUpdate", (v) => (state.app.subUpdateHours = Number(v)), false);
bindSetting("#setAutoUpdate", (v) => (state.app.autoUpdateCheck = v), false);

// ================================================================= updates

let appVersion = "0.0.0";
let pendingUpdate = null;

function newerVersion(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function checkUpdate(silent) {
  const btn = $("#btnCheckUpdate");
  const status = $("#updateStatus");
  btn.disabled = true;
  if (!silent) status.textContent = "Проверяю…";
  try {
    const info = JSON.parse(await call("check_update"));
    if (newerVersion(info.version, appVersion)) {
      pendingUpdate = info;
      $("#updateCard").classList.add("has-update");
      status.textContent = `Доступна версия ${info.version}${info.notes ? `: ${info.notes}` : ""}`;
      btn.textContent = "Обновить";
      const nav = $('.nav[data-page="settings"]');
      if (!nav.querySelector(".dot")) nav.insertAdjacentHTML("beforeend", '<i class="dot"></i>');
      if (silent) toast(`Вышла Aurora ${info.version}. Обновить можно в Настройках.`);
      else showUpdateModal(info);
    } else {
      status.textContent = `У тебя последняя версия (${appVersion})`;
      if (!silent) toast("Обновлений нет");
    }
  } catch (e) {
    if (!silent) {
      status.textContent = String(e.message || e);
      toast(String(e.message || e), "err");
    }
  }
  btn.disabled = false;
}

function showUpdateModal(info) {
  openModal(
    `<h2>Aurora ${esc(info.version)}</h2>
     <p>Сейчас стоит ${esc(appVersion)}.${info.notes ? ` Что нового: ${esc(info.notes)}` : ""}</p>
     <p>Приложение скачает установщик (~30 МБ), закроется, обновится и запустится снова. VPN на пару секунд отключится.</p>
     <div class="modal-btns"><button class="btn ghost" data-act="later">Позже</button><button class="btn primary" data-act="go">Обновить сейчас</button></div>`,
    (m) => {
      m.querySelector('[data-act="later"]').onclick = closeModal;
      m.querySelector('[data-act="go"]').onclick = () => {
        closeModal();
        installUpdate(info);
      };
    },
  );
}

async function installUpdate(info) {
  showPage("settings");
  $("#updateBar").hidden = false;
  $("#btnCheckUpdate").disabled = true;
  $("#updateStatus").textContent = "Скачиваю обновление…";
  appLog(`Обновление до ${info.version}`);
  try {
    if (rt.status === "on") await disconnect(true);
    await call("save_state", { json: JSON.stringify(state) });
    await call("install_update", { url: info.url });
  } catch (e) {
    $("#updateBar").hidden = true;
    $("#btnCheckUpdate").disabled = false;
    $("#updateStatus").textContent = String(e.message || e);
    toast(String(e.message || e), "err");
  }
}

$("#btnCheckUpdate").addEventListener("click", () => {
  if (pendingUpdate) showUpdateModal(pendingUpdate);
  else checkUpdate(false);
});
$("#setAutostart").addEventListener("change", async (e) => {
  try {
    await call("set_autostart", { enabled: e.target.checked });
    toast(e.target.checked ? "Aurora будет стартовать вместе с Windows" : "Автозапуск выключен");
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(String(err), "err");
  }
});
$("#accents").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.app.accent = b.dataset.accent;
  applyAccent();
  save();
  play("click");
  renderSettings();
});
function applyAccent() {
  document.body.dataset.accent = state.app.accent;
  aurora.palette = PALETTES[state.app.accent] || PALETTES.aurora;
  refreshAccentCache();
}
$("#btnOpenData").addEventListener("click", () => call("open_data_dir"));
$("#btnQuit").addEventListener("click", async () => {
  await disconnect(true);
  call("quit_app");
});

$("#logFilter").addEventListener("input", renderLogs);
$("#btnClearLog").addEventListener("click", () => {
  rt.logs = [];
  renderLogs();
});
$("#btnCopyLog").addEventListener("click", async () => {
  await call("write_clipboard", { text: rt.logs.map((l) => `${l.time} [${l.src}] ${l.line}`).join("\n") }).catch(() => {});
  toast("Журнал скопирован");
});

// ================================================================= keyboard & easter egg

addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === "Escape" && !$("#modalBack").hidden) return closeModal();
  if (typing) return;
  if (e.code === "Space") {
    e.preventDefault();
    toggle();
  } else if (e.ctrlKey && e.key.toLowerCase() === "v") {
    e.preventDefault();
    call("read_clipboard")
      .then((t) => importText(t))
      .catch(() => {});
  } else if (e.ctrlKey && /^[1-5]$/.test(e.key)) {
    showPage(["home", "servers", "rules", "settings", "logs"][Number(e.key) - 1]);
  }
});

let logoClicks = 0;
let logoTimer = null;
$("#brand").addEventListener("click", () => {
  logoClicks++;
  clearTimeout(logoTimer);
  logoTimer = setTimeout(() => (logoClicks = 0), 1200);
  if (logoClicks >= 5) {
    logoClicks = 0;
    aurora.warp = 4;
    play("warp");
    const w = $("#warp");
    w.classList.remove("on");
    void w.offsetWidth;
    w.classList.add("on");
    for (let i = 0; i < 160; i++) spawnParticle(CX, CY, true);
    const keys = Object.keys(PALETTES);
    state.app.accent = keys[(keys.indexOf(state.app.accent) + 1) % keys.length];
    applyAccent();
    renderSettings();
    save();
    toast("Прыжок в гиперпространство ✦ новое сияние");
  }
});

// ================================================================= boot

function renderAll() {
  renderHome();
  renderServers();
  renderRules();
  renderSettings();
}

function seedDemo() {
  if (state.profiles.length) return;
  const PBK = "jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0";
  const U = "bf000d23-0752-40b4-affe-68f7707a9661";
  const demo = [
    `vless://${U}@203.0.113.9:443?type=ws&security=tls&sni=d.example.com#%E2%94%80%E2%94%80%E2%94%80%E2%94%80%20%F0%9F%8C%90%20%D0%94%D0%9B%D0%AF%20%D0%92%D0%A1%D0%95%D0%93%D0%9E%20%E2%94%80%E2%94%80%E2%94%80%E2%94%80`,
    `vless://${U}@203.0.113.10:443?type=tcp&security=reality&sni=www.microsoft.com&fp=chrome&pbk=${PBK}&sid=ab&flow=xtls-rprx-vision#%F0%9F%87%A9%F0%9F%87%AA%20Германия · Франкфурт`,
    `vless://${U}@203.0.113.11:443?type=xhttp&security=reality&sni=www.apple.com&pbk=${PBK}&sid=ab#%F0%9F%87%B3%F0%9F%87%B1%20Нидерланды · XHTTP`,
    `hy2://pass@203.0.113.15:443?sni=hy.example.com#%F0%9F%87%AB%F0%9F%87%AE%20Финляндия · Hysteria`,
    `trojan://pass@203.0.113.12:443?type=ws&path=%2Ftr&sni=t.example.com#%F0%9F%87%BA%F0%9F%87%B8%20США · Нью-Йорк`,
    `ss://${btoa("chacha20-ietf-poly1305:pass")}@203.0.113.13:8388#%F0%9F%87%B9%F0%9F%87%B7%20Турция · Стамбул`,
  ];
  const sub = { id: "demo", url: "https://sub.example.com/demo", title: "Demo VPN", updatedAt: Date.now() - 3600000, userinfo: { upload: 2.1e9, download: 31.4e9, total: 100 * 2 ** 30, expire: Date.now() / 1000 + 86400 * 23 } };
  state.subs.push(sub);
  demo.forEach((l, i) => {
    const p = parseLink(l);
    p.subId = "demo";
    p.ping = [52, 48, 63, 71, 142, 95][i];
    state.profiles.push(p);
  });
  state.selectedId = state.profiles[0].id;
}

(async function boot() {
  aurora = startAurora($("#sky"));
  await load();
  try {
    rt.paths = await call("get_paths");
    rt.admin = await call("is_admin");
  } catch (e) {
    toast(`Бэкенд недоступен: ${e}`, "err");
  }
  if (isMock) {
    $("#demoTag").hidden = false;
    seedDemo();
  }
  sound.enabled = state.app.sounds;
  applyAccent();
  renderAll();
  $("#ipFlag").innerHTML = GLOBE;
  requestAnimationFrame(frame);
  call("get_autostart").then((v) => ($("#setAutostart").checked = !!v)).catch(() => {});
  $("#aboutText").textContent = `Aurora VPN · ядра sing-box и Xray${rt.admin ? " · права администратора" : ""}`;
  call("get_hwid")
    .then((id) => {
      if (id) $("#aboutText").textContent += ` · ID устройства для подписок: ${id.slice(0, 8)}…`;
    })
    .catch(() => {});

  await on("core-log", (l) => logLine(l.src, l.line));
  await on("core-exit", (x) => {
    if (rt.status !== "on" || rt.userStop) return;
    stopTraffic();
    setStatus("off");
    play("error");
    appLog(`${x.name} неожиданно завершился (код ${x.code})`);
    if (state.app.autoReconnect && rt.reconnects < 3) {
      rt.reconnects++;
      toast(`Соединение упало, переподключаюсь (${rt.reconnects}/3)…`, "warn");
      setTimeout(connect, 2000);
    } else {
      showError("Соединение прервано", x.tail || "Ядро завершилось");
    }
  });
  await on("tray-toggle", () => toggle());

  // Clean a system proxy left behind by a crash.
  call("cleanup_proxy", { port: Number(state.settings.port) }).catch(() => {});

  if (state.app.pendingConnect && rt.admin) {
    state.app.pendingConnect = false;
    save();
    connect();
  } else if (state.app.autoConnect && current()) {
    connect();
  }
  if (state.app.pendingConnect) {
    state.app.pendingConnect = false;
    save();
  }
  setTimeout(autoUpdateSubs, 3000);
  try {
    appVersion = await call("get_version");
  } catch {
    /* mock */
  }
  $("#verChip").textContent = `v${appVersion}`;
  await on("update-progress", ({ done, total }) => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    $("#updateFill").style.width = `${pct}%`;
    $("#updateStatus").textContent = total ? `Скачиваю обновление: ${fmtBytes(done)} из ${fmtBytes(total)} (${pct}%)` : `Скачано ${fmtBytes(done)}`;
  });
  if (state.app.autoUpdateCheck) setTimeout(() => checkUpdate(true), 6000);
  setInterval(autoUpdateSubs, 30 * 60000);
  if (current()) setTimeout(() => pingProfiles(state.profiles.filter((p) => !isUdpProtocol(p)).slice(0, 60)), 1200);
})();
