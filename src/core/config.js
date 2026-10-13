// Builds sing-box (and, for xhttp/kcp keys, Xray) configs from a parsed profile.
// sing-box always owns the inbounds (mixed proxy / TUN), routing, DNS and stats.
// When the key needs Xray, Xray runs as a local SOCKS hop and sing-box chains to it.

import { needsXray, isUdpProtocol } from "./links.js";

export const XRAY_PORT = 20808;
export const CLASH_PORT = 9095;

export const DEFAULT_SETTINGS = {
  mode: "proxy", // proxy | tun
  routing: "smart", // global | smart
  blockAds: true,
  port: 2080,
  allowLan: false,
  engine: "auto", // auto | singbox | xray
  dns: "cloudflare",
  fragment: false,
  tunStack: "mixed",
  logLevel: "warn",
  directDomains: [],
  proxyDomains: [],
  directApps: [],
};

const DNS_IPS = {
  cloudflare: "1.1.1.1",
  google: "8.8.8.8",
  quad9: "9.9.9.9",
  adguard: "94.140.14.14",
};

const RU_SUFFIXES = ["ru", "su", "xn--p1ai", "xn--d1acj3b", "by", "kz"];

function isIp(s) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":");
}

function canXray(p) {
  return ["vless", "vmess", "trojan", "shadowsocks"].includes(p.protocol);
}

// ---------------------------------------------------------------- sing-box outbound

function sbTls(p, s) {
  if (p.security === "none" || !p.security) return undefined;
  const tls = { enabled: true };
  const sni = p.sni || (isIp(p.server) ? "" : p.server);
  if (sni) tls.server_name = sni;
  if (p.insecure) tls.insecure = true;
  if (p.alpn?.length) tls.alpn = p.alpn;
  else if (isUdpProtocol(p)) tls.alpn = ["h3"];
  if (p.security === "reality") {
    tls.utls = { enabled: true, fingerprint: p.fp || "chrome" };
    tls.reality = { enabled: true, public_key: p.pbk, short_id: p.sid || "" };
  } else if (!isUdpProtocol(p)) {
    if (p.fp) tls.utls = { enabled: true, fingerprint: p.fp };
    if (s.fragment || p.fragment) tls.fragment = true;
  }
  return tls;
}

function sbTransport(p) {
  switch (p.network) {
    case "ws": {
      const t = { type: "ws", path: p.path || "/" };
      const ed = /[?&]ed=(\d+)/.exec(t.path);
      if (ed) {
        t.path = t.path.replace(/[?&]ed=\d+/, "") || "/";
        t.max_early_data = Number(ed[1]);
        t.early_data_header_name = "Sec-WebSocket-Protocol";
      }
      if (p.host) t.headers = { Host: p.host };
      return t;
    }
    case "grpc":
      return { type: "grpc", service_name: p.serviceName || "" };
    case "http": {
      const t = { type: "http" };
      if (p.host) t.host = p.host.split(",").map((x) => x.trim());
      if (p.path) t.path = p.path;
      return t;
    }
    case "httpupgrade": {
      const t = { type: "httpupgrade", path: p.path || "/" };
      if (p.host) t.host = p.host;
      return t;
    }
    default:
      return undefined;
  }
}

