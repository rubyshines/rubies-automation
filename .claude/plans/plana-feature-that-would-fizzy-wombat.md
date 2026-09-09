# Playlists ("Sets") Feature

## Context

Jamie wants named, ordered collections of songs — playlists — that can organize a set for use in
any of the three modes. Today there is no playlist/setlist concept anywhere: play mode has a
per-user `play_queue`, jam has a per-session `jam_queue`, and practice is a stage-filtered library
view. Two bulk-"seed" endpoints already exist server-side with no UI caller (`POST
/api/v2/play/queue/seed` at server.js:4628 and `POST /api/jam/sessions/:code/queue/seed` at
server.js:4885, whose `sessionStorage['seedSongIds']` hook in jam.js:349-358 is wired but never
written) — they are the ready-made integration points.

**Agreed behavior (confirmed with Jamie):**
- Practice mode: selecting a playlist **filters** the library view (like a stage chip) — non-destructive.
- Play mode: sending a playlist **always appends** to Up Next; the tab reader gains a **"Next song"** control to flow through the set.
- Jam mode: host seeds the session queue from a playlist (append).
- Management lives **in the song library page** (/practice) — no new page.

Work happens in a worktree off `origin/main` per the repo's branch rules; dev loop is
build → `/preview` → `/ship`.

## Phase A — Schema, API, library management, practice filter

### A1. Schema (both files, idempotent)

In [db-schema.sql](db-schema.sql) after `play_queue` (~:221), mirrored in
[db-schema-pg.sql](db-schema-pg.sql) with the usual dialect (SERIAL, TIMESTAMPTZ, DOUBLE PRECISION):

```sql
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS playlist_songs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0,   -- REAL = insert-between without renumbering (play_queue precedent)
  added_at TEXT DEFAULT (datetime('now')),
  UNIQUE(playlist_id, song_id)
);
CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);
CREATE INDEX IF NOT EXISTS idx_playlist_songs_pl ON playlist_songs(playlist_id, position);
```

No db-init.js migration needed (schema files re-run; tables are IF NOT EXISTS). Song/user deletes
cascade out, mirroring `play_queue`/`jam_queue`. Adds use `INSERT OR IGNORE` (db.js translates to
`ON CONFLICT DO NOTHING` on PG).

### A2. API endpoints — [server.js](server.js), new section after the play-queue block (~:4750)

Follow the house style exactly: sequential if-guards, `pathname.match(regex)`,
`const userId = await requireAuth(req, res); if (!userId) return;`, ownership via `user_id` in
WHERE (for `playlist_songs`, via a parent-playlist ownership check/subquery),
`parseBody(req).then(async body => {...}).catch(e => sendJson(res, 500, {error: e.message}))`.

| Endpoint | Behavior |
|---|---|
| `GET /api/v2/playlists` | List with `LEFT JOIN` song_count, `ORDER BY LOWER(name)` (NOT `COLLATE NOCASE` — PG parity). Light payload: `{id, name, songCount}`. |
| `POST /api/v2/playlists` | `{name}`, trim + reject empty (400). Return `{id: lastId, name}`. |
| `PATCH /api/v2/playlists/:id` | Rename; `changes === 0` → 404. |
| `DELETE /api/v2/playlists/:id` | Delete (songs cascade). |
| `GET /api/v2/playlists/:id` | Detail: ownership check → one JOIN query (songs + artists + LEFT JOIN user_songs for stage), ordered by position. **Light hydration only** — do NOT use `playQueueSongDetail` (:1803) here; it pulls full tab content per song. Return `{id, name, songs:[{playlistSongId, position, id, name, artist, artworkUrl, stage}]}`. |
| `POST /api/v2/playlists/:id/songs` | `{songIds:[]}` → MAX(position)+1 transactional append with `INSERT OR IGNORE` (model on seed endpoint :4628). |
| `DELETE /api/v2/playlists/:id/songs/:psId` | Delete by playlist_songs.id with ownership subquery guard. |
| `PATCH /api/v2/playlists/:id/reorder` | `{items:[{playlistSongId, position}]}` transaction — same shape as `/api/v2/play/queue/reorder` (:4646). |

**No "send to queue" endpoints.** Client calls the existing seeds with the playlist's ordered
songIds: `POST /api/v2/play/queue/seed` (:4628) and `POST /api/jam/sessions/:code/queue/seed`
(:4885). They already do transactional max-position append — exactly the agreed "always append".

### A3. Library UI — [songs.js](songs.js), [songs.html](songs.html), [songs.css](songs.css)

