#!/usr/bin/env python3
"""Builds the Chrome and Firefox packages into ./dist

    python build.py

Output:
    dist/chrome/   dist/firefox/        unpacked builds (use these for "Load unpacked")
    dist/clickbait-remover-for-youtube-<browser>-v<version>.zip   release archives
"""
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
MANIFESTS = {
    "chrome": ROOT / "manifests" / "manifest.chrome.json",
    "firefox": ROOT / "manifests" / "manifest.firefox.json",
}


def main() -> int:
    versions = {name: json.loads(p.read_text(encoding="utf-8"))["version"] for name, p in MANIFESTS.items()}
    if len(set(versions.values())) != 1:
        print(f"Version mismatch between manifests: {versions}", file=sys.stderr)
        return 1
    version = next(iter(versions.values()))

    if DIST.exists():
        shutil.rmtree(DIST)

    for name, manifest in MANIFESTS.items():
        out = DIST / name
        shutil.copytree(SRC, out)
        shutil.copyfile(manifest, out / "manifest.json")

        archive = DIST / f"clickbait-remover-for-youtube-{name}-v{version}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(out.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(out).as_posix())  # manifest.json at the zip root
        print(f"built {archive.relative_to(ROOT)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
