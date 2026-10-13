// Share-link and subscription parsing. Pure functions, no DOM, so Node can test them.

import YAML from "yaml";

export const PROXY_SCHEMES = ["vless", "vmess", "trojan", "ss", "hysteria2", "hy2", "tuic", "anytls", "hysteria", "hy", "wireguard", "wg", "socks", "socks5"];

export function b64decode(input) {
  let s = String(input).trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, "%20"));
  } catch {
    return s;
  }
}

function looksBase64(s) {
  return /^[A-Za-z0-9+/=_\-\s]+$/.test(s) && s.replace(/\s/g, "").length >= 16;
}

let idCounter = 0;
export function newId() {
  idCounter = (idCounter + 1) % 1e6;
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + idCounter.toString(36);
}

// ---------------------------------------------------------------- country detection

const COUNTRY_WORDS = [
  ["DE", /germany|герман|frankfurt|франкфурт|berlin|\bde\b/i],
  ["NL", /netherland|нидерланд|голланд|amsterdam|амстердам|\bnl\b/i],
  ["FI", /finland|финлянд|helsinki|хельсинки|\bfi\b/i],
  ["US", /\busa\b|united states|сша|америк|new york|los angeles|\bus\b/i],
  ["GB", /united kingdom|britain|великобрит|англи|london|лондон|\buk\b|\bgb\b/i],
  ["FR", /france|франц|paris|париж|\bfr\b/i],
  ["PL", /poland|польш|warsaw|варшав|\bpl\b/i],
  ["SE", /sweden|швец|stockholm|\bse\b/i],
  ["TR", /turkey|turkiye|турц|istanbul|стамбул|\btr\b/i],
  ["KZ", /kazakh|казах|almaty|алмат|\bkz\b/i],
  ["RU", /russia|росси|moscow|москв|\bru\b/i],
  ["JP", /japan|япон|tokyo|токио|\bjp\b/i],
  ["SG", /singapore|сингапур|\bsg\b/i],
  ["LV", /latvia|латви|riga|рига|\blv\b/i],
  ["EE", /estonia|эстон|tallinn|\bee\b/i],
  ["LT", /lithuania|литв|vilnius|\blt\b/i],
  ["AT", /austria|австри|vienna|вена|\bat\b/i],
  ["CH", /switzerland|швейцар|zurich|\bch\b/i],
  ["CA", /canada|канад|toronto|\bca\b/i],
  ["HK", /hong ?kong|гонконг|\bhk\b/i],
  ["AM", /armenia|армени|yerevan|\bam\b/i],
  ["GE", /georgia|грузи|tbilisi|\bge\b/i],
  ["AE", /emirates|оаэ|dubai|дубай|\bae\b/i],
  ["IT", /italy|итали|milan|\bit\b/i],
  ["ES", /spain|испани|madrid|\bes\b/i],
  ["CZ", /czech|чехи|prague|прага|\bcz\b/i],
  ["MD", /moldova|молдов|\bmd\b/i],
  ["RS", /serbia|серби|belgrade|\brs\b/i],
  ["BG", /bulgaria|болгар|sofia|\bbg\b/i],
  ["RO", /romania|румын|\bro\b/i],
  ["HU", /hungary|венгр|budapest|\bhu\b/i],
  ["NO", /norway|норвег|oslo|\bno\b/i],
  ["IN", /india|инди|mumbai|\bin\b/i],
  ["KR", /korea|коре|seoul|\bkr\b/i],
  ["BR", /brazil|бразил|\bbr\b/i],
  ["UA", /ukrain|украин|kyiv|киев|\bua\b/i],
  ["BY", /belarus|беларус|minsk|минск|\bby\b/i],
];

/** Pulls a flag emoji (or a known country word) out of a server name. */
export function detectCountry(name) {
  const cps = Array.from(name || "").map((c) => c.codePointAt(0));
  for (let i = 0; i < cps.length - 1; i++) {
    const a = cps[i], b = cps[i + 1];
    if (a >= 0x1f1e6 && a <= 0x1f1ff && b >= 0x1f1e6 && b <= 0x1f1ff) {
      return String.fromCharCode(a - 0x1f1e6 + 65, b - 0x1f1e6 + 65);
    }
  }
  for (const [cc, re] of COUNTRY_WORDS) if (re.test(name || "")) return cc;
  return "";
}

