// Offline check of a real subscription: download it with every User-Agent the app
// tries, parse, build configs and validate them with the cores. Never connects
// through the proxy. Prints names and protocols only, never keys.
// Usage: node tools/test_sub.mjs <subscription-url>
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSubscriptionBody, protocolLabel, SUB_USER_AGENTS, parseLink } from "../src/core/links.js";
import { buildConfigs } from "../src/core/config.js";

const url = process.argv[2];
if (!url) throw new Error("usage: node tools/test_sub.mjs <url>");
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "bin").replace(/\\/g, "/");
const tmp = mkdtempSync(join(tmpdir(), "aurora-sub-"));
let fail = 0;

// Same HWID as the app (lib.rs machine_hwid), so no extra device is registered.
function fnv(s) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(s, "utf8")) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}
const reg = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"]).toString();
const guid = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(reg)[1];
const HEADERS = {
  "x-hwid": fnv(`aurora-hwid-a:${guid}`) + fnv(`aurora-hwid-b:${guid}`),
  "x-device-os": "Windows",
  "x-ver-os": "10",
  "x-device-model": "Aurora VPN",
};

try {
  for (const ua of SUB_USER_AGENTS) {
    console.log(`\n== UA ${ua}`);
    let body;
    try {
      const r = await fetch(url, { headers: { "User-Agent": ua, ...HEADERS } });
      body = await r.text();
    } catch (e) {
      console.log("  fetch error:", e.message);
      continue;
    }
    let parsed;
    try {
      parsed = parseSubscriptionBody(body);
    } catch (e) {
      console.log("  parse:", e.message);
      continue;
    }
    console.log(`  ${parsed.profiles.length} servers, ${parsed.errors.length} skipped`);
    parsed.profiles.forEach((p, i) => {
      // Round trip: the generated share link must parse back to the same server.
      const back = parseLink(p.raw);
      const rt = back.server === p.server && back.port === p.port && back.protocol === p.protocol ? "" : " ROUNDTRIP-MISMATCH";
      const { singbox, xray, engine } = buildConfigs(p, { mode: "tun" }, { rulesDir: `${bin}/rules`, runDir: tmp.replace(/\\/g, "/") });
      const f = join(tmp, `c${i}.json`);
      writeFileSync(f, JSON.stringify(singbox));
      let st = "ok";
      try {
        execFileSync(join(bin, "sing-box.exe"), ["check", "-c", f], { stdio: "pipe" });
        if (xray) {
          writeFileSync(f + ".x", JSON.stringify(xray));
          execFileSync(join(bin, "xray.exe"), ["run", "-test", "-c", f + ".x"], { stdio: "pipe" });
        }
      } catch (e) {
        st = "FAIL " + (e.stderr?.toString() || e.message).trim().split("\n").pop().replace(/[0-9a-f-]{36}/g, "<UUID>");
        fail++;
      }
      if (rt) fail++;
      console.log(`  ${String(i).padStart(2)} ${p.name.padEnd(28)} ${protocolLabel(p).padEnd(22)} ${engine.padEnd(16)} ${st}${rt}`);
    });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fail ? `\nFAILURES: ${fail}` : "\nALL OK");
