// Offline check: parse fake share links, build configs, validate them with
// `sing-box check` and `xray run -test`. Nothing connects anywhere.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLink, classifyInput, parseSubscriptionBody, toLink } from "../src/core/links.js";
import { buildConfigs, buildLatencyConfig } from "../src/core/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "src-tauri", "bin").replace(/\\/g, "/");
const out = join(root, "tools", "out");
mkdirSync(out, { recursive: true });

const PBK = "jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0";
const UUID = "bf000d23-0752-40b4-affe-68f7707a9661";
const vmessJson = Buffer.from(JSON.stringify({ v: "2", ps: "🇳🇱 NL vmess", add: "203.0.113.5", port: "443", id: UUID, aid: "0", scy: "auto", net: "ws", type: "none", host: "cdn.example.com", path: "/ws?ed=2048", tls: "tls", sni: "cdn.example.com", fp: "chrome" })).toString("base64");

const links = [
  `vless://${UUID}@203.0.113.10:443?type=tcp&security=reality&sni=www.microsoft.com&fp=chrome&pbk=${PBK}&sid=0123abcd&flow=xtls-rprx-vision#%F0%9F%87%A9%F0%9F%87%AA%20Germany%20Reality`,
  `vless://${UUID}@203.0.113.11:443?type=xhttp&security=reality&sni=www.apple.com&fp=chrome&pbk=${PBK}&sid=ab&path=%2Fxh&mode=auto#Finland%20XHTTP`,
  `vless://${UUID}@edge.example.com:443?type=grpc&security=tls&serviceName=grpcsvc&sni=edge.example.com#gRPC`,
  `vmess://${vmessJson}`,
  `trojan://secretpass@203.0.113.12:443?type=ws&path=%2Ftr&host=t.example.com&sni=t.example.com#Trojan%20WS`,
  `ss://${Buffer.from("chacha20-ietf-poly1305:sspass").toString("base64")}@203.0.113.13:8388#SS%20Old`,
  `ss://2022-blake3-aes-128-gcm:${encodeURIComponent("AAAAAAAAAAAAAAAAAAAAAA==")}@203.0.113.14:8443#SS2022`,
  `hy2://hypass@203.0.113.15:443?sni=hy.example.com&obfs=salamander&obfs-password=ob&insecure=1&mport=20000-30000#%F0%9F%87%BA%F0%9F%87%B8%20USA%20Hy2`,
  `tuic://${UUID}:tuicpass@203.0.113.16:443?congestion_control=bbr&alpn=h3&sni=tu.example.com&udp_relay_mode=native#TUIC`,
  `anytls://anypass@203.0.113.20:443?sni=a.example.com&fp=chrome#AnyTLS`,
  `hysteria://203.0.113.21:443?auth=pw&peer=h.example.com&upmbps=50&downmbps=100&obfsParam=x#Hysteria1`,
  `wireguard://${encodeURIComponent("yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=")}@203.0.113.22:51820?publickey=${encodeURIComponent("xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=")}&address=172.16.0.2%2F32&reserved=1,2,3&mtu=1280#WireGuard`,
  `socks://${Buffer.from("user:pass").toString("base64")}@203.0.113.23:1080#SOCKS`,
];

const sing = join(bin, "sing-box.exe");
const xray = join(bin, "xray.exe");
const paths = { rulesDir: `${bin}/rules`, runDir: out.replace(/\\/g, "/") };