function sbOutbound(p, s) {
  const base = { tag: "proxy", server: p.server, server_port: p.port };
  const tls = sbTls(p, s);
  const transport = sbTransport(p);
  switch (p.protocol) {
    case "vless": {
      const o = { type: "vless", ...base, uuid: p.uuid, packet_encoding: "xudp" };
      if (p.flow && p.network === "tcp") o.flow = p.flow;
      if (tls) o.tls = tls;
      if (transport) o.transport = transport;
      return o;
    }
    case "vmess": {
      const o = { type: "vmess", ...base, uuid: p.uuid, security: p.vmessSecurity || "auto", alter_id: p.alterId || 0 };
      if (tls) o.tls = tls;
      if (transport) o.transport = transport;
      return o;
    }
    case "trojan": {
      const o = { type: "trojan", ...base, password: p.password };
      if (tls) o.tls = tls;
      if (transport) o.transport = transport;
      return o;
    }
    case "shadowsocks": {
      const o = { type: "shadowsocks", ...base, method: p.method, password: p.password };
      if (p.plugin) {
        o.plugin = p.plugin;
        if (p.pluginOpts) o.plugin_opts = p.pluginOpts;
      }
      return o;
    }
    case "hysteria2": {
      const o = { type: "hysteria2", ...base, password: p.password, tls };
      if (p.ports?.length) o.server_ports = p.ports;
      if (p.obfs) o.obfs = { type: p.obfs, password: p.obfsPassword || "" };
      if (p.upMbps) o.up_mbps = p.upMbps;
      if (p.downMbps) o.down_mbps = p.downMbps;
      return o;
    }
    case "tuic":
      return {
        type: "tuic",
        ...base,
        uuid: p.uuid,
        password: p.password,
        congestion_control: p.congestion || "bbr",
        udp_relay_mode: p.udpRelayMode || "native",
        tls,
      };
    case "anytls":
      return { type: "anytls", ...base, password: p.password, tls };
    case "hysteria": {
      const o = { type: "hysteria", ...base, auth_str: p.password, up_mbps: p.upMbps || 50, down_mbps: p.downMbps || 100, tls };
      if (p.obfsPassword) o.obfs = p.obfsPassword;
      return o;
    }
    case "socks": {
      const o = { type: "socks", ...base, version: "5" };
      if (p.username) {
        o.username = p.username;
        o.password = p.password || "";
      }
      return o;
    }
    default:
      throw new Error(`Протокол ${p.protocol} не поддерживается`);
  }
}

// ---------------------------------------------------------------- Xray outbound

function xrayStream(p) {
  const st = { network: p.network === "tcp" ? "raw" : p.network, security: p.security || "none" };
  const sni = p.sni || (isIp(p.server) ? "" : p.server);
  if (p.security === "tls") {
    st.tlsSettings = { serverName: sni || undefined, fingerprint: p.fp || "chrome" };
    if (p.alpn?.length) st.tlsSettings.alpn = p.alpn;
    if (p.insecure) st.tlsSettings.allowInsecure = true;
  } else if (p.security === "reality") {
    st.realitySettings = {
      serverName: sni,
      fingerprint: p.fp || "chrome",
      publicKey: p.pbk,
      shortId: p.sid || "",
      spiderX: p.spx || "",
    };
  }
  switch (p.network) {
    case "ws":
      st.wsSettings = { path: p.path || "/", host: p.host || undefined };
      break;
    case "grpc":
      st.grpcSettings = { serviceName: p.serviceName || "", multiMode: p.grpcMode === "multi" };
      break;
    case "httpupgrade":
      st.httpupgradeSettings = { path: p.path || "/", host: p.host || undefined };
      break;
    case "xhttp":
      st.xhttpSettings = { path: p.path || "/", host: p.host || undefined, mode: p.xhttpMode || "auto" };
      if (p.xhttpExtra) st.xhttpSettings.extra = p.xhttpExtra;
      break;
    case "kcp":
      st.kcpSettings = { header: { type: p.headerType || "none" } };
      if (p.seed) st.kcpSettings.seed = p.seed;
      break;
    case "tcp":
      if (p.headerType === "http") {
        st.rawSettings = {
          header: {
            type: "http",
            request: { path: [p.path || "/"], headers: p.host ? { Host: p.host.split(",") } : {} },
          },
        };
      }
      break;
  }
  return st;
}

