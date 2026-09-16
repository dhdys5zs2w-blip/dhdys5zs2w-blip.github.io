#!/usr/bin/env python3
"""Mark every page on the site as noindex, so the site is unlisted.

The site is served from a public GitHub Pages repo, so anyone with the link can
read it; that is intentional (recruiters must not hit a login). What we do not
want is the site turning up when someone searches Ben's name. A `noindex` meta
tag on every page is what actually keeps it out of search results.

Deliberately NOT done with `robots.txt: Disallow: /` — that blocks crawlers
from *fetching* the page, which means they never read the noindex tag and the
URL can still be listed from external links. Allowing the crawl and serving
noindex is the combination that removes it from results.

Idempotent: safe to re-run. Run it after any export that regenerates HTML
(notably the equity-research export, which rewrites its crawled pages).

    python3 tools/add_noindex.py          # whole site
    python3 tools/add_noindex.py --check  # report only, non-zero if any page is missing it
"""

import argparse
import pathlib
import re
import sys

TAG = '<meta name="robots" content="noindex, nofollow">'
HEAD_RE = re.compile(r"<head\b[^>]*>", re.I)
HAS_RE = re.compile(r'<meta\s+name=["\']robots["\']', re.I)
# The charset declaration has to stay at the top of <head> (the spec wants it
# inside the first 1024 bytes), so insert after it when it is there.
CHARSET_RE = re.compile(r"<meta\s+charset=[^>]*>", re.I)


def insert_at(text: str) -> int | None:
    """Byte offset to insert the tag: after <meta charset>, else after <head>."""
    head = HEAD_RE.search(text)
    if not head:
        return None
    charset = CHARSET_RE.search(text, head.end())
    if charset and charset.start() - head.end() < 200:
        return charset.end()
    return head.end()

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="report only, change nothing")
    args = ap.parse_args()

    pages = sorted(ROOT.rglob("*.html"))
    changed, already, skipped = 0, 0, []

    for p in pages:
        if ".git" in p.parts:
            continue
        text = p.read_text(encoding="utf-8", errors="surrogateescape")
        if HAS_RE.search(text):
            already += 1
            continue
        at = insert_at(text)
        if at is None:
            skipped.append(p.relative_to(ROOT))
            continue
        if not args.check:
            p.write_text(
                text[:at] + "\n" + TAG + text[at:],
                encoding="utf-8",
                errors="surrogateescape",
            )
        changed += 1

    label = "would change" if args.check else "tagged"
    print(f"{len(pages)} pages: {label} {changed}, already tagged {already}, no <head> {len(skipped)}")
    for s in skipped:
        print(f"  no <head>: {s}")
    if args.check and (changed or skipped):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
