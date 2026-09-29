#!/usr/bin/env python3
"""Generate the 16:9 thumbnails the gallery cards show (projects/<slug>/thumb.png, 1200x675).

Web projects are screenshotted with headless Chrome from a local static server started here (pages
fetch their data with relative URLs, which file:// would block), in the light theme. iOS projects get a
composite of their simulator screenshots on the site's paper tone, because they do not run in a browser.

Page crops are pixel offsets into a screenshot of the page at `window` size, so they drift when a page's
layout changes: after restyling a page, re-measure (the element's getBoundingClientRect at that window
width) and re-run, then open each thumb.png and check it at card size.

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

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 8791
W, H = 1200, 675

# slug -> how to make its thumbnail
#   page:   URL path under the site root, shot at `window` (w, h); `crop` = (left, top) of a 16:9 box
#           whose width is `crop_w` in the screenshot, then scaled to W x H (the box must fit the window)
#   phones: simulator screenshots composited on the gradient
#   image:  a local screenshot (path under the site root); `crop` and `crop_w` as for page, no browser
#   colors: optional; quantize the saved PNG to this many colours (keeps flat, photo-free shots small)
THUMBS: dict[str, dict] = {
    "afterimage": {"image": "projects/afterimage/screenshots/home.jpg", "crop": (0, 0), "crop_w": 1440,
                   "colors": 256},
    "equity-research": {"page": "projects/equity-research/symbol/NVDA.html", "window": (1400, 1000),
                        "crop": (0, 120), "crop_w": 1400, "wait": 9000},
    # the "Every hour of 2025" chart card, with the next card's heading below it
    "tucson-grid-battery-model": {"page": "projects/tucson-grid-battery-model/", "window": (1400, 2100),
                                  "crop": (150, 1370), "crop_w": 1100, "wait": 9000},
    # "Which number to attack first": the sensitivity ranking, each assumption tagged with its evidence tier
    "company-research-agent": {"page": "projects/company-research-agent/", "window": (1400, 4800),
                               "crop": (150, 4113), "crop_w": 1100, "wait": 4000},
    # the model on a real stock: the figure strip and the fragility score over AVGO's price
    "soc-analysis": {"page": "projects/soc-analysis/", "window": (1400, 4000),
                     "crop": (122, 3280), "crop_w": 1156, "wait": 8000},
    "fitlog": {"phones": ["projects/fitlog/screenshots/coach.png", "projects/fitlog/screenshots/logging.png",
                          "projects/fitlog/screenshots/progress.png"]},
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
    crop_save(img, spec, out)


def crop_save(img: Image.Image, spec: dict, out: Path) -> None:
    """Crop the 16:9 box `crop`/`crop_w` describes and save it scaled to W x H."""
    left, top = spec["crop"]
    cw = spec["crop_w"]
    ch = round(cw * H / W)
    box = (left, top, min(left + cw, img.width), min(top + ch, img.height))
    img = img.crop(box).resize((W, H), Image.LANCZOS)
    if spec.get("colors"):
        img = img.quantize(spec["colors"], method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    img.save(out, optimize=True)


def gradient() -> Image.Image:
    """The site's paper tone, a quiet vertical fall from --surface-2 (#efe9dd) to a slightly deeper paper."""
    a, b = (0xEF, 0xE9, 0xDD), (0xE2, 0xDA, 0xC9)
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        t = y / (H - 1)
        c = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
        for x in range(W):
            px[x, y] = c
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
        shadow = Image.new("RGBA", (s.width + 80, s.height + 80), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle((40, 50, s.width + 40, s.height + 50), radius=r, fill=(40, 30, 10, 80))
        shadow = shadow.filter(ImageFilter.GaussianBlur(16))
        img.paste(shadow, (x - 40, y - 40), shadow)
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
            elif "image" in spec:
                crop_save(Image.open(ROOT / spec["image"]).convert("RGB"), spec, out)
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
