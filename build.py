#!/usr/bin/env python3
"""Injects projects.json into index.html so the gallery works locally and on GitHub Pages.
Run after any change to projects.json:  python3 build.py"""
import json, re, pathlib, sys

root = pathlib.Path(__file__).resolve().parent
data_path = root / "projects.json"
html_path = root / "index.html"

data = json.loads(data_path.read_text())
html = html_path.read_text()

block = "/*DATA_START*/\nconst DATA = " + json.dumps(data, indent=2) + ";\n/*DATA_END*/"
new_html, n = re.subn(r"/\*DATA_START\*/.*?/\*DATA_END\*/", lambda m: block, html, flags=re.S)
if n != 1:
    sys.exit("ERROR: expected exactly one DATA_START/DATA_END block in index.html, found %d" % n)
html_path.write_text(new_html)
print("Built gallery: %d project(s)." % len(data.get("projects", [])))