/** Server name without flag emoji, for display next to a real flag image. */
export function cleanName(name) {
  return String(name || "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------- generic URL split

function splitLink(link) {
  const m = /^([a-z0-9+.-]+):\/\/([^#]*?)(?:#(.*))?$/i.exec(link.trim());
  if (!m) throw new Error("Не похоже на ссылку");
  const scheme = m[1].toLowerCase();
  let rest = m[2];
  const name = m[3] !== undefined ? safeDecode(m[3]) : "";
  let query = "";
  const q = rest.indexOf("?");
  if (q >= 0) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  rest = rest.replace(/\/+$/, "");
  let user = "";
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  const { host, port, portSpec } = splitHostPort(rest);
  const params = {};
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = safeDecode(eq >= 0 ? part.slice(0, eq) : part);
    const v = eq >= 0 ? safeDecode(part.slice(eq + 1)) : "";
    params[k] = v;
  }
  return { scheme, user: safeDecode(user), userRaw: user, host, port, portSpec, params, name };
}

function splitHostPort(s) {
  let host, portSpec;
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    host = s.slice(1, end);
    portSpec = s.slice(end + 2);
  } else {
    const c = s.lastIndexOf(":");
    if (c < 0) return { host: s, port: 0, portSpec: "" };
    host = s.slice(0, c);
    portSpec = s.slice(c + 1);
  }
  const port = parseInt(portSpec, 10) || 0;
  return { host, port, portSpec };
}

function bool(v) {
  return v === "1" || v === "true" || v === "True";
}

function list(v) {
  return v ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : [];
}

/** Happ appends "?serverDescription=<base64>" to the name; split it out. */
function splitName(name) {
  const m = /^(.*?)\?serverDescription=([A-Za-z0-9+/=_-]*)\s*$/s.exec(name || "");
  if (!m) return { name: name || "", desc: "" };
  let desc = "";
  try {
    desc = b64decode(m[2]);
  } catch {
    /* ignore */
  }
  return { name: m[1].trim(), desc };
}

/**
 * Providers mark groups with entries like "──── 🌐 ДЛЯ ВСЕГО ────". They are still
 * working servers (Happ lets you pick them), but the UI draws them as section headers.
 */
export function isSectionName(name) {
  return /^\s*[─━—–=\-_~•·]{2,}.*[─━—–=\-_~•·]{2,}\s*$/.test(name || "");
}

function baseProfile(protocol, rawName, server, port, raw) {
  const { name, desc } = splitName(rawName);
  return {
    id: newId(),
    protocol,
    name: name || `${server}:${port}`,
    desc,
    isSection: isSectionName(name),
    country: detectCountry(name),
    server,
    port,
    network: "tcp",
    security: "none",
    alpn: [],
    raw,
  };
}

function applyStreamParams(p, q) {
  p.network = (q.type || q.net || "tcp").toLowerCase();
  if (p.network === "h2") p.network = "http";
  if (p.network === "splithttp") p.network = "xhttp";
  if (p.network === "raw") p.network = "tcp";
  p.security = (q.security || p.security || "none").toLowerCase();
  if (p.security === "xtls") p.security = "tls";
  p.sni = q.sni || q.peer || q.serverName || "";
  p.fp = q.fp || "";
  p.alpn = list(q.alpn);
  p.insecure = bool(q.allowInsecure) || bool(q.insecure) || bool(q.allow_insecure);
  p.pbk = q.pbk || q.publicKey || "";
  p.sid = q.sid || q.shortId || "";
  p.spx = q.spx || "";
  p.path = q.path || "";
  p.host = q.host || "";
  p.serviceName = q.serviceName || q.servicename || (p.network === "grpc" ? q.path || "" : "");
  p.grpcMode = q.mode || "";
  p.xhttpMode = q.mode || "";
  p.headerType = q.headerType || "";
  p.seed = q.seed || "";
  if (q.extra) {
    try {
      p.xhttpExtra = JSON.parse(q.extra);
    } catch {
      /* ignore broken extra */
    }
  }
}

// ---------------------------------------------------------------- per protocol

function parseVless(link) {
  const u = splitLink(link);
  const p = baseProfile("vless", u.name, u.host, u.port, link);
  p.uuid = u.user;
  applyStreamParams(p, u.params);
  p.flow = u.params.flow || "";
  if (p.flow.startsWith("xtls-rprx-vision")) p.flow = "xtls-rprx-vision";
  p.encryption = u.params.encryption || "none";
  return p;
}

function parseTrojan(link) {
  const u = splitLink(link);
  const p = baseProfile("trojan", u.name, u.host, u.port, link);
  p.password = u.user;
  p.security = "tls";
  applyStreamParams(p, u.params);
  if (p.security === "none" && !u.params.security) p.security = "tls";
  return p;
}

function parseVmess(link) {
  const body = link.trim().slice("vmess://".length).split("#")[0];
  let j;
  try {
    j = JSON.parse(b64decode(body));
  } catch {
    // Some clients emit vmess in the vless-like URL form.
    const u = splitLink(link);
    const p = baseProfile("vmess", u.name, u.host, u.port, link);
    p.uuid = u.user;
    p.alterId = parseInt(u.params.aid || "0", 10) || 0;
    p.vmessSecurity = u.params.encryption || u.params.scy || "auto";
    applyStreamParams(p, u.params);
    return p;
  }
  const name = j.ps || "";
  const p = baseProfile("vmess", name, j.add, parseInt(j.port, 10) || 0, link);
  p.uuid = j.id;
  p.alterId = parseInt(j.aid || "0", 10) || 0;
  p.vmessSecurity = j.scy || "auto";
  applyStreamParams(p, {
    type: j.net || "tcp",
    security: j.tls === "tls" || j.tls === "reality" ? j.tls : "none",
    sni: j.sni || "",
    fp: j.fp || "",
    alpn: j.alpn || "",
    path: j.path || "",
    host: j.host || "",
    headerType: j.type || "",
    pbk: j.pbk || "",
    sid: j.sid || "",
    allowInsecure: j.allowInsecure ? "1" : "",
  });
  if (p.network === "grpc") p.serviceName = j.path || "";
  if (p.network === "kcp") p.seed = j.path || "";
  return p;
}

function parseShadowsocks(link) {
  const trimmed = link.trim();
  const hash = trimmed.indexOf("#");
  const name = hash >= 0 ? safeDecode(trimmed.slice(hash + 1)) : "";
  let body = (hash >= 0 ? trimmed.slice(0, hash) : trimmed).slice("ss://".length);
  let query = "";
  const qi = body.indexOf("?");
  if (qi >= 0) {
    query = body.slice(qi + 1);
    body = body.slice(0, qi);
  }
  body = body.replace(/\/+$/, "");
  let userinfo, hostport;
  if (body.includes("@")) {
    const at = body.lastIndexOf("@");
    userinfo = body.slice(0, at);
    hostport = body.slice(at + 1);
    const decoded = safeDecode(userinfo);
    if (!decoded.includes(":")) userinfo = b64decode(userinfo);
    else userinfo = decoded;
  } else {
    const full = b64decode(body);
    const at = full.lastIndexOf("@");
    userinfo = full.slice(0, at);
    hostport = full.slice(at + 1);
  }
  const c = userinfo.indexOf(":");
  const { host, port } = splitHostPort(hostport);
  const p = baseProfile("shadowsocks", name, host, port, link);
  p.method = userinfo.slice(0, c);
  p.password = userinfo.slice(c + 1);
  const params = Object.fromEntries(new URLSearchParams(query));
  if (params.plugin) {
    const parts = params.plugin.split(";");
    p.plugin = parts[0] === "simple-obfs" ? "obfs-local" : parts[0];
    p.pluginOpts = parts.slice(1).join(";");
  }
  return p;
}

function parseHysteria2(link) {
  const u = splitLink(link.replace(/^hy2:\/\//i, "hysteria2://"));
  const p = baseProfile("hysteria2", u.name, u.host, u.port, link);
  p.password = u.user;
  p.security = "tls";
  p.sni = u.params.sni || u.params.peer || "";
  p.insecure = bool(u.params.insecure) || bool(u.params.allowInsecure);
  p.alpn = list(u.params.alpn);
  if (u.params.obfs && u.params.obfs !== "none") {
    p.obfs = u.params.obfs;
    p.obfsPassword = u.params["obfs-password"] || "";
  }
  // Port hopping: "443,20000-30000" in the authority or mport=20000-30000.
  const hop = u.params.mport || (/[,-]/.test(u.portSpec) ? u.portSpec : "");
  if (hop) {
    p.ports = hop.split(",").filter((x) => x.includes("-")).map((r) => r.replace("-", ":"));
    if (!p.port) p.port = parseInt(hop, 10) || 443;
  }
  p.upMbps = parseInt(u.params.upmbps || u.params.up || "0", 10) || 0;
  p.downMbps = parseInt(u.params.downmbps || u.params.down || "0", 10) || 0;
  return p;
}

function parseTuic(link) {
  const u = splitLink(link);
  const p = baseProfile("tuic", u.name, u.host, u.port, link);
  const c = u.user.indexOf(":");
  p.uuid = c >= 0 ? u.user.slice(0, c) : u.user;
  p.password = c >= 0 ? u.user.slice(c + 1) : u.params.password || "";
  p.security = "tls";
  p.sni = u.params.sni || "";
  p.alpn = list(u.params.alpn);
  p.insecure = bool(u.params.allow_insecure) || bool(u.params.insecure) || bool(u.params.allowInsecure);
  p.congestion = u.params.congestion_control || "bbr";
  p.udpRelayMode = u.params.udp_relay_mode || "native";
  return p;
}

function parseAnytls(link) {
  const u = splitLink(link);
  const p = baseProfile("anytls", u.name, u.host, u.port, link);
  p.password = u.user;
  p.security = "tls";
  p.sni = u.params.sni || u.params.peer || "";
  p.fp = u.params.fp || "";
  p.alpn = list(u.params.alpn);
  p.insecure = bool(u.params.insecure) || bool(u.params.allowInsecure);
  return p;
}

/** Hysteria v1: hysteria://host:port?auth=...&peer=...&upmbps=..&downmbps=..&obfsParam=... */
function parseHysteria(link) {
  const u = splitLink(link);
  const p = baseProfile("hysteria", u.name, u.host, u.port, link);
  p.password = u.params.auth || u.params.auth_str || u.user || "";
  p.security = "tls";
  p.sni = u.params.peer || u.params.sni || "";
  p.insecure = bool(u.params.insecure) || bool(u.params.allowInsecure);
  p.alpn = list(u.params.alpn);
  p.obfsPassword = u.params.obfsParam || u.params.obfs || "";
  p.upMbps = parseInt(u.params.upmbps || u.params.up || "0", 10) || 0;
  p.downMbps = parseInt(u.params.downmbps || u.params.down || "0", 10) || 0;
  return p;
}

/** v2rayN style: wireguard://<private key>@host:port?publickey=..&address=..&reserved=..&mtu=.. */
function parseWireguard(link) {
  const u = splitLink(link.replace(/^wg:\/\//i, "wireguard://"));
  const p = baseProfile("wireguard", u.name, u.host, u.port, link);
  p.privateKey = u.user;
  p.peerPublicKey = u.params.publickey || u.params.publicKey || u.params.peer_public_key || "";
  p.preSharedKey = u.params.presharedkey || u.params.preSharedKey || "";
  p.localAddress = list(u.params.address || u.params.ip || "172.16.0.2/32").map((a) => (a.includes("/") ? a : `${a}/${a.includes(":") ? 128 : 32}`));
  p.reserved = list(u.params.reserved).map(Number).filter((n) => !Number.isNaN(n));
  p.mtu = parseInt(u.params.mtu || "0", 10) || 0;
  return p;
}

/** socks://base64(user:pass)@host:port or socks5://user:pass@host:port */
function parseSocks(link) {
  const u = splitLink(link);
  const p = baseProfile("socks", u.name, u.host, u.port, link);
  let cred = u.user;
  if (cred && !cred.includes(":")) {
    try {
      cred = b64decode(u.userRaw);
    } catch {
      /* plain user name */
    }
  }
  const c = cred.indexOf(":");
  p.username = c >= 0 ? cred.slice(0, c) : cred;
  p.password = c >= 0 ? cred.slice(c + 1) : "";
  return p;
}

export function parseLink(link) {
  const scheme = (/^([a-z0-9]+):\/\//i.exec(link.trim()) || [])[1]?.toLowerCase();
  let p;
  switch (scheme) {
    case "vless": p = parseVless(link); break;
    case "vmess": p = parseVmess(link); break;
    case "trojan": p = parseTrojan(link); break;
    case "ss": p = parseShadowsocks(link); break;
    case "hysteria2":
    case "hy2": p = parseHysteria2(link); break;
    case "tuic": p = parseTuic(link); break;
    case "anytls": p = parseAnytls(link); break;
    case "hysteria":
    case "hy": p = parseHysteria(link); break;
    case "wireguard":
    case "wg": p = parseWireguard(link); break;
    case "socks":
    case "socks5": p = parseSocks(link); break;
    default: throw new Error(`Протокол «${scheme || "?"}» не поддерживается`);
  }
  if (!p.server || !p.port) throw new Error("В ссылке нет адреса или порта сервера");
  return p;
}

// ---------------------------------------------------------------- input classification

/**
 * Splits whatever the user pasted into proxy links and subscription URLs.
 * Handles wrapped deep links like v2raytun://import/https://... and base64 blobs.
 */
export function classifyInput(text) {
  const links = [];
  const subs = [];
  const errors = [];
  const visit = (chunk, depth) => {
    for (const raw of chunk.split(/[\r\n]+/)) {
      const line = raw.trim();
      if (!line) continue;
      const scheme = (/^([a-z0-9+.-]+):\/\//i.exec(line) || [])[1]?.toLowerCase();
      if (scheme && PROXY_SCHEMES.includes(scheme)) links.push(line);
      else if (scheme === "http" || scheme === "https") subs.push(line);
      else if (scheme) {
        const inner = /(https?:\/\/\S+)/i.exec(safeDecode(line));
        if (inner) subs.push(inner[1]);
        else if (/^happ$/i.test(scheme) && /crypt/i.test(line))
          errors.push("Зашифрованная ссылка Happ (happ://crypt…) не расшифровывается вне Happ. Попроси у провайдера обычную ссылку подписки https://…");
        else errors.push(`Неизвестный формат: ${line.slice(0, 40)}…`);
      } else if (depth < 2 && looksBase64(line)) {
        try {
          visit(b64decode(line), depth + 1);
        } catch {
          errors.push("Не удалось раскодировать base64");
        }
      } else errors.push(`Не похоже на ключ: ${line.slice(0, 40)}`);
    }
  };
  visit(text, 0);
  return { links, subs, errors };
}

// ---------------------------------------------------------------- JSON subscriptions

const XRAY_PROXY = ["vless", "vmess", "trojan", "shadowsocks", "hysteria", "hysteria2", "wireguard", "socks"];
const SB_PROXY = ["vless", "vmess", "trojan", "shadowsocks", "hysteria2", "tuic", "anytls", "hysteria", "socks"];

function finishProfile(p, name, desc) {
  p.name = name || `${p.server}:${p.port}`;
  p.isSection = isSectionName(p.name);
  p.country = p.isSection ? "" : detectCountry(p.name);
  if (desc) p.desc = desc;
  p.raw = toLink(p);
  if (!p.server || !p.port) throw new Error("нет адреса сервера");
  return p;
}

/** One Xray outbound (as served to Happ / v2rayNG) to a profile. */
function fromXrayOutbound(ob, name, desc, allOutbounds = []) {
  const s = ob.settings || {};
  const vnext = s.vnext?.[0];
  const srv = s.servers?.[0];
  const user = vnext?.users?.[0] || s;
  const protocol = ob.protocol === "hysteria" ? "hysteria2" : ob.protocol;
  const p = { id: newId(), protocol, network: "tcp", security: "none", alpn: [] };
  p.server = vnext?.address || srv?.address || s.address || "";
  p.port = Number(vnext?.port || srv?.port || s.port || 0);
  const st = ob.streamSettings || {};
  // Happ configs chain TLS through a "fragment" freedom outbound to beat DPI.
  const dialer = st.sockopt?.dialerProxy && allOutbounds.find((o) => o.tag === st.sockopt.dialerProxy);
  if (dialer?.protocol === "freedom" && dialer.settings?.fragment) p.fragment = true;

  if (protocol === "wireguard") {
    const peer = s.peers?.[0] || {};
    const ep = String(peer.endpoint || "");
    const c = ep.lastIndexOf(":");
    p.server = ep.slice(0, c).replace(/^\[|\]$/g, "");
    p.port = Number(ep.slice(c + 1));
    p.privateKey = s.secretKey || "";
    p.peerPublicKey = peer.publicKey || "";
    p.preSharedKey = peer.preSharedKey || "";
    p.localAddress = [].concat(s.address || ["172.16.0.2/32"]).map((a) => (a.includes("/") ? a : `${a}/${a.includes(":") ? 128 : 32}`));
    p.reserved = s.reserved || [];
    p.mtu = s.mtu || 0;
    return finishProfile(p, name, desc);
  }
  if (protocol === "socks") {
    const u = srv?.users?.[0] || {};
    p.username = u.user || "";
    p.password = u.pass || "";
    return finishProfile(p, name, desc);
  }

  if (protocol === "hysteria2") {
    const hs = st.hysteriaSettings || {};
    p.password = hs.auth || s.password || "";
    p.security = "tls";
    const tls = st.tlsSettings || {};
    p.sni = tls.serverName || "";
    p.insecure = !!tls.allowInsecure;
    if (hs.udphop?.port) p.ports = String(hs.udphop.port).split(",").filter((x) => x.includes("-")).map((r) => r.replace("-", ":"));
    if (hs.up) p.upMbps = parseInt(hs.up, 10) || 0;
    if (hs.down) p.downMbps = parseInt(hs.down, 10) || 0;
    return finishProfile(p, name, desc);
  }

  if (protocol === "vless" || protocol === "vmess") {
    p.uuid = user.id;
    if (protocol === "vless") {
      p.flow = (user.flow || "").startsWith("xtls-rprx-vision") ? "xtls-rprx-vision" : "";
      p.encryption = user.encryption || "none";
    } else {
      p.alterId = Number(user.alterId || 0);
      p.vmessSecurity = user.security || "auto";
    }
  } else if (protocol === "trojan") {
    p.password = srv?.password || s.password || "";
  } else if (protocol === "shadowsocks") {
    p.password = srv?.password || s.password || "";
    p.method = srv?.method || s.method || "";
  }

  let net = (st.network || "tcp").toLowerCase();
  if (net === "raw") net = "tcp";
  if (net === "splithttp") net = "xhttp";
  if (net === "h2") net = "http";
  p.network = net;
  p.security = (st.security || "none").toLowerCase();
  const tls = p.security === "reality" ? st.realitySettings || {} : st.tlsSettings || {};
  p.sni = tls.serverName || "";
  p.fp = tls.fingerprint || "";
  p.alpn = Array.isArray(tls.alpn) ? tls.alpn : [];
  p.insecure = !!tls.allowInsecure;
  if (p.security === "reality") {
    p.pbk = tls.publicKey || tls.password || "";
    p.sid = tls.shortId || "";
    p.spx = tls.spiderX || "";
  }
  const pick = (o) => ({ path: o?.path || "", host: o?.host || o?.headers?.Host || "" });
  if (net === "ws") Object.assign(p, pick(st.wsSettings));
  if (net === "httpupgrade") Object.assign(p, pick(st.httpupgradeSettings));
  if (net === "http") Object.assign(p, pick(st.httpSettings), { host: [].concat(st.httpSettings?.host || []).join(",") });
  if (net === "grpc") {
    p.serviceName = st.grpcSettings?.serviceName || "";
    p.grpcMode = st.grpcSettings?.multiMode ? "multi" : "";
  }
  if (net === "xhttp") {
    const x = st.xhttpSettings || st.splithttpSettings || {};
    Object.assign(p, pick(x));
    p.xhttpMode = x.mode || "";
    if (x.extra) p.xhttpExtra = x.extra;
  }
  if (net === "kcp") {
    p.headerType = st.kcpSettings?.header?.type || "";
    p.seed = st.kcpSettings?.seed || "";
  }
  if (net === "tcp") {
    const h = (st.rawSettings || st.tcpSettings)?.header;
    if (h?.type === "http") {
      p.headerType = "http";
      p.path = h.request?.path?.[0] || "";
      p.host = [].concat(h.request?.headers?.Host || []).join(",");
    }
  }
  return finishProfile(p, name, desc);
}

/** One sing-box outbound to a profile. */
function fromSingboxOutbound(ob) {
  const p = { id: newId(), protocol: ob.type, network: "tcp", security: "none", alpn: [] };
  p.server = ob.server;
  p.port = Number(ob.server_port || 0);
  p.uuid = ob.uuid;
  p.password = ob.password;
  p.method = ob.method;
  p.flow = ob.flow || "";
  p.alterId = ob.alter_id || 0;
  p.vmessSecurity = ob.security || "auto";
  const tls = ob.tls || {};
  if (tls.enabled) {
    p.security = tls.reality?.enabled ? "reality" : "tls";
    p.sni = tls.server_name || "";
    p.insecure = !!tls.insecure;
    p.alpn = tls.alpn || [];
    p.fp = tls.utls?.fingerprint || "";
    p.pbk = tls.reality?.public_key || "";
    p.sid = tls.reality?.short_id || "";
  }
  const t = ob.transport || {};
  if (t.type) {
    p.network = t.type;
    p.path = t.path || "";
    p.host = t.headers?.Host || [].concat(t.host || []).join(",");
    p.serviceName = t.service_name || "";
  }
  if (ob.type === "hysteria2") {
    p.security = "tls";
    if (ob.obfs?.type) {
      p.obfs = ob.obfs.type;
      p.obfsPassword = ob.obfs.password || "";
    }
    if (ob.server_ports?.length) p.ports = ob.server_ports;
    p.upMbps = ob.up_mbps || 0;
    p.downMbps = ob.down_mbps || 0;
  }
  if (ob.type === "tuic") {
    p.security = "tls";
    p.congestion = ob.congestion_control || "bbr";
    p.udpRelayMode = ob.udp_relay_mode || "native";
  }
  if (ob.type === "shadowsocks" && ob.plugin) {
    p.plugin = ob.plugin;
    p.pluginOpts = ob.plugin_opts || "";
  }
  if (ob.type === "anytls") p.security = "tls";
  if (ob.type === "hysteria") {
    p.security = "tls";
    p.password = ob.auth_str || "";
    p.obfsPassword = ob.obfs || "";
    p.upMbps = ob.up_mbps || 0;
    p.downMbps = ob.down_mbps || 0;
  }
  if (ob.type === "socks") p.username = ob.username || "";
  if (tls.fragment) p.fragment = true;
  return finishProfile(p, ob.tag);
}

/** sing-box 1.11+ WireGuard endpoint to a profile. */
function fromSingboxWireguard(ep) {
  const peer = ep.peers?.[0] || {};
  const p = { id: newId(), protocol: "wireguard", network: "udp", security: "none", alpn: [] };
  p.server = peer.address;
  p.port = Number(peer.port || 0);
  p.privateKey = ep.private_key || "";
  p.peerPublicKey = peer.public_key || "";
  p.preSharedKey = peer.pre_shared_key || "";
  p.localAddress = ep.address || [];
  p.reserved = peer.reserved || [];
  p.mtu = ep.mtu || 0;
  return finishProfile(p, ep.tag);
}

/** Clash / Mihomo YAML proxy entry to a profile. */
function fromClashProxy(c) {
  const type = String(c.type || "").toLowerCase();
  const map = { ss: "shadowsocks", hysteria2: "hysteria2", hy2: "hysteria2", wireguard: "wireguard", socks5: "socks" };
  const protocol = map[type] || type;
  const p = { id: newId(), protocol, network: "tcp", security: "none", alpn: [] };
  p.server = c.server;
  p.port = Number(c.port || 0);
  p.uuid = c.uuid;
  p.password = c.password ?? c["auth-str"] ?? c.auth;
  p.method = c.cipher;
  p.flow = c.flow || "";
  p.alterId = Number(c.alterId || 0);
  p.vmessSecurity = c.cipher && protocol === "vmess" ? c.cipher : "auto";
  if (protocol === "vmess") p.method = undefined;
  if (c.tls || c["reality-opts"] || ["trojan", "hysteria2", "tuic", "anytls", "hysteria"].includes(protocol)) p.security = "tls";
  if (c["reality-opts"]) {
    p.security = "reality";
    p.pbk = c["reality-opts"]["public-key"] || "";
    p.sid = c["reality-opts"]["short-id"] || "";
  }
  p.sni = c.servername || c.sni || "";
  p.fp = c["client-fingerprint"] || "";
  p.alpn = c.alpn || [];
  p.insecure = !!c["skip-cert-verify"];
  const net = c.network || "tcp";
  p.network = net === "h2" ? "http" : net;
  const ws = c["ws-opts"] || {};
  if (net === "ws") {
    p.path = ws.path || "/";
    p.host = ws.headers?.Host || ws.headers?.host || "";
    if (ws["max-early-data"]) p.path += `${p.path.includes("?") ? "&" : "?"}ed=${ws["max-early-data"]}`;
  }
  if (net === "grpc") p.serviceName = c["grpc-opts"]?.["grpc-service-name"] || "";
  if (net === "h2") {
    p.path = c["h2-opts"]?.path || "";
    p.host = [].concat(c["h2-opts"]?.host || []).join(",");
  }
  if (net === "http") {
    p.network = "tcp";
    p.headerType = "http";
    p.path = [].concat(c["http-opts"]?.path || ["/"])[0];
    p.host = [].concat(c["http-opts"]?.headers?.Host || []).join(",");
  }
  if (protocol === "hysteria2") {
    if (c.obfs) {
      p.obfs = c.obfs;
      p.obfsPassword = c["obfs-password"] || "";
    }
    if (c.ports) p.ports = String(c.ports).split(",").filter((x) => x.includes("-")).map((r) => r.replace("-", ":"));
    p.upMbps = parseInt(c.up || "0", 10) || 0;
    p.downMbps = parseInt(c.down || "0", 10) || 0;
  }
  if (protocol === "hysteria") {
    p.obfsPassword = c.obfs || "";
    p.upMbps = parseInt(c.up || "0", 10) || 0;
    p.downMbps = parseInt(c.down || "0", 10) || 0;
  }
  if (protocol === "tuic") {
    p.congestion = c["congestion-controller"] || "bbr";
    p.udpRelayMode = c["udp-relay-mode"] || "native";
  }
  if (protocol === "shadowsocks" && c.plugin) {
    p.plugin = c.plugin === "obfs" ? "obfs-local" : c.plugin;
    const o = c["plugin-opts"] || {};
    p.pluginOpts = c.plugin === "obfs" ? `obfs=${o.mode || "http"};obfs-host=${o.host || ""}` : Object.entries(o).map(([k, v]) => `${k}=${v}`).join(";");
  }
  if (protocol === "wireguard") {
    p.network = "udp";
    p.security = "none";
    p.privateKey = c["private-key"] || "";
    p.peerPublicKey = c["public-key"] || "";
    p.preSharedKey = c["pre-shared-key"] || "";
    p.localAddress = [c.ip && `${c.ip}/32`, c.ipv6 && `${c.ipv6}/128`].filter(Boolean);
    p.reserved = Array.isArray(c.reserved) ? c.reserved : [];
    p.mtu = c.mtu || 0;
  }
  if (protocol === "socks") {
    p.username = c.username || "";
    p.password = c.password || "";
  }
  return finishProfile(p, c.name);
}

const CLASH_PROXY = ["vless", "vmess", "trojan", "ss", "hysteria2", "hy2", "tuic", "anytls", "hysteria", "wireguard", "socks5"];

function parseClashSubscription(doc) {
  const profiles = [];
  const errors = [];
  for (const c of doc?.proxies || []) {
    if (!CLASH_PROXY.includes(String(c?.type || "").toLowerCase())) continue;
    try {
      profiles.push(fromClashProxy(c));
    } catch (e) {
      errors.push(`${c?.name || "?"}: ${e.message}`);
    }
  }
  return { profiles, errors };
}

function parseJsonSubscription(data) {
  const profiles = [];
  const errors = [];
  const configs = Array.isArray(data) ? data : [data];
  for (const cfg of configs) {
    const outs = cfg?.outbounds || [];
    try {
      if (outs.some((o) => o.protocol)) {
        // Xray full config per server (Happ, v2rayNG, Streisand style).
        const ob = outs.find((o) => o.tag === "proxy" && XRAY_PROXY.includes(o.protocol)) || outs.find((o) => XRAY_PROXY.includes(o.protocol));
        if (ob) profiles.push(fromXrayOutbound(ob, cfg.remarks || cfg.meta?.name, cfg.meta?.serverDescription, outs));
      } else {
        // sing-box config: every proxy outbound (and WireGuard endpoint) is a server.
        for (const ob of outs.filter((o) => SB_PROXY.includes(o.type))) profiles.push(fromSingboxOutbound(ob));
        for (const ep of (cfg?.endpoints || []).filter((e) => e.type === "wireguard")) profiles.push(fromSingboxWireguard(ep));
      }
    } catch (e) {
      errors.push(`${cfg?.remarks || "?"}: ${e.message}`);
    }
  }
  return { profiles, errors };
}

// ---------------------------------------------------------------- share links out

function enc(s) {
  return encodeURIComponent(s ?? "");
}

function hostPort(p) {
  return `${p.server.includes(":") ? `[${p.server}]` : p.server}:${p.port}`;
}

/** Builds a standard share link from a profile (for QR codes and copying). */
export function toLink(p) {
  const name = `#${enc(p.name)}`;
  const q = new URLSearchParams();
  const put = (k, v) => v && q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  const stream = () => {
    put("type", p.network);
    put("security", p.security !== "none" ? p.security : "");
    put("sni", p.sni);
    put("fp", p.fp);
    put("alpn", p.alpn);
    put("pbk", p.pbk);
    put("sid", p.sid);
    put("spx", p.spx);
    put("path", p.path);
    put("host", p.host);
    put("serviceName", p.serviceName);
    put("mode", p.network === "grpc" ? p.grpcMode : p.xhttpMode);
    put("headerType", p.headerType);
    put("seed", p.seed);
    if (p.xhttpExtra) put("extra", JSON.stringify(p.xhttpExtra));
    if (p.insecure) put("allowInsecure", "1");
  };
  switch (p.protocol) {
    case "vless":
      put("encryption", p.encryption || "none");
      put("flow", p.flow);
      stream();
      return `vless://${enc(p.uuid)}@${hostPort(p)}?${q}${name}`;
    case "trojan":
      stream();
      return `trojan://${enc(p.password)}@${hostPort(p)}?${q}${name}`;
    case "vmess": {
      const j = { v: "2", ps: p.name, add: p.server, port: String(p.port), id: p.uuid, aid: String(p.alterId || 0), scy: p.vmessSecurity || "auto", net: p.network, type: p.headerType || "none", host: p.host || "", path: p.network === "grpc" ? p.serviceName || "" : p.path || "", tls: p.security === "none" ? "" : p.security, sni: p.sni || "", alpn: (p.alpn || []).join(","), fp: p.fp || "" };
      const bytes = new TextEncoder().encode(JSON.stringify(j));
      return `vmess://${btoa(String.fromCharCode(...bytes))}`;
    }
    case "shadowsocks":
      return `ss://${btoa(`${p.method}:${p.password}`)}@${hostPort(p)}${name}`;
    case "hysteria2":
      put("sni", p.sni);
      if (p.insecure) put("insecure", "1");
      if (p.obfs) {
        put("obfs", p.obfs);
        put("obfs-password", p.obfsPassword);
      }
      if (p.ports?.length) put("mport", p.ports.map((r) => r.replace(":", "-")).join(","));
      return `hysteria2://${enc(p.password)}@${hostPort(p)}?${q}${name}`;
    case "tuic":
      put("sni", p.sni);
      put("alpn", p.alpn);
      put("congestion_control", p.congestion);
      put("udp_relay_mode", p.udpRelayMode);
      if (p.insecure) put("allow_insecure", "1");
      return `tuic://${enc(p.uuid)}:${enc(p.password)}@${hostPort(p)}?${q}${name}`;
    case "anytls":
      put("sni", p.sni);
      put("fp", p.fp);
      put("alpn", p.alpn);
      if (p.insecure) put("insecure", "1");
      return `anytls://${enc(p.password)}@${hostPort(p)}?${q}${name}`;
    case "hysteria":
      put("auth", p.password);
      put("peer", p.sni);
      put("alpn", p.alpn);
      put("obfsParam", p.obfsPassword);
      if (p.upMbps) put("upmbps", p.upMbps);
      if (p.downMbps) put("downmbps", p.downMbps);
      if (p.insecure) put("insecure", "1");
      return `hysteria://${hostPort(p)}?${q}${name}`;
    case "wireguard":
      put("publickey", p.peerPublicKey);
      put("presharedkey", p.preSharedKey);
      put("address", p.localAddress);
      put("reserved", p.reserved?.length ? p.reserved : "");
      if (p.mtu) put("mtu", p.mtu);
      return `wireguard://${enc(p.privateKey)}@${hostPort(p)}?${q}${name}`;
    case "socks":
      return `socks://${p.username ? `${btoa(`${p.username}:${p.password || ""}`)}@` : ""}${hostPort(p)}${name}`;
    default:
      return "";
  }
}

/**
 * Body of a subscription response: base64 or plain list of links, an Xray JSON
 * array (Happ style) or a sing-box JSON config.
 */
export function parseSubscriptionBody(body) {
  let text = String(body || "").trim();
  if (!text) throw new Error("Подписка пустая");
  if (/^<(!doctype|html|head|body|meta)/i.test(text)) throw new Error("Провайдер отдал веб-страницу вместо ключей");
  if (/^proxies:\s*$/m.test(text)) {
    // Clash / Mihomo YAML (served to Clash Verge, FlClash, Stash...).
    let doc;
    try {
      doc = YAML.parse(text);
    } catch {
      throw new Error("Подписка вернула повреждённый Clash YAML");
    }
    const r = parseClashSubscription(doc);
    const stubC = r.profiles.find(isStubProfile);
    if (stubC) throw new Error(`Провайдер вернул заглушку: «${cleanName(stubC.name)}»`);
    if (!r.profiles.length) throw new Error(r.errors[0] || "В Clash-подписке нет поддерживаемых серверов");
    return r;
  }
  if (!/^[a-z0-9]+:\/\//im.test(text) && !/^[{[]/.test(text) && looksBase64(text)) {
    try {
      text = b64decode(text);
    } catch {
      /* keep as is */
    }
  }
  let result;
  if (/^\s*[{[]/.test(text)) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Подписка вернула повреждённый JSON");
    }
    result = parseJsonSubscription(data);
  } else {
    result = { profiles: [], errors: [] };
    for (const line of text.split(/[\r\n]+/)) {
      const l = line.trim();
      const scheme = (/^([a-z0-9]+):\/\//i.exec(l) || [])[1]?.toLowerCase();
      // Skip service lines such as happ://routing/... silently.
      if (!scheme || !PROXY_SCHEMES.includes(scheme)) continue;
      try {
        result.profiles.push(parseLink(l));
      } catch (e) {
        result.errors.push(`${l.slice(0, 30)}…: ${e.message}`);
      }
    }
  }
  // Providers answer clients they do not like with fake "servers" whose names say
  // "app not supported" (often at 0.0.0.0:1). Real keys never come mixed with those.
  const stub = result.profiles.find(isStubProfile);
  if (stub) throw new Error(`Провайдер вернул заглушку: «${cleanName(stub.name)}»`);
  if (!result.profiles.length) throw new Error(result.errors[0] || "В подписке нет поддерживаемых ключей");
  return result;
}

function isStubProfile(p) {
  return (
    p.server === "0.0.0.0" ||
    p.server === "127.0.0.1" ||
    p.port <= 1 ||
    /не поддерживается|не поддерживает|обновите приложени|not supported|unsupported|update (your|the) app/i.test(p.name)
  );
}

/** User-Agents tried in order: providers pick the response format (or refuse) by UA. */
// Happ first: providers give it the fullest list (sections, descriptions), the same
// one the user sees in Happ on the phone.
export const SUB_USER_AGENTS = ["Happ/3.10.0", "v2rayN/7.10", "sing-box 1.14.3", "clash-verge/v2.2.3", "v2rayNG/1.10.5"];

export function parseUserInfo(header) {
  if (!header) return null;
  const out = {};
  for (const part of header.split(";")) {
    const [k, v] = part.split("=").map((s) => s && s.trim());
    if (k && v) out[k] = Number(v);
  }
  return out;
}

export function decodeTitle(v) {
  if (!v) return "";
  if (v.startsWith("base64:")) {
    try {
      return b64decode(v.slice(7));
    } catch {
      return v;
    }
  }
  return v;
}

/** True when sing-box cannot speak this profile and Xray must carry it. */
export function needsXray(p) {
  if (!["vless", "vmess", "trojan", "shadowsocks"].includes(p.protocol)) return false;
  if (["xhttp", "kcp", "quic"].includes(p.network)) return true;
  if (p.protocol === "vless" && p.encryption && p.encryption !== "none") return true;
  if (p.network === "tcp" && p.headerType === "http") return true;
  return false;
}

// ---------------------------------------------------------------- smart categories

/** Ordered: the first matching category wins, the list order is the display order. */
export const SERVER_CATEGORIES = [
  { id: "auto", title: "✨ Авто-выбор", re: /\bauto\b|авто|самый быстр|лучш|best|балансир/i },
  { id: "game", title: "⚡ Игровые и быстрые", re: /игр|game|gaming|быстр|fast|low.?ping|пинг|⚡|🎮|brawl|pubg|standoff|cs2|dota|valorant/i },
  { id: "lte", title: "📶 Для LTE и мобильного", re: /\blte\b|\b[45]g\b|мобил|mobile|сотов|cellular|📶/i },
  { id: "bypass", title: "🛡 Обход белых списков", re: /бел(ые|ых) спис|whitelist|обход|bypass|антиглуш|глуш|wl\b/i },
  { id: "video", title: "🎬 YouTube и видео", re: /youtube|ютуб|\byt\b|stream|видео|video|twitch|netflix|кино|🎬|📺/i },
  { id: "ai", title: "🤖 Нейросети", re: /нейро|neuro|\bai\b|\bии\b|gpt|openai|claude|gemini|🤖/i },
  { id: "reserve", title: "🛟 Запасные", re: /запас|резерв|reserve|backup|🛟/i },
];
const MAIN_CATEGORY = { id: "main", title: "🌍 Основные" };

/** Category of a server by keywords in its name and provider description. */
export function serverCategory(p) {
  const text = `${p.name || ""} ${p.desc || ""}`;
  return SERVER_CATEGORIES.find((c) => c.re.test(text)) || MAIN_CATEGORY;
}

/** Display order of categories, main servers just before the reserve ones. */
export function categoryOrder(id) {
  const order = ["auto", "game", "lte", "bypass", "video", "ai", "main", "reserve"];
  const i = order.indexOf(id);
  return i < 0 ? order.length : i;
}

export function isUdpProtocol(p) {
  return ["hysteria2", "hysteria", "tuic", "wireguard"].includes(p.protocol);
}

export function protocolLabel(p) {
  const map = { vless: "VLESS", vmess: "VMess", trojan: "Trojan", shadowsocks: "Shadowsocks", hysteria2: "Hysteria2", hysteria: "Hysteria", tuic: "TUIC", anytls: "AnyTLS", wireguard: "WireGuard", socks: "SOCKS5" };
  const parts = [map[p.protocol] || p.protocol];
  if (p.security === "reality") parts.push("Reality");
  else if (p.security === "tls" && !isUdpProtocol(p)) parts.push("TLS");
  if (p.network && p.network !== "tcp" && !isUdpProtocol(p)) parts.push(p.network.toUpperCase());
  return parts.join(" · ");
}