function xrayOutbound(p) {
  const streamSettings = xrayStream(p);
  switch (p.protocol) {
    case "vless": {
      const user = { id: p.uuid, encryption: p.encryption || "none" };
      if (p.flow) user.flow = p.flow;
      return { tag: "proxy", protocol: "vless", settings: { vnext: [{ address: p.server, port: p.port, users: [user] }] }, streamSettings };
    }
    case "vmess":
      return {
        tag: "proxy",
        protocol: "vmess",
        settings: { vnext: [{ address: p.server, port: p.port, users: [{ id: p.uuid, alterId: p.alterId || 0, security: p.vmessSecurity || "auto" }] }] },
        streamSettings,
      };
    case "trojan":
      return { tag: "proxy", protocol: "trojan", settings: { servers: [{ address: p.server, port: p.port, password: p.password }] }, streamSettings };
    case "shadowsocks":
      return {
        tag: "proxy",
        protocol: "shadowsocks",
        settings: { servers: [{ address: p.server, port: p.port, method: p.method, password: p.password }] },
        streamSettings,
      };
    default:
      throw new Error(`Xray не поддерживает ${p.protocol}`);
  }
}

// ---------------------------------------------------------------- full configs

/**
 * @returns {{ singbox: object, xray: object|null, engine: string }}
 */
export function buildConfigs(p, settings, paths) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const xrayRequired = needsXray(p);
  if (xrayRequired && s.engine === "singbox")
    throw new Error("Этот ключ (xhttp / kcp / VLESS-encryption) sing-box не умеет. Поставь движок «Авто» или «Xray».");
  const useXray = canXray(p) && (xrayRequired || s.engine === "xray");

  const rulesDir = paths.rulesDir;
  const smart = s.routing === "smart";
  const ruleSets = [];
  const addSet = (tag, file) => {
    if (!ruleSets.find((r) => r.tag === tag))
      ruleSets.push({ type: "local", tag, format: "binary", path: `${rulesDir}/${file}` });
  };

  // --- inbounds
  const inbounds = [
    { type: "mixed", tag: "mixed-in", listen: s.allowLan ? "0.0.0.0" : "127.0.0.1", listen_port: Number(s.port) || 2080 },
  ];
  // On Android the VpnService TUN belongs to Xray (in-process); sing-box is only the
  // local proxy behind it, and per-app bypass is done by the VpnService itself.
  const android = s.platform === "android";
  if (android) {
    s.mode = "proxy";
    s.directApps = [];
  }
  if (s.mode === "tun") {
    inbounds.unshift({
      type: "tun",
      tag: "tun-in",
      interface_name: "AuroraTun",
      address: ["172.19.0.1/30"],
      mtu: 9000,
      auto_route: true,
      strict_route: true,
      stack: s.tunStack || "mixed",
    });
  }

  // --- outbounds
  // WireGuard is an endpoint in sing-box 1.11+, everything else an outbound; both answer to tag "proxy".
  const endpoints = [];
  const outbounds = [{ type: "direct", tag: "direct" }];
  if (p.protocol === "wireguard") endpoints.push(sbWireguard(p, "proxy"));
  else
    outbounds.unshift(
      useXray ? { type: "socks", tag: "proxy", server: "127.0.0.1", server_port: XRAY_PORT, version: "5" } : sbOutbound(p, s),
    );

  // --- route
  const rules = [
    { action: "sniff" },
    { protocol: "dns", action: "hijack-dns" },
    { ip_is_private: true, outbound: "direct" },
  ];
  const directApps = (s.directApps || []).filter(Boolean);
  if (useXray && !android) directApps.push("xray.exe");
  if (directApps.length) rules.push({ process_name: [...new Set(directApps)], outbound: "direct" });
  if (s.proxyDomains?.length) rules.push({ domain_suffix: s.proxyDomains, outbound: "proxy" });
  if (s.blockAds) {
    addSet("ads", "geosite-category-ads-all.srs");
    rules.push({ rule_set: "ads", action: "reject" });
  }
  if (s.directDomains?.length) rules.push({ domain_suffix: s.directDomains, outbound: "direct" });
  if (smart) {
    addSet("geosite-ru", "geosite-category-ru.srs");
    addSet("geoip-ru", "geoip-ru.srs");
    rules.push({ domain_suffix: RU_SUFFIXES, outbound: "direct" });
    rules.push({ rule_set: ["geosite-ru", "geoip-ru"], outbound: "direct" });
  }

  // --- dns
  const dnsRules = [];
  if (s.directDomains?.length) dnsRules.push({ domain_suffix: s.directDomains, server: "direct-dns" });
  if (smart) {
    dnsRules.push({ domain_suffix: RU_SUFFIXES, server: "direct-dns" });
    dnsRules.push({ rule_set: "geosite-ru", server: "direct-dns" });
  }

  const singbox = {
    log: { level: s.logLevel || "warn", timestamp: true },
    dns: {
      servers: [
        { type: "https", tag: "remote", server: DNS_IPS[s.dns] || "1.1.1.1", detour: "proxy" },
        { type: "udp", tag: "direct-dns", server: "77.88.8.8" },
      ],
      rules: dnsRules,
      final: "remote",
      strategy: "ipv4_only",
    },
    inbounds,
    outbounds,
    route: {
      rules,
      rule_set: ruleSets,
      final: "proxy",
      auto_detect_interface: !android,
      default_domain_resolver: "direct-dns",
    },
    experimental: {
      cache_file: { enabled: true, path: `${paths.runDir}/cache.db` },
      clash_api: { external_controller: `127.0.0.1:${CLASH_PORT}` },
    },
  };
  if (directApps.length) singbox.route.find_process = true;

  const xray = useXray
    ? {
        log: { loglevel: s.logLevel === "info" || s.logLevel === "debug" ? "info" : "warning" },
        inbounds: [
          { tag: "socks-in", listen: "127.0.0.1", port: XRAY_PORT, protocol: "socks", settings: { udp: true, auth: "noauth" } },
        ],
        outbounds: [xrayOutbound(p), { tag: "direct", protocol: "freedom" }],
      }
    : null;

  if (endpoints.length) singbox.endpoints = endpoints;
  return { singbox, xray, engine: useXray ? "Xray → sing-box" : "sing-box" };
}

