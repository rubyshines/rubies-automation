# OCADU seat watcher (personal)

Watches OCAD University's public course catalog for open seats in specific
Fall-term sections and alerts Jamie by email (SendGrid, to jamie@rubyshines.com)
and macOS notification. Not a RUBIES system — it just lives in this repo to
reuse the SendGrid client and version control.

- Currently watching ONLY ENGL-1003-301B and ENGL-1003-301D (Fall 2026) as
  swap targets for the registered ENGL-1003-301G: every ENGL-1003 section
  shares the Friday 10:00-11:30 lecture, and these two put the tutorial on
  Mon or Fri 3:10-4:40, freeing her Tuesday. Alerts include both time slots,
  rooms, instructors, and the drop-then-add swap reminder.
- Courses/sections/term watched: edit `WATCHED_COURSES` / `WATCHED_SECTIONS` /
  `WATCHED_TERM` at the top of [watch.js](watch.js).
- Alert-format check: `node personal/ocadu-watch/watch.js --test-alert --dry-run`
  (or without `--dry-run` to send a real [TEST] email).
- The catalog API is anonymous (no student login). Registration itself stays
  manual in Self-Service — this is notify-only, on purpose (the student login
  is SSO + authenticator-app MFA; automating it is fragile and risky).
- Runs every 3 minutes via launchd: `~/Library/LaunchAgents/com.jamie.ocadu-watch.plist`
  (runs from the main checkout; logs to `~/Library/Logs/ocadu-watch.log`).
  - Reload after editing: `launchctl unload ~/Library/LaunchAgents/com.jamie.ocadu-watch.plist && launchctl load ~/Library/LaunchAgents/com.jamie.ocadu-watch.plist`
  - Stop for good: `launchctl unload ...` and delete the plist.
  - Note: launchd only fires while the Mac is awake. If the Mac may sleep
    during registration season, `sudo pmset -a sleep 0` or Amphetamine.
- State (last seen availability, alert throttling) lives in `.state.json`
  (gitignored). An open seat alerts immediately, re-alerts every 30 min while
  open, goes quiet when it fills.
- Manual check: `node personal/ocadu-watch/watch.js --dry-run` (prints, sends
  nothing, doesn't touch state).
- Retire the watcher once she's registered: unload the plist; optionally delete
  this folder.
