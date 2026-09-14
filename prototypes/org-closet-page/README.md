# Org closet page prototype

A clickable demo of a partner org's closet page for meetings. Real products and adult store prices; example org, sponsors and progress. Not wired to anything.

- `template.html` is the source. `index.html` is built from it with the product images inlined (see the python snippet in the session that created it, or re-run: replace `{{IMG_JSON}}` with a JSON map of `img/<handle>.jpg` base64 data URIs).
- Open `index.html` in a browser. "Demo settings" (top right) renames the org, closet, city and code, resets progress, or jumps to a full box. Settings persist in the browser.
- Design record: `.claude/plans/org-closet-programme.md`.
