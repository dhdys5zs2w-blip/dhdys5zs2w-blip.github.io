#!/usr/bin/env python3
"""Injects projects.json into index.html so the gallery works locally and on GitHub Pages.
Run after any change to projects.json:  python3 build.py

Also refreshes the optional no-JavaScript rendition between <!--STATIC_START--> and
<!--STATIC_END--> (inside the page's <noscript>), if index.html has those markers.

Copy in projects.json may carry a live figure as {{manifest:dotted.path|fallback}} (a value from
projects/equity-research/data/manifest.json). The homepage shows the fallback, then the live value.
The no-JS rendition here quotes the manifest value as of this run (the nightly job does not rebuild
index.html), and uses the fallback only when the manifest or the path is missing; a token never
appears raw.

A token may add |max=N after the fallback — {{manifest:record.live_days|59|max=249}} — when its sentence
can only carry the figure up to N ("only 59 of the roughly 250 live days it needs"). Above N the homepage
withdraws that whole sentence rather than show a figure that disagrees with the live ones beside it (the
no-JS rendition here does the same with the manifest as it stands at build time, and otherwise quotes
that build-time value, not the fallback). This script warns from 90% of N so the sentence is rewritten
before then. `python3 build.py --check-tokens` reports the same thing without writing anything (exit 3
once a live value reaches N); run it by hand when touching copy that carries a token."""
import json, re, pathlib, sys
from html import escape

root = pathlib.Path(__file__).resolve().parent
data_path = root / "projects.json"
html_path = root / "index.html"

data = json.loads(data_path.read_text())
html = html_path.read_text()

block = "/*DATA_START*/\nconst DATA = " + json.dumps(data, indent=2) + ";\n/*DATA_END*/"
new_html, n = re.subn(r"/\*DATA_START\*/.*?/\*DATA_END\*/", lambda m: block, html, flags=re.S)
if n != 1:
    sys.exit("ERROR: expected exactly one DATA_START/DATA_END block in index.html, found %d" % n)

TYPE = {"web": "Web app", "dashboard": "Dashboard", "ios": "iOS app", "data-app": "Data app"}
MON = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()


TOKEN = re.compile(r"\{\{manifest:([\w.]+)\|([^{}]*)\}\}")


def tok_parts(rest):
    """'59|max=249' -> ('59', {'max': '249'}): the fallback, then any key=value options."""
    parts = rest.split("|")
    opts = {}
    for o in parts[1:]:
        k, _, v = o.partition("=")
        opts[k.strip()] = v.strip()
    return parts[0], opts


def detok(s):
    """Replace every {{manifest:path|fallback}} token with its fallback."""
    return TOKEN.sub(lambda m: tok_parts(m.group(2))[0], str(s or ""))


def load_manifest():
    try:
        return json.loads((root / "projects/equity-research/data/manifest.json").read_text())
    except (OSError, ValueError):
        return None


def pick(manifest, path):
    val = manifest
    for k in path.split("."):
        val = val.get(k) if isinstance(val, dict) else None
    return val


def fmt_live(v):
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return "{:,}".format(round(v, 3) if isinstance(v, float) else v)


# where a new sentence starts (same rule as the homepage's sentenceBreaks): [.!?], optional closing
# quote, whitespace, then a capital; never inside a token
SENTENCE_END = re.compile(r"[.!?][\u201d\u2019\"')\]]*\s+(?=[\u201c\u2018\"'(\[]?[A-Z])")


def sentences(s):
    spans = [m.span() for m in TOKEN.finditer(s)]
    cuts = [0] + [m.end() for m in SENTENCE_END.finditer(s)
                  if not any(a <= m.start() < b for a, b in spans)] + [len(s)]
    return [s[a:b] for a, b in zip(cuts, cuts[1:]) if b > a]


def over_max(m, manifest):
    """The live value, and whether it is past the token's max=N (so its sentence cannot carry it)."""
    _, opts = tok_parts(m.group(2))
    val = pick(manifest, m.group(1)) if manifest else None
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        return None, False
    try:
        return val, "max" in opts and val > float(opts["max"])
    except ValueError:
        return val, False


def live_value(m, manifest):
    val = over_max(m, manifest)[0]
    return fmt_live(val) if val is not None else tok_parts(m.group(2))[0]


def live_text(s, manifest):
    """The no-JS rendition of copy: tokens take the build-time manifest value (else the fallback), and a
    sentence whose capped figure is past its max is withdrawn, as the homepage does."""
    s = str(s or "")
    if not TOKEN.search(s):
        return s
    out = []
    for part in sentences(s):
        if any(over_max(m, manifest)[1] for m in TOKEN.finditer(part)):
            continue
        out.append(TOKEN.sub(lambda m: live_value(m, manifest), part))
    return "".join(out).rstrip()


def month(s):
    p = str(s or "").split("-")
    return "%s %s" % (MON[int(p[1]) - 1], p[0]) if len(p) > 1 and p[1].isdigit() else p[0]