let fail = 0;
const variants = [
  { mode: "proxy", routing: "smart", blockAds: true },
  { mode: "tun", routing: "global", blockAds: false, directApps: ["steam.exe"], directDomains: ["example.ru"], proxyDomains: ["youtube.com"], fragment: true },
  { mode: "proxy", routing: "smart", engine: "xray" },
];
links.forEach((l, i) => {
  let p;
  try {
    p = parseLink(l);
  } catch (e) {
    console.log(`PARSE FAIL #${i}: ${e.message}`);
    fail++;
    return;
  }
  variants.forEach((v, j) => {
    const { singbox, xray: xc, engine } = buildConfigs(p, v, paths);
    const f = join(out, `sb_${i}_${j}.json`);
    writeFileSync(f, JSON.stringify(singbox, null, 2));
    let status = "ok";
    try {
      execFileSync(sing, ["check", "-c", f], { stdio: "pipe" });
    } catch (e) {
      status = "SING-BOX FAIL: " + (e.stderr?.toString() || e.message).trim().split("\n").pop();
      fail++;
    }
    if (xc) {
      const xf = join(out, `xr_${i}_${j}.json`);
      writeFileSync(xf, JSON.stringify(xc, null, 2));
      try {
        execFileSync(xray, ["run", "-test", "-c", xf], { stdio: "pipe" });
      } catch (e) {
        status += " | XRAY FAIL: " + (e.stdout?.toString() + e.stderr?.toString()).trim().split("\n").slice(-2).join(" ");
        fail++;
      }
    }
    if (j === 0) console.log(`#${i} ${p.protocol}/${p.network}/${p.security} cc=${p.country || "-"} name="${p.name}" engine=${engine}`);
    console.log(`   [${v.mode}] ${status}`);
  });
});

// Input classification + subscription body
const pasted = `v2raytun://import/https://sub.example.com/abc\n${links[0]}\nhapp://crypt3/AAAA`;
const c = classifyInput(pasted);
console.log("classify:", c.links.length, "links,", c.subs, c.errors.length, "errors");
const sub = Buffer.from(links.join("\n")).toString("base64");
const all = parseSubscriptionBody(sub).profiles;
console.log("subscription body ->", all.length, "profiles");

// Share links generated from profiles must parse back to the same server.
for (const p of all) {
  const back = parseLink(toLink(p));
  if (back.server !== p.server || back.port !== p.port || back.protocol !== p.protocol) {
    console.log("ROUNDTRIP FAIL", p.name);
    fail++;
  }
}

// Clash / Mihomo YAML subscription.
const yaml = `mixed-port: 7890
proxies:
  - name: "🇩🇪 Clash VLESS"
    type: vless
    server: 203.0.113.30
    port: 443
    uuid: ${UUID}
    network: tcp
    tls: true
    flow: xtls-rprx-vision
    servername: www.microsoft.com
    client-fingerprint: chrome
    reality-opts: { public-key: ${PBK}, short-id: ab }
  - name: Clash WS
    type: vmess
    server: c.example.com
    port: 443
    uuid: ${UUID}
    alterId: 0
    cipher: auto
    tls: true
    network: ws
    ws-opts: { path: /ws, headers: { Host: c.example.com } }
  - name: Clash SS
    type: ss
    server: 203.0.113.31
    port: 8388
    cipher: chacha20-ietf-poly1305
    password: pw
  - name: Clash Hy2
    type: hysteria2
    server: 203.0.113.32
    port: 443
    password: pw
    sni: h.example.com
    obfs: salamander
    obfs-password: ob
proxy-groups:
  - name: PROXY
    type: select
    proxies: [Clash WS]
`;
const clash = parseSubscriptionBody(yaml).profiles;
console.log("clash yaml ->", clash.map((p) => `${p.protocol}/${p.network}/${p.security}`).join(", "));
clash.forEach((p, i) => {
  const f = join(out, `clash_${i}.json`);
  writeFileSync(f, JSON.stringify(buildConfigs(p, {}, paths).singbox));
  try {
    execFileSync(sing, ["check", "-c", f], { stdio: "pipe" });
  } catch (e) {
    console.log("CLASH FAIL", p.name, (e.stderr?.toString() || "").trim().split("\n").pop());
    fail++;
  }
});

// Latency-test config with every server at once.
const { config: lat, tags } = buildLatencyConfig([...all, ...clash], paths, 19190);
const lf = join(out, "latency.json");
writeFileSync(lf, JSON.stringify(lat));
try {
  execFileSync(sing, ["check", "-c", lf], { stdio: "pipe" });
  console.log("latency config ok:", Object.keys(tags).length, "servers");
} catch (e) {
  console.log("LATENCY FAIL", (e.stderr?.toString() || "").trim().split("\n").pop());
  fail++;
}
console.log(fail ? `FAILURES: ${fail}` : "ALL OK");
process.exit(fail ? 1 : 0);
