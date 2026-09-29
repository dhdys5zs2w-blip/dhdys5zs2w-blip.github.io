# Ben Meyer — Portfolio

A GitHub Pages site showcasing apps and dashboards built with Claude.

## Structure

| Path | What it is |
|---|---|
| `index.html` | Gallery homepage (generated data block — don't hand-edit it) |
| `projects.json` | Source of truth: site info + one entry per project |
| `projects/<slug>/` | Each project, self-contained (live app or iOS case study) |
| `build.py` | Injects `projects.json` into `index.html` and refreshes its no-JavaScript rendition |
| `assets/` | Shared styles and behaviour (`site.css`, `site.js`: theme toggle, search palette, lightbox), the case-study stylesheet, and a vendored ECharts copy |
| `tools/add_site_chrome.py` | Adds the shared head lines, skip link, `<main>` and `site.js` to hand-written case-study pages (idempotent) |
| `tools/make_thumbs.py` | Generates the 16:9 card thumbnails (headless Chrome or a phone composite) |
| `projects/equity-research/tools/` | Exports the live qe research browser into the static demo |
| `.nojekyll` | Tells GitHub Pages to serve the folders as-is (no Jekyll processing) |

## Adding a project

**The easy way:** open this folder in a Claude session and say
*"add this project"* with the file, artifact link, or screenshots.
Claude handles the folder, manifest, build, and deploy.

**Manually:**
1. Put the project in `projects/<slug>/` (self-contained `index.html`).
2. Add an entry to the top of the array in `projects.json`.
3. Run `python3 build.py` (and `python3 tools/add_site_chrome.py` for a new case-study page).
4. `git add -A && git commit -m "Add <project>" && git push`

## Local preview

Serve the folder so the project pages can fetch their data (a plain `file://`
open blocks those requests):

```bash
python3 -m http.server 8765
```

then open http://localhost:8765/.