- **State**: `state.playlists` + `let _activePlaylistFilter = null; // {id, name, songIds:Set}` next to `_activeStageFilter` (:640). `loadPlaylists()` via existing `apiFetch` (:533), called at init.
- **Playlist chips row**: `<div id="playlist-filters">` under `#stage-filters` (songs.html:64); render like `renderStageFilters()` (:690) — one chip per playlist + "+ New". Hide the row when no playlists exist. Tap chip → fetch detail, set `_activePlaylistFilter`, `filterQueue()`; tap again clears. Active chip shows a pencil → opens manager sheet.
- **Compose filter in `filterQueue()` (:775)**: one added line before the stage filter — `if (_activePlaylistFilter) filtered = filtered.filter(s => _activePlaylistFilter.songIds.has(s.id));`. Stage/search/sort unchanged. Update `renderQueue()`'s `isFiltering` check (:597).
- **Manager sheet**: reuse the shared bottom-sheet modal (songs.html:290-299, helpers songs.js:1365+). Rename, delete (via existing `showConfirm` :864 pattern), ordered rows via `buildSongCard` ([card.js](card.js):26) with `showDrag`/`showRemove`, reorder via `initCardDrag` (card.js:113) → PATCH reorder (map `queueId`→`playlistSongId` client-side; don't fork card.js). Buttons "Play this set" / "Jam this set" (Phase B).
- **Add to playlist**: second button in `#select-action-bar` (songs.html:238-241) beside bulk-remove; opens a chooser (playlist list + "New playlist…") → `POST /:id/songs {songIds:[..._selectedIds]}` (those are canonical song ids — correct). Also an "Add to playlist" action in the practice detail view footer near `#btn-delete-song` (songs.html:197) for the single-song path.
- **CSS**: new `pl-*` prefix; chips copy `.stage-chip` styles. songs.css is shared with play.html, so the chooser sheet styles are reusable in Phase B.

## Phase B — Send to Play and Jam

### B1. Play — [play.js](play.js), [play.html](play.html)
"Playlists" button in the Up Next header (near play.html:35-47). Tap → fetch playlists → chooser
sheet → on pick: `GET /api/v2/playlists/:id` → `POST /api/v2/play/queue/seed {songIds}` →
`loadQueue()`. Library-side "Play this set" does the same two calls then `location.href = '/play'`.

### B2. Jam — zero jam.js changes for v1
Library-side "Jam this set": `sessionStorage.setItem('seedSongIds', JSON.stringify(orderedSongIds));
location.href = '/jam';` — jam.js:349-358 already consumes the key on Create Jam and calls the jam
seed endpoint (verified wired, currently never written). Optional follow-up (defer): host-view
"Add playlist" picker on a live session calling the jam seed endpoint directly.

## Phase C — "Next song" in the reader (independent of playlists; benefits any queue)

### C1. [ug-reader.js](ug-reader.js)
- Extend `setPlayContext` (:3978-3983) with optional `onNext`; add `_onNext` module var beside
  `_onClose` (:54), reset it in `close()`'s reset block (:3964-3975) and in `setPlayContext`.
- Toolbar "Next song" button shown only when `_onNext` is set (parallel to `_applySaveButton`
  :3329, applied at the same call sites: open, setPlayContext, close). Click calls `_onNext()`
  without closing.
- Song swap in place is proven: jam clients already call `UGReader.open(...)` while the overlay is
  open on `state_update` (jam.js:1339). No `onPrev` in v1 (reverse semantics are muddy).

### C2. [play.js](play.js)
Refactor `openFromQueue` (:137) so per-song context setup is reusable; `onNext` =
`doneWithSong(item)` (:177) → refetch queue → if none left, `UGReader.close()`; else
`history.replaceState` (not pushState — jam precedent jam.js:1324) to `/play/:nextId` → re-open in
place with a fresh `setPlayContext`. Edge cases: next item with no tab → close and let the existing
`UGScrape.trigger` path handle it; verify `onClose`/back-button behave with replaced history entries.

## Ordering
A1 → A2 (curl-testable standalone) → A3 (Phase A ships alone as a useful feature) → B1/B2 (small
independent patches) → C (touches the shared reader — riskiest file, kept last). Bump cache-busting
`?v=` query strings on all changed scripts in their HTML files.

## Verification
- `npm test` still passes (ug-renderer only; no coverage here — all manual).
- **A**: curl CRUD incl. wrong-user 404s; in the app: create/rename/delete, multi-select add,
  duplicate add no-ops, drag-reorder persists across reload, chip filter composes with stage chip +
  search + sort, deleting a library song drops it from playlists.
- **B**: 3-song set → play: appended after existing items in order; seed twice → duplicates
  (expected, play_queue has no uniqueness). Jam: "Jam this set" → Create Jam → host queue seeded;
  participant sees it; tab-less songs seed fine (hydration happens on open).
- **C**: Next advances through the set marking each played (Recently Played grows, Up Next
  shrinks); last song's Next closes reader; Back mid-set closes cleanly without stacked history;
  jam/practice readers unaffected (no `onNext` passed → no button).
- End-to-end on `/preview` (phone included), restart server after backend changes.
