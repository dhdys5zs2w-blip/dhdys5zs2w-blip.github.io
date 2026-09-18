#!/bin/zsh
#
# publish_nightly.sh — refresh the equity-research demo and publish it to GitHub Pages.
#
# Runs unattended from the com.qe.portfolio-publish LaunchAgent, after the
# nightly com.qe.daily run has finished ingesting and scoring the day.
#
# What it does, in order:
#   1. waits until com.qe.daily is idle (the export opens qe.duckdb read-only,
#      and DuckDB will not grant that while the nightly writer holds the file)
#   2. skips the whole run when the platform has no new trading day since the
#      last publish, so an idle night costs seconds and makes no commit
#   3. runs the demo export, re-applies the noindex tag the export strips, and
#      verifies it landed on every page
#   4. commits only projects/equity-research and pushes
#
# Manual run:  ~/dev/Portfolio\ Website/tools/publish_nightly.sh
#      force:  ... --force     (export even when there is no new trading day)
# Log:         ~/Library/Logs/qe-portfolio-publish.log

set -u

SITE="$HOME/dev/Portfolio Website"
QE="$HOME/dev/AnalysisPlatform"
PROJECT="$SITE/projects/equity-research"
MANIFEST="$PROJECT/data/manifest.json"
LOG="$HOME/Library/Logs/qe-portfolio-publish.log"
LOCK="$HOME/Library/Logs/.qe-portfolio-publish.lock"
DAILY_LABEL="com.qe.daily"
WAIT_MAX_MIN=90          # give the nightly run this long to finish before giving up
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

mkdir -p "$(dirname "$LOG")"
# keep the log from growing without bound
if [[ -f "$LOG" && $(wc -c < "$LOG") -gt 1000000 ]]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
exec >> "$LOG" 2>&1

log() { print -r -- "$(date '+%Y-%m-%d %H:%M:%S')  $*"; }
die() { log "FAILED: $*"; rm -f "$LOCK"; exit 1; }

# ---- single instance -------------------------------------------------------
if [[ -f "$LOCK" ]]; then
  if kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
    log "another publish is already running (pid $(cat "$LOCK")); exiting"
    exit 0
  fi
  log "clearing stale lock"
fi
print -r -- $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

log "======== publish start (force=$FORCE) ========"

[[ -d "$QE" ]]      || die "platform checkout missing: $QE"
[[ -d "$PROJECT" ]] || die "project folder missing: $PROJECT"

# ---- 1. wait for the nightly writer to let go of qe.duckdb -----------------
waited=0
while launchctl list "$DAILY_LABEL" 2>/dev/null | grep -q '"PID"'; do
  if (( waited >= WAIT_MAX_MIN )); then
    die "$DAILY_LABEL still running after ${WAIT_MAX_MIN}m; not publishing tonight"
  fi
  (( waited == 0 )) && log "$DAILY_LABEL is running; waiting for it to finish"
  sleep 60
  (( waited += 1 ))
done
(( waited > 0 )) && log "$DAILY_LABEL finished after ${waited}m wait"

# ---- 2. is there anything new to publish? ---------------------------------
# The demo calendar is SPY's trading days, so SPY's latest price date is what
# decides whether a new day exists to show.
db_last=$(cd "$QE" && .venv/bin/python - <<'PY' 2>/dev/null
import duckdb, pathlib
db = pathlib.Path("qe.duckdb").resolve()
con = duckdb.connect(str(db), read_only=True)
row = con.execute("SELECT max(date) FROM prices_daily WHERE symbol = 'SPY'").fetchone()
con.close()
print(row[0].isoformat() if row and row[0] else "")
PY
)
if [[ -z "$db_last" ]]; then
  die "could not read the latest SPY date from qe.duckdb (is the DB locked, or the venv broken?)"
fi

site_last=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['calendar']['last'])" "$MANIFEST" 2>/dev/null)
log "platform has SPY through $db_last; site shows through ${site_last:-unknown}"

if [[ "$FORCE" -eq 0 && -n "$site_last" && "$db_last" == "$site_last" ]]; then
  log "no new trading day; nothing to publish"
  log "======== publish done (skipped) ========"
  exit 0
fi

# ---- 3. export, then restore the noindex tag the export strips ------------
log "exporting demo (this takes ~90s)"
if ! (cd "$QE" && PYTHONPATH=src .venv/bin/python \
        "$PROJECT/tools/export_demo.py" --out "$PROJECT"); then
  die "export_demo.py failed (see the traceback above)"
fi

log "re-applying noindex"
python3 "$SITE/tools/add_noindex.py"       || die "add_noindex.py failed"
python3 "$SITE/tools/add_noindex.py" --check \
  || die "pages are still missing the noindex tag; refusing to publish an indexable site"

# ---- 4. commit and push, scoped to the export's own folder ----------------
cd "$SITE" || die "cannot cd to $SITE"

# Anything changed outside the demo is Ben's own work in progress: never sweep
# it into an unattended commit, just say it is there.
other=$(git status --porcelain -- . ':(exclude)projects/equity-research' | head -20)
[[ -n "$other" ]] && log "note: uncommitted changes outside the demo were left alone:
$other"

if [[ -z "$(git status --porcelain -- projects/equity-research)" ]]; then
  log "export produced no file changes; nothing to commit"
  log "======== publish done (no changes) ========"
  exit 0
fi

git add -A -- projects/equity-research || die "git add failed"
n=$(git diff --cached --numstat -- projects/equity-research | wc -l | tr -d ' ')
git commit -q -m "Update equity research demo through $db_last

Automated nightly refresh from the qe platform ($n files)." \
  || die "git commit failed"
log "committed $n changed file(s) for $db_last"

if ! git push -q origin main; then
  log "FAILED: git push. The commit is made locally; run this in Terminal:"
  log "    cd ~/dev/Portfolio\\ Website && git push origin main"
  rm -f "$LOCK"
  exit 1
fi

log "pushed to origin/main — https://dhdys5zs2w-blip.github.io/projects/equity-research/"
log "======== publish done ========"
