"""Download the Android native parts into android/app:

- libv2ray.aar (2dust/AndroidLibXrayLite): Xray in-process, takes the VpnService TUN fd.
- sing-box CLI for android-arm64, shipped as jniLibs/arm64-v8a/libsingbox.so so Android
  lets the app execute it from nativeLibraryDir.
- rule sets (copied from src-tauri/bin/rules, run tools/fetch_cores.py first).

Run: python tools/fetch_android.py
"""
import io
import json
import os
import shutil
import tarfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "android", "app")
UA = {"User-Agent": "aurora-vpn-build"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
        return r.read()


def latest(repo):
    return json.loads(get(f"https://api.github.com/repos/{repo}/releases/latest"))


libs = os.path.join(APP, "libs")
os.makedirs(libs, exist_ok=True)
rel = latest("2dust/AndroidLibXrayLite")
aar = next(a for a in rel["assets"] if a["name"] == "libv2ray.aar")
with open(os.path.join(libs, "libv2ray.aar"), "wb") as f:
    f.write(get(aar["browser_download_url"]))
print("libv2ray.aar", rel["tag_name"])

rel = latest("SagerNet/sing-box")
ver = rel["tag_name"].lstrip("v")
asset = next(a for a in rel["assets"] if a["name"] == f"sing-box-{ver}-android-arm64.tar.gz")
jni = os.path.join(APP, "src", "main", "jniLibs", "arm64-v8a")
os.makedirs(jni, exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(get(asset["browser_download_url"])), mode="r:gz") as t:
    member = next(m for m in t.getmembers() if os.path.basename(m.name) == "sing-box")
    with open(os.path.join(jni, "libsingbox.so"), "wb") as f:
        f.write(t.extractfile(member).read())
print("sing-box", ver)

rules_src = os.path.join(ROOT, "src-tauri", "bin", "rules")
rules_dst = os.path.join(APP, "src", "main", "assets", "rules")
os.makedirs(rules_dst, exist_ok=True)
for name in os.listdir(rules_src):
    shutil.copyfile(os.path.join(rules_src, name), os.path.join(rules_dst, name))
print("rules", os.listdir(rules_dst))
