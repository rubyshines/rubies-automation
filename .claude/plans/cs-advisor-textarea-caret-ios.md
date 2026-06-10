# CS Advisor draft editor — iOS caret drift + short-textarea-on-load

## Status
**Likely already fixed (May 22), pending verification.** Do NOT re-implement before
confirming the bug still reproduces on current production. A prior session already
shipped the exact fix proposed below; a stale iCloud copy of the source files caused a
later session to re-diagnose it from scratch.

## The two reported bugs
1. **Caret drift** — on iOS PWA, the text cursor renders in a different place than where
   characters actually land in the draft editor. Worsens further down a long draft.
2. **Short textarea on first load** — the draft editor opens too short and is hard to
   scroll; the "expand to fit all text" behavior is flaky on first ticket load.

Both were confirmed **iOS Safari / PWA on iPhone only** (not desktop, not iPad-specific).

## Root cause (confirmed via git history)
- **Apr 24, commit `37fc40a`** ("Fix iOS mobile input zoom without changing visual font
  size") introduced `transform: scale(0.8125)` on `.draft-editor-wrap`, `.steer-row`,
  `.action-chat-input-row` inside the `@supports (-webkit-touch-callout: none)` /
  `@media (max-width:768px)` block in `customer-service/dashboard/public/styles.css`.
  - The commit message claimed "Container transform avoids WebKit textarea caret-offset
    bugs." This was the **opposite** of reality: an ancestor `transform` is exactly what
    triggers iOS WebKit's textarea caret-positioning bug (caret uses the unscaled
    coordinate space while text wraps in the scaled space).
  - The same transform created a layout gap that the JS `autoExpandTextarea` tried to
    compensate for with a negative `margin-bottom` based on `offsetHeight` — fragile and
    a contributor to the short/flaky textarea.

## The fix (ALREADY SHIPPED — commit `a74c7f1`, 2026-05-22 22:39 +0800)
Bundled (somewhat invisibly) under the message "CS dashboard: fix cross-ticket send
misfire from stale shared state." It made exactly these changes:

**styles.css** — replaced the transform hack with a layout-level zoom:
```css
.steer-row,
.draft-editor-wrap,
.action-chat-input-row {
  zoom: 0.8125;        /* was: transform: scale(0.8125) + width:123.077% + margin-right + margin-bottom hacks */
}
```
`zoom` shrinks the actual layout box (Safari-supported), so the caret coordinate space
stays consistent — no drift — while keeping the visual ~13px to match conversation text.
`font-size: 16px !important` on the inputs is retained (that, not the scale, is what
prevents iOS zoom-on-focus). `#draft-editor` keeps `min-height: 43dvh` (visually ~35dvh
under zoom).

**app.js** — hardened `autoExpandTextarea(el)`:
- Bail when `scrollHeight === 0` (element not laid out yet: panel just toggled from
  `display:none`, fonts still loading) instead of locking height to `0px`/min-height.
- Retry on `requestAnimationFrame`.
- Re-run once after `document.fonts.ready` (guarded by an `el.dataset.fontsHooked` flag).
- Removed the iOS `margin-bottom` compensation (obsolete now that there's no transform gap).

This is in HEAD (`a74c7f1` is an ancestor), so it's in current `main`.

## Remaining open questions (the actual work, if any)
1. **Is `a74c7f1` deployed to ops.rubyshines.com?** The dashboard serves static files from
   `customer-service/dashboard/public/`. Confirm Railway has redeployed past `a74c7f1`
   (and hard-refresh / bump the service worker cache — `sw.js` may be serving stale
   `styles.css`/`app.js` to the installed PWA).
2. **Does the bug still reproduce on current prod (post-May-22)?**
   - If **no** → the issue is resolved; close this out. Jamie was remembering pre-May-22
     behavior from the trip.
   - If **yes** → `zoom: 0.8125` is insufficient on his iOS version. Fallback options:
     - Drop the visual shrink entirely: render inputs at true 16px on mobile (no zoom, no
       transform). Larger than conversation text but caret-correct and zoom-proof. This is
       the most reliable known-good option.
     - Investigate PWA service-worker caching as the real culprit (stale CSS), not CSS.
3. **PWA cache:** whichever way it goes, verify `sw.js` isn't pinning old assets — a likely
   reason a shipped fix wouldn't appear on the installed home-screen app.

## Process learnings (important)
- **iCloud stale-file hazard extends to CODE, not just memory files.** This repo lives in
  iCloud Drive. A session `Read` the pre-May-22 version of `styles.css`/`app.js` while git
  tracked the post-fix version — `git diff` was empty but `Read` showed old content. Before
  diagnosing a "current" bug from source, cross-check against `git show HEAD:<path>` (or
  `git grep HEAD`) when behavior contradicts git state. If `Read` and `git` disagree, trust
  git.
- **Check git history for the symptom BEFORE diagnosing from current source.** A 2-minute
  `git log -S "<relevant css/js token>"` would have surfaced the May 22 fix immediately and
  saved an entire re-diagnosis session.

## Pointers
- `customer-service/dashboard/public/styles.css` — iOS block under
  `@media (max-width:768px)` → `@supports (-webkit-touch-callout: none)`.
- `customer-service/dashboard/public/app.js` — `autoExpandTextarea()`.
- `customer-service/dashboard/public/sw.js` — PWA service worker (asset caching).
