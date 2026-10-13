"""Build Aurora VPN and publish a GitHub release that the in-app updater picks up.

Usage: python tools/release.py "что нового в этой версии"

Bump "version" in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml
first. The release gets the installer plus version.json; the app reads
https://github.com/KotikVanil/aurora-vpn/releases/latest/download/version.json
"""
import json
import os
import shutil
import subprocess
import sys

REPO = "KotikVanil/aurora-vpn"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(cmd, **kw):
    print(">", " ".join(cmd))
    subprocess.run(cmd, cwd=ROOT, check=True, shell=(os.name == "nt"), **kw)


def main():
    notes = sys.argv[1] if len(sys.argv) > 1 else ""
    with open(os.path.join(ROOT, "src-tauri", "tauri.conf.json"), encoding="utf-8") as f:
        version = json.load(f)["version"]
    tag = f"v{version}"

    run(["npm", "run", "tauri", "build"])

    bundle = os.path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis")
    built = next(f for f in os.listdir(bundle) if f.endswith("-setup.exe") and version in f)
    out = os.path.join(ROOT, "release")
    os.makedirs(out, exist_ok=True)
    asset = f"Aurora-VPN-{version}-setup.exe"
    shutil.copyfile(os.path.join(bundle, built), os.path.join(out, asset))

    # Android: same web UI, packaged by Gradle (signed with android/keystore).
    run(["npm", "run", "build:android-web"])
    env = dict(os.environ, JAVA_HOME=r"C:\Program Files\Android\Android Studio\jbr")
    android = os.path.join(ROOT, "android")
    subprocess.run([os.path.join(android, "gradlew.bat"), "assembleRelease", "--console=plain", "-q"],
                   cwd=android, check=True, env=env)
    apk_asset = f"Aurora-VPN-{version}.apk"
    shutil.copyfile(os.path.join(ROOT, "android", "app", "build", "outputs", "apk", "release", "app-release.apk"),
                    os.path.join(out, apk_asset))

    # One version.json for both: "url" = Windows installer, "apk" = Android package.
    info = {
        "version": version,
        "notes": notes,
        "url": f"https://github.com/{REPO}/releases/download/{tag}/{asset}",
        "apk": f"https://github.com/{REPO}/releases/download/{tag}/{apk_asset}",
    }
    with open(os.path.join(out, "version.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)

    run([
        "gh", "release", "create", tag,
        os.path.join(out, asset), os.path.join(out, apk_asset), os.path.join(out, "version.json"),
        "--repo", REPO, "--title", f"Aurora VPN {version}",
        "--notes", notes or f"Aurora VPN {version}",
    ])
    print("published", tag)


if __name__ == "__main__":
    main()
