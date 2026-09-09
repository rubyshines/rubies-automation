# Voice Search — speak a song, it loads

## Context

Playing guitar means both hands are busy. Today, loading a song means putting the guitar down,
tapping the search bar, and typing. Voice search removes that: tap a mic button, say the song, and
the existing typeahead does the rest.

Jamie's decisions from planning:
- **Activation:** push-to-talk mic button (no wake word, no always-on mic).
- **Surfaces:** the search bars on **Play**, **Practice**, and **Jam**.
- **Scope:** song loading only — no reader commands, no vibe discovery.
- **Devices:** works on phone and desktop; iOS-specific work only if forced.

Jamie also asked *"can it auto-submit, or does it fill the text and wait?"* — answered in
[Behaviour](#behaviour) below.

## What the code already gives us

All three surfaces share **identical search markup** — `.play-search-bar` >
`.play-search-input-wrap` > `input.play-search-input` + `.play-typeahead`:

| Surface  | Input id                | Typeahead id          | Handler |
|----------|-------------------------|-----------------------|---------|
| Play     | `play-search-input`     | `play-typeahead`      | [play.js:308](play.js#L308) `initPlaySearch` |
| Practice | `practice-search-input` | `practice-typeahead`  | [songs.js:2952](songs.js#L2952) |
| Jam      | `jam-search-input`      | `jam-typeahead`       | [jam.js:868](jam.js#L868) |

Each attaches a debounced `input` listener that queries `/api/v2/songs/library-search` +
`/api/v2/songs/spotify-suggest` and renders rows. **So the whole feature is: put text in the input
and fire an `input` event.** Every existing search path then runs unchanged — zero edits to
`initPlaySearch`, `songs.js`, or `jam.js` search logic.

Three findings that shape the design:

1. **Rows bind `mousedown`/`touchend`, not `click`** ([play.js:464-470](play.js#L464)). Auto-picking
   a row must `dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true}))` —
   `row.click()` silently does nothing.
2. **`ensureCanonicalSong` matches name+artist exactly** ([server.js:1663](server.js#L1663)) — no
   fuzzing. A raw transcript must never reach `openForPlay` directly or it creates junk songs under
   "Unknown Artist". Resolution has to go through the typeahead, which this design does by
   construction.
3. **`library-search` LIKEs the whole query** against `s.name OR a.name`, so `"hey joe by jimi
   hendrix"` matches nothing. The transcript must be split on `" by "`.

No mic contention: the UG reader's Chord Scroll ([ug-reader.js:3211](ug-reader.js#L3211)) owns the
mic only inside the fullscreen reader, and voice lives only on search bars. No `SpeechRecognition`
exists anywhere in the codebase yet.

## Behaviour

**Live search while speaking, then a cancellable auto-open.** This is the answer to the auto-submit
question — it gets hands-free when the match is obvious, without ever silently opening a wrong song.

1. Tap 🎤 → button pulses, placeholder becomes "Listening…".
2. **As you speak**, interim results stream into the input and fire `input` — results reorder live,
   exactly like typing. This is free: `interimResults: true`.
3. On the final result, clean the transcript:
   - strip leading `play` / `search for` / `find` / `put on` / `load`
   - split on `" by "` → title goes in the input, artist is kept in memory as `spokenArtist`
   - (title-only in the input is what makes `library-search` hit; Spotify free-search on the title
     alone still returns the popular cut)
4. ~400 ms later (after the existing debounce settles), pick a row:
   - if `spokenArtist` was given → first `.ta-song` whose artist matches it
   - else → first `.ta-song[data-lib-name]` (library hits render first)
   - **only these two count as confident.** A Spotify-only hit with no spoken artist is *not*
     auto-opened — it just stays on screen to tap.
5. Confident hit → highlight the row, show "Opening *Hey Joe*… tap to cancel", and after **1.5 s**
   dispatch `mousedown` on it. Any tap, keypress, or scroll cancels.
6. Not confident → do nothing. The list is already filled from step 2; tap as you do today.

A `localStorage` flag (`voiceAutoOpen`, default on) turns step 5 off entirely for anyone who wants
pure dictate-then-tap.

## Implementation

### New: `voice-search.js` (~200 lines, `window.VoiceSearch`)

Self-mounting, page-agnostic — no per-page wiring:

```
on DOMContentLoaded:
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) return;   // no button at all
  document.querySelectorAll('.play-search-input-wrap').forEach(mount);
```

`mount(wrap)` injects a `<button class="voice-mic-btn">` and binds it to `wrap.querySelector('input')`
+ `wrap.querySelector('.play-typeahead')`. One instance of `SpeechRecognition` at a time, module-level.

Recogniser config: `continuous = false`, `interimResults = true`, `maxAlternatives = 1`,
`lang = navigator.language || 'en-GB'`.

Feed the input via:
```js
input.value = text;
input.dispatchEvent(new Event('input', { bubbles: true }));
```

Stop and reset on `onend`, `onerror`, `visibilitychange`, and window blur — never leave the mic hot.

Practice has a second, separate search input (`queue-search-input`, a client-side queue filter at
[songs.js:735](songs.js#L735)) that is *not* inside a `.play-search-input-wrap`, so it's untouched.
That's correct — the `practice-search-bar` one is the song-loading search.

### New: `voice-search.css`

Mic button positioned inside the input wrap (right edge), idle / listening-pulse / error states,
plus the `.ta-song.voice-pending` highlight for the countdown. Needs its own file because Jam loads
`jam.css` while Play and Practice load `songs.css` — no single existing sheet covers all three.

### Edits (3 files, 2 lines each)

Add to the `<head>` and script block of [play.html](play.html), [songs.html](songs.html),
[jam.html](jam.html):
```html
<link rel="stylesheet" href="/voice-search.css?v=1">
<script src="/voice-search.js?v=1"></script>
```

No server, schema, or API changes. No changes to any existing JS.

## Cross-device notes

- **Secure context is fine everywhere:** prod is HTTPS (`webejam.in`), `/preview` is HTTPS ngrok,
  and `http://localhost:3000` counts as secure. No blocker.
- **iOS Safari (14.5+)** supports `webkitSpeechRecognition`, but recognition can end early and
  interim events are less reliable than on Chrome. The design degrades cleanly: if no interims
  arrive, the final result alone still fills the input and triggers the same search. Nothing
  iOS-specific to write unless testing shows otherwise.
- **Chrome** streams recognition audio to Google's servers — worth knowing, not a blocker for this.
- Feature-detection means unsupported browsers simply never see a mic button.

## Verification

1. `npm start`, then `/preview` for an HTTPS URL testable on the phone.
2. **Play** (`/play`): tap 🎤, say *"Hey Joe by Jimi Hendrix"*. Confirm results update **while**
   speaking, then the Hendrix row highlights and the UG reader opens after the countdown.
3. Repeat saying just *"Hey Joe"* — library hit should auto-open; if only Spotify hits come back,
   confirm it does **not** auto-open and waits for a tap.
4. Say something deliberately unmatchable (*"asdf qwerty"*) — no auto-open, no junk song created.
   Verify with `SELECT name FROM songs WHERE name ILIKE '%asdf%'` (must be empty).
5. Tap the screen during the countdown → cancels, list stays open.
6. Repeat 2 on **Practice** (`/practice`) and **Jam** (`/jam`) search bars.
7. Open a tab in the UG reader and enable Chord Scroll — confirm the mic still works there and
   voice search is absent (no contention).
8. Check both a phone and desktop Chrome. Deny mic permission once and confirm the button shows an
   error state rather than hanging.

No unit tests — this is DOM/browser-API glue, outside `ug-renderer.test.js`'s deterministic scope.

## Not doing (deliberately)

Wake word, reader commands ("scroll faster", "next song"), Sonnet vibe discovery via voice, and a
Haiku transcript-cleanup pass. All are additive on top of this module later if the plain version
proves it earns its place.
