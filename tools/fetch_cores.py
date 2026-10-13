"""Download sing-box, Xray and rule-set files into src-tauri/bin.

Run: python tools/fetch_cores.py
"""
import io
import json
import os
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "src-tauri", "bin")
RULES = os.path.join(BIN, "rules")
os.makedirs(RULES, exist_ok=True)

UA = {"User-Agent": "aurora-vpn-build"}


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def latest_asset(repo, needle):
    rel = json.loads(get(f"https://api.github.com/repos/{repo}/releases/latest"))
    for a in rel["assets"]:
        if a["name"] == needle(rel["tag_name"]):
            return rel["tag_name"], a["browser_download_url"]
    raise SystemExit(f"asset not found in {repo}")


def extract(zip_bytes, wanted, dest):
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        for n in z.namelist():
            if os.path.basename(n).lower() == wanted.lower():
                with open(dest, "wb") as f:
                    f.write(z.read(n))
                return
    raise SystemExit(f"{wanted} not in zip")


tag, url = latest_asset("SagerNet/sing-box", lambda t: f"sing-box-{t.lstrip('v')}-windows-amd64.zip")
print("sing-box", tag)
extract(get(url), "sing-box.exe", os.path.join(BIN, "sing-box.exe"))

tag, url = latest_asset("XTLS/Xray-core", lambda t: "Xray-windows-64.zip")
print("xray", tag)
extract(get(url), "xray.exe", os.path.join(BIN, "xray.exe"))

rule_sets = {
    "geoip-ru": "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs",
    "geosite-category-ru": "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ru.srs",
    "geosite-category-ads-all": "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ads-all.srs",
}
for name, u in rule_sets.items():
    data = get(u)
    with open(os.path.join(RULES, name + ".srs"), "wb") as f:
        f.write(data)
    print(name, len(data))
print("done")
