# Org closet page

A clickable page showing a partner org's closet as the org would see it: buy a pair with the org's code, apply for a free pair, sponsor the closet, and the box filling toward $300. Real products and adult store prices. The org, sponsors and progress are illustrative.

- `template.html` is the source. `index.html` is built from it by replacing `{{IMG_JSON}}` with a JSON map of `img/<handle>.jpg` as base64 data URIs (see the python snippet in git history, or any equivalent).
- Open `index.html` in a browser. It works offline apart from the web fonts.
- **Before a meeting:** put the org in the link, e.g. `index.html?org=Uniting%20Pride&city=Champaign-Urbana%2C%20Illinois&code=UPRIDE15&sizes=S,M,L,1X,2X&items=2`. `sizes` is what the closet offers, `items` the most per request. Add `&reset` to put the progress back to the starting point.
- **In the room:** press `e` (with nothing focused) to open the presenter panel: change the org, code, sizes offered, items per request, walk-in stock lines; reset progress; fill the box. `Esc` closes it. `?panel` in the link opens it on load. Settings persist in that browser.
- The sponsor list is fed by the apply form: submit a request and it appears as "Someone asked for…", ready to be covered. Raising past $300 rolls into the next box.
- Design record and every decision: `.claude/plans/org-closet-programme.md`.
