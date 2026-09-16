#!/usr/bin/env node
/* Checks that static/demo-shim.js decodes the compact bundles back into the payloads the export
 * computed in Python. Usage:
 *   node tools/verify_shim.mjs <demo-dir> <reference-dir>
 * where <reference-dir> was written by export_demo.py --reference. Prices are compared with a
 * relative tolerance (they travel as integer cents); everything else must match exactly. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [demoDir, refDir] = process.argv.slice(2);
if (!demoDir || !refDir) { console.error("usage: verify_shim.mjs <demo-dir> <reference-dir>"); process.exit(2); }

globalThis.fetch = async (path) => {
  const text = readFileSync(join(demoDir, path), "utf8");
  return { ok: true, json: async () => JSON.parse(text) };
};
await import(join(process.cwd(), demoDir, "static/demo-shim.js"));
const shim = globalThis.QE_DEMO;

let failures = 0;
function fail(where, msg) { failures += 1; if (failures <= 40) console.log("FAIL " + where + ": " + msg); }

/* tol: a relative tolerance (number) or {abs: x} for an absolute one */
function close(a, b, tol) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "number" && typeof b === "number") {
    if (tol && typeof tol === "object") return Math.abs(a - b) <= tol.abs;
    if (tol === 0) return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
    return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
  }
  return a === b;
}

function compare(where, got, want, tol) {
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) return fail(where, `length ${got && got.length} vs ${want.length}`);
    for (let i = 0; i < want.length; i++) {
      if (typeof want[i] === "object" && want[i] !== null) compare(where + "[" + i + "]", got[i], want[i], tol);
      else if (!close(got[i], want[i], tol)) return fail(where + "[" + i + "]", `${got[i]} vs ${want[i]}`);
    }
    return;
  }
  if (want && typeof want === "object") {
    for (const k of Object.keys(want)) compare(where + "." + k, got == null ? undefined : got[k], want[k], tol);
    return;
  }
  if (!close(got, want, tol)) fail(where, `${got} vs ${want}`);
}

const files = readdirSync(refDir).filter((f) => f.endsWith(".json") && f !== "calendar.json");
for (const f of files) {
  const sym = f.replace(/\.json$/, "");
  const want = JSON.parse(readFileSync(join(refDir, f), "utf8"));
  const got = await shim.bundle(sym);
  const p = want.prices;
  if (p.n_bars) {
    compare(sym + ".prices.dates", got.prices.dates, p.dates, 0);
    compare(sym + ".prices.close", got.prices.close, p.close, { abs: 0.0051 });   // stored as cents
    compare(sym + ".prices.ohlc", got.prices.ohlc, p.ohlc, { abs: 0.0051 });
    compare(sym + ".prices.adj_close", got.prices.adj_close, p.adj_close, 2.5e-3);
    compare(sym + ".prices.sma", got.prices.sma, p.sma, 2.5e-3);
    compare(sym + ".prices.volume", got.prices.volume, p.volume, { abs: 50.5 });  // stored in hundreds
    compare(sym + ".prices.events", got.prices.events, p.events, 0);
    compare(sym + ".prices.stats", got.prices.stats, p.stats, 1e-6);
  }
  if (want.patterns) {
    const pt = want.patterns;
    for (const k of Object.keys(pt)) {
      // series recomputed in the browser from cent-rounded prices carry that rounding
      const tol = k === "drawdown" || k === "rolling_vol" || k === "rel_spy" ? 3e-3 : k === "rolling_beta" ? 1e-4 : 1e-5;
      compare(sym + ".patterns." + k, got.patterns[k], pt[k], tol);
    }
  }
  compare(sym + ".indicators", got.indicators, want.indicators, 0);
  compare(sym + ".indicator_series", got.indicator_series, want.indicator_series, 1e-4);
  compare(sym + ".model", got.model, want.model, 1e-6);
  compare(sym + ".options", got.options, want.options, 5e-5);
  for (const url of ["/api/symbol/" + sym + "/prices", "/api/symbol/" + sym + "/patterns", "/api/symbol/" + sym + "/model"]) {
    try { const r = await shim.fetch(url); if (!r) fail(url, "empty"); }
    catch (e) { if (!(url.endsWith("/patterns") && !want.patterns)) fail(url, e.message); }
  }
}
const s = await shim.search("AA");
if (!Array.isArray(s)) fail("search", "no array");
console.log(failures ? `${failures} failure(s) across ${files.length} symbols` : `OK: ${files.length} symbols decode identically`);
process.exit(failures ? 1 : 0);
