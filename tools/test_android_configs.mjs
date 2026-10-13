// Offline check of the Android pipeline configs: sing-box in platform=android mode and
// the Xray config AuroraVpnService builds (TUN in -> SOCKS to sing-box, plus the
// optional XHTTP hop). Validated with the desktop cores; nothing connects anywhere.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLink } from "../src/core/links.js";
import { buildConfigs } from "../src/core/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "src-tauri", "bin").replace(/\\/g, "/");
const out = join(root, "tools", "out");
mkdirSync(out, { recursive: true });
const PBK = "jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0";
const UUID = "bf000d23-0752-40b4-affe-68f7707a9661";
const links = [
  `vless://${UUID}@203.0.113.10:443?type=tcp&security=reality&sni=www.microsoft.com&fp=chrome&pbk=${PBK}&sid=ab&flow=xtls-rprx-vision#Reality`,
  `vless://${UUID}@203.0.113.11:443?type=xhttp&security=reality&sni=www.apple.com&pbk=${PBK}&sid=ab&path=%2Fx#XHTTP`,
  `hy2://pw@203.0.113.15:443?sni=h.example.com#Hy2`,
];

// Mirror of AuroraVpnService.xrayConfig().
function xrayConfig(port, hop) {
  const cfg = {
    log: { loglevel: "warning" },
    inbounds: [{ tag: "tun-in", protocol: "tun", settings: { name: "xray0", MTU: 1500, userLevel: 0 } }],
    outbounds: [{ tag: "to-singbox", protocol: "socks", settings: { servers: [{ address: "127.0.0.1", port }] } }],
    routing: { domainStrategy: "AsIs", rules: [{ type: "field", inboundTag: ["tun-in"], outboundTag: "to-singbox" }] },
  };
  if (hop) {
    cfg.inbounds.push(...hop.inbounds);
    cfg.outbounds.push(...hop.outbounds);
    cfg.routing.rules.push({ type: "field", inboundTag: ["socks-in"], outboundTag: "proxy" });
  }
  return cfg;
}

let fail = 0;
for (const [i, l] of links.entries()) {
  const p = parseLink(l);
  const { singbox, xray, engine } = buildConfigs(p, { platform: "android", mode: "tun", directApps: ["x.exe"] }, { rulesDir: `${bin}/rules`, runDir: out.replace(/\\/g, "/") });
  const bad = singbox.inbounds.some((x) => x.type === "tun") || singbox.route.auto_detect_interface || singbox.route.find_process;
  const sf = join(out, `android_sb_${i}.json`);
  writeFileSync(sf, JSON.stringify(singbox));
  const xf = join(out, `android_xr_${i}.json`);
  writeFileSync(xf, JSON.stringify(xrayConfig(2080, xray)));
  let st = bad ? "BAD (tun/auto_detect/find_process in android config)" : "ok";
  try {
    execFileSync(join(bin, "sing-box.exe"), ["check", "-c", sf], { stdio: "pipe" });
    execFileSync(join(bin, "xray.exe"), ["run", "-test", "-c", xf], { stdio: "pipe" });
  } catch (e) {
    const msg = ((e.stdout?.toString() || "") + (e.stderr?.toString() || "")).trim();
    // On Windows `xray -test` parses the config and then tries to create the TUN, which
    // needs wintun.dll; reaching that point means the config itself is valid.
    if (!/wintun\.dll/.test(msg)) st = "FAIL " + msg.split("\n").slice(-2).join(" ");
  }
  if (st !== "ok") fail++;
  console.log(`${p.name.padEnd(8)} ${engine.padEnd(16)} ${st}`);
}
console.log(fail ? `FAILURES: ${fail}` : "ALL OK");
process.exit(fail ? 1 : 0);