function sbWireguard(p, tag) {
  const peer = { address: p.server, port: p.port, public_key: p.peerPublicKey, allowed_ips: ["0.0.0.0/0", "::/0"] };
  if (p.preSharedKey) peer.pre_shared_key = p.preSharedKey;
  if (p.reserved?.length === 3) peer.reserved = p.reserved;
  const ep = { type: "wireguard", tag, address: p.localAddress?.length ? p.localAddress : ["172.16.0.2/32"], private_key: p.privateKey, peers: [peer] };
  if (p.mtu) ep.mtu = p.mtu;
  return ep;
}

/**
 * A throwaway sing-box config for "real delay" tests: every server becomes an
 * outbound tagged t<index>, there are no inbounds (nothing on the PC routes through
 * it) and the Clash API on `port` measures each one. Xray-only keys are skipped.
 * @returns {{ config: object, tags: Record<string, string> }} tags maps tag -> profile id
 */
export function buildLatencyConfig(profiles, paths, port) {
  const outbounds = [{ type: "direct", tag: "direct" }];
  const endpoints = [];
  const tags = {};
  profiles.forEach((p, i) => {
    if (needsXray(p)) return;
    const tag = `t${i}`;
    try {
      if (p.protocol === "wireguard") endpoints.push(sbWireguard(p, tag));
      else outbounds.push({ ...sbOutbound(p, DEFAULT_SETTINGS), tag });
      tags[tag] = p.id;
    } catch {
      /* unsupported profile: no result */
    }
  });
  const config = {
    log: { level: "error" },
    dns: { servers: [{ type: "udp", tag: "d", server: "77.88.8.8" }], strategy: "ipv4_only" },
    outbounds,
    route: { final: "direct", default_domain_resolver: "d" },
    experimental: { clash_api: { external_controller: `127.0.0.1:${port}` } },
  };
  if (endpoints.length) config.endpoints = endpoints;
  return { config, tags };
}
