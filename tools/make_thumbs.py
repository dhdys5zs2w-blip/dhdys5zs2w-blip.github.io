#!/usr/bin/env python3
"""Generate the 16:9 thumbnails the gallery cards show (projects/<slug>/thumb.png, 1200x675).

Web projects are screenshotted with headless Chrome from a local static server started here (pages
fetch their data with relative URLs, which file:// would block). iOS projects get a composite of their
simulator screenshots on the gallery's gradient, because they do not run in a browser.

    python3 tools/make_thumbs.py            # every project in THUMBS
    python3 tools/make_thumbs.py fitlog     # one slug

Needs Google Chrome in /Applications and Pillow (the anaconda python3 has it).
"""

from __future__ import annotations

import http.server
import socketserver
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 8791
W, H = 1200, 675

# slug -> how to make its thumbnail
#   page:   URL path under the site root, shot at `window` (w, h); `crop` = (left, top) of a 16:9 box
#           whose width is `crop_w` in the screenshot, then scaled to W x H
#   phones: simulator screenshots composited on the gradient
THUMBS: dict[str, dict] = {
    "equity-research": {"page": "projects/equity-research/symbol/NVDA.html", "window": (1400, 1000),
                        "crop": (0, 120), "crop_w": 1400, "wait": 9000},
    "tucson-grid-battery-model": {"page": "projects/tucson-grid-battery-model/", "window": (1400, 1900),
                                  "crop": (0, 985), "crop_w": 1400, "wait": 9000},
    "company-research-agent": {"page": "projects/company-research-agent/", "window": (1400, 900),
                               "crop": (0, 0), "crop_w": 1400, "wait": 4000},
    "soc-analysis": {"page": "projects/soc-analysis/", "window": (1400, 2000),
                     "crop": (0, 1110), "crop_w": 1400, "wait": 8000},
    "fitlog": {"phones": ["projects/fitlog/screenshots/coach.png", "projects/fitlog/screenshots/workout.png",
                          "projects/fitlog/screenshots/progress.png"]},
    "personal-dashboard": {"phones": ["projects/personal-dashboard/screenshots/today.png"]},
}


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args) -> None:  # noqa: D401
        pass


def serve() -> socketserver.TCPServer:
    handler = lambda *a, **k: Quiet(*a, directory=str(ROOT), **k)  # noqa: E731
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def shoot(spec: dict, out: Path) -> None:
    w, h = spec["window"]
    url = f"http://127.0.0.1:{PORT}/{spec['page']}"
    if spec.get("scroll_to"):
        url += spec["scroll_to"]
    with tempfile.TemporaryDirectory() as tmp:
        shot = Path(tmp) / "shot.png"
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                        f"--window-size={w},{h}", f"--virtual-time-budget={spec.get('wait', 5000)}",
                        f"--screenshot={shot}", url], check=True, capture_output=True, timeout=120)
        img = Image.open(shot).convert("RGB")
    left, top = spec["crop"]
    cw = spec["crop_w"]
    ch = round(cw * H / W)
    box = (left, top, min(left + cw, img.width), min(top + ch, img.height))
    img = img.crop(box).resize((W, H), Image.LANCZOS)
    img.save(out, optimize=True)


def gradient() -> Image.Image:
    """The gallery's placeholder gradient (#3b5bdb -> #6d28d9), diagonal."""
    a, b = (0x3B, 0x5B, 0xDB), (0x6D, 0x28, 0xD9)
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        for x in range(W):
            t = (x / W + y / H) / 2
            px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return img


def composite(paths: list[str], out: Path) -> None:
    img = gradient()
    shots = [Image.open(ROOT / p).convert("RGBA") for p in paths]
    ph = round(H * 1.18)                       # phones bleed off the bottom edge
    scaled = [s.resize((round(s.width * ph / s.height), ph), Image.LANCZOS) for s in shots]
    gap = 36
    total = sum(s.width for s in scaled) + gap * (len(scaled) - 1)
    x = (W - total) // 2
    for i, s in enumerate(scaled):
        y = 56 + (28 if i % 2 else 0)
        r = round(s.width * 0.11)
        mask = Image.new("L", s.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, s.width - 1, s.height - 1), radius=r, fill=255)
        shadow = Image.new("RGBA", (s.width + 40, s.height + 40), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle((20, 24, s.width + 20, s.height + 24), radius=r, fill=(0, 0, 0, 90))
        img.paste(shadow, (x - 20, y - 20), shadow)
        img.paste(s, (x, y), mask)
        x += s.width + gap
    img.save(out, optimize=True)


def main() -> None:
    wanted = sys.argv[1:] or list(THUMBS)
    httpd = None
    try:
        for slug in wanted:
            spec = THUMBS[slug]
            out = ROOT / "projects" / slug / "thumb.png"
            if "phones" in spec:
                composite(spec["phones"], out)
            else:
                if httpd is None:
                    httpd = serve()
                shoot(spec, out)
            print(f"{slug}: {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB)")
    finally:
        if httpd is not None:
            httpd.shutdown()


if __name__ == "__main__":
    main()