def static_html(data):
    site = data.get("site", {})
    projects = [p for p in data.get("projects", []) if p.get("slug") and p.get("title")]
    projects = [p for p in projects if p.get("featured")] + [p for p in projects if not p.get("featured")]
    manifest = load_manifest()
    e = lambda s: escape(live_text(s, manifest))
    out = ['<div class="wrap nojs">', '<h1 class="name">%s</h1>' % e(site.get("name"))]
    if site.get("tagline"):
        out.append('<p class="tagline">%s</p>' % e(site["tagline"]))
    if site.get("intro"):
        out.append('<p class="intro">%s</p>' % e(site["intro"]))
    links = []
    if site.get("email"):
        links.append('<a class="btn-ink" href="mailto:%s">%s</a>' % (e(site["email"]), e(site["email"])))
    if site.get("linkedin"):
        links.append('<a class="btn-line" href="%s">LinkedIn</a>' % e(site["linkedin"]))
    if site.get("github"):
        links.append('<a class="btn-line" href="%s">GitHub</a>' % e(site["github"]))
    if links:
        out.append('<p class="hero__actions">%s</p>' % "".join(links))
    out.append("<h2>Projects</h2><ol>")
    for p in projects:
        out.append('<li><a href="%s">%s</a><span class="meta label">%s &middot; %s</span><p>%s</p></li>' % (
            e(p.get("link") or "projects/%s/" % p["slug"]), e(p["title"]),
            e(TYPE.get(p.get("type"), "Web app")), e(month(p.get("date"))), e(p.get("description"))))
    out.append("</ol>")
    proc = site.get("process") or {}
    if proc.get("paragraphs"):
        out.append("<h2>%s</h2>" % e(proc.get("heading") or "How I work"))
        out += ["<p>%s</p>" % e(t) for t in proc["paragraphs"]]
    out.append("</div>")
    return "\n".join(out)


def check_highlights(data):
    """Optional per-project `highlight` numbers must still be stated on the project's own page."""
    from html import unescape
    for p in data.get("projects", []):
        v = str((p.get("highlight") or {}).get("value") or "").strip()
        if not v or not p.get("slug"):
            continue
        page = root / (p.get("link") or "projects/%s/" % p["slug"]) / "index.html"
        if not page.is_file():
            print("WARNING: %s highlight: %s not found" % (p["slug"], page.relative_to(root)))
            continue
        text = re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", page.read_text())))
        num = re.match(r"[\d][\d.,]*", v)
        token = num.group(0) if num else v
        if not re.search(r"(?<![\d.,])" + re.escape(token) + r"(?![\d,]|\.\d)", text):
            print("WARNING: %s highlight %r is no longer stated on %s — update or remove it in projects.json"
                  % (p["slug"], v, page.relative_to(root)))



def check_tokens(data):
    """Warn about a malformed token (it would render raw) anywhere in the copy."""
    def walk(v, where):
        if isinstance(v, dict):
            for k, x in v.items():
                walk(x, where + "." + k)
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, "%s[%d]" % (where, i))
        elif isinstance(v, str) and "{{" in detok(v):
            print("WARNING: %s has a malformed {{...}} token (expected {{manifest:path|fallback}})" % where)
    walk(data, "projects.json")


def walk_strings(v, where="projects.json"):
    """Yield (location, string) for every string in the manifest."""
    if isinstance(v, dict):
        for k, x in v.items():
            yield from walk_strings(x, where + "." + k)
    elif isinstance(v, list):
        for i, x in enumerate(v):
            yield from walk_strings(x, "%s[%d]" % (where, i))
    elif isinstance(v, str):
        yield where, v


def check_token_bounds(data):
    """Warn when a live value reaches 90% of a token's max=N (the most its sentence can carry).
    Returns True when any value has reached N itself."""
    manifest = load_manifest()
    if manifest is None:
        return False
    at_max = False
    for where, s in walk_strings(data):
        for m in TOKEN.finditer(s):
            _, opts = tok_parts(m.group(2))
            if "max" not in opts:
                continue
            try:
                cap = float(opts["max"])
            except ValueError:
                print("WARNING: %s: token %s has a max that is not a number" % (where, m.group(0)))
                continue
            val = pick(manifest, m.group(1))
            if isinstance(val, bool) or not isinstance(val, (int, float)):
                continue
            if val > cap:
                at_max = True
                print("WARNING: %s: live %s = %s is past max=%g, so the homepage has withdrawn the sentence "
                      "that quotes it. Rewrite that sentence in projects.json." % (where, m.group(1), val, cap))
            elif val >= cap:
                at_max = True
                print("WARNING: %s: live %s = %s has reached max=%g; one more and the homepage withdraws the "
                      "sentence that quotes it. Rewrite that sentence in projects.json now." % (where, m.group(1), val, cap))
            elif val >= 0.9 * cap:
                print("WARNING: %s: live %s = %s is within 10%% of max=%g; rewrite the sentence around it in "
                      "projects.json before it gets there." % (where, m.group(1), val, cap))
    return at_max


if "--check-tokens" in sys.argv[1:]:
    sys.exit(3 if check_token_bounds(data) else 0)

check_highlights(data)
check_tokens(data)
check_token_bounds(data)
new_html, m = re.subn(r"<!--STATIC_START-->.*?<!--STATIC_END-->",
                      lambda _: "<!--STATIC_START-->\n" + static_html(data) + "\n<!--STATIC_END-->",
                      new_html, count=1, flags=re.S)
html_path.write_text(new_html)
print("Built gallery: %d project(s)%s." % (len(data.get("projects", [])), " + no-JS rendition" if m else ""))
