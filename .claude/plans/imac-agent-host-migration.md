# iMac Agent Host Migration

Moving agent hosting for 3 repos (rubies-automations, rubies-ecom-v4, guitar-practice)
from the MacBook Air to an always-on iMac.

Status: **design in progress** — goals locked, tooling researched, migration steps not yet written.

## Goals (in priority order, confirmed 2026-08-28)

1. **Continuity** — agents keep running when the laptop closes. The actual driver.
2. **Fleet awareness** — one view across all 3 repos showing which agent is blocked on Jamie.
3. **Notification** — push when a session completes or needs an answer.
4. **Rich interaction** — Jamie chose the VS Code extension over the terminal deliberately;
   losing that is a real cost, not a rounding error.
5. **Phone** — occasional. Scope: read a blocked agent's question and reply. Not full sessions.

## Locked decisions

- **The Air becomes a thin client.** The iMac is the single agent host and the only checkout
  that matters. No agents run on the Air. This is the only way "close the lid" is genuinely
  true, and it removes the two-machines-one-repo hazard that the worktree and memory rules in
  `feedback_technical_rules.md` exist to prevent.
- **herdr + terminal Claude Code** as the agent runtime, over screen-sharing or Remote-SSH.
- **Reachable from anywhere**, not LAN-only → Tailscale between iMac, Air, and phone.
- **Phone scope is "answer a blocked agent"** — no full-session support required.

## Research findings — the "richer terminal" question

Jamie's follow-up: is there a third-party terminal that restores a richer experience,
e.g. editing prompts with the mouse?

**The terminal emulator is the wrong layer.** Claude Code's prompt input does not support
click-to-position-cursor. Ink (its TUI framework) enables terminal mouse reporting, but the
text-input component never translates click events into cursor moves. Multiple open feature
requests, none shipped. No emulator can fix this — Ghostty, WezTerm, iTerm2, Kitty and Warp
all merely *forward* mouse events; the application has to consume them. **Switching terminals
buys nothing here.**

Three things that do change the answer:

- **Claude Code v2.1.195+ does capture mouse events** — click-to-expand, hover, scroll
  acceleration. So the CLI is not mouse-dead, and click-to-expand recovers one of the specific
  things Jamie liked about the extension (collapsible sections). Escape hatch if it interferes
  with terminal text selection: `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` (kills click/drag/hover,
  keeps scroll wheel).
- **Ctrl+G opens the current prompt in an external editor** (since v2.0.10) — this is the real
  answer for composing and mouse-editing long prompts, and it can open VS Code. Caveat: reports
  say it auto-detects installed IDEs rather than respecting `$EDITOR`/`$VISUAL`; making it
  configurable is an open request. Needs verifying on Jamie's setup.
- **Warp is a worse fit, not a better one.** It has added mouse support in alt-screen apps, but
  has known bugs dropping Mac editing shortcuts (cmd+arrows, cmd+delete, option+delete) inside
  TUI apps using the Kitty keyboard protocol. That is exactly the keyboard editing Claude Code
  falls back on.

**Conclusion:** pick Ghostty or iTerm2 and stop optimising the emulator. The richness gap is
closed by Ctrl+G → VS Code, and by herdr's browser UI (below), not by the terminal.

### Community position on click-to-position-cursor

Seven separate issues filed on `anthropics/claude-code`, all between 2026-03-08 and 2026-04-17.
**Every one was closed by a bot, not a human** — no Anthropic maintainer ever replied. Five were
stale-closed (`state_reason: not_planned`, which is the inactivity bot, not a product decision),
one as a duplicate.

Reaction counts look low (max +4), but that understates demand: the duplicate bot directs people
to 👍 the canonical issue #32206 — and #32206 was itself stale-closed on 2026-04-05 and **locked**
on 2026-04-13. Anyone arriving after mid-April cannot upvote it. The signal is structurally
suppressed by the bot pipeline, so neither "+4, nobody cares" nor "huge unmet demand" is the right
read. It is a recurring papercut with no sign of being worked on.

**What people use instead**, in increasing order of investment:
- `keybindingFlavor: "readline"` — GNU readline conventions (Ctrl+A/E/W/K/U, Alt+B/F/D). The
  natural fit for a non-vim user. **Gotcha: Alt/Option bindings require configuring Option-as-Meta
  in the terminal emulator** or they silently do nothing.
- `/vim` (`editorMode: "vim"`) — the community's consensus answer for prompts of 5+ lines. Esc,
  jump, fix, `i`/`a` to resume. Affects the prompt input only, nothing about how Claude edits files.
- `Ctrl+G` → external editor for anything genuinely long.
- `/keybindings` — fully customisable JSON, chords, unbind anything.

The cost lands on *medium* prompts (roughly 3–8 lines, fixing a word near the top). Short prompts
make cursor movement trivial; long ones are better handled by Ctrl+G than by clicking. Jamie is
coming from the VS Code extension, where the input is a real text box — he will feel this more
than a terminal native would.

**Cheap de-risk:** run one real session with `claude` in a terminal on the Air, with readline mode
on, before committing to anything. ~20 minutes, and it tests the single biggest unknown in the
migration.

## Research findings — herdr

Rust terminal multiplexer built for coding agents. Background server runtime: close the lid and
agents keep running; reboot and it restores layout and resumes sessions. Reads every pane and
marks each agent **working / blocked / idle**, surfaced in a sidebar across all workspaces.
Detach/reattach over SSH with keepalives, plus a `--remote` thin-client streaming mode. Supports
Claude Code, Codex, Cursor, opencode and others — it owns their terminals rather than wrapping
them. Single binary, macOS/Linux/Windows.

Known pattern from a practitioner writeup: **one herdr workspace per git worktree**, which maps
cleanly onto this repo's existing worktree protocol.

**Browser access** is where the "rich + phone" goals converge. herdr has a built-in dashboard,
and there is a third-party ecosystem: `herdr-webui` (desktop *and mobile* layouts, terminal
attach, workspace/worktree navigation, agent status, git status/diff/staging, file explorer),
plus `herdr-web` and `herdr-browser`. A browser client gives real mouse interaction everywhere
and answers the phone goal with the same tool.

**Risks to hold consciously:**
- herdr is **pre-1.0 (0.7.x)** and self-described experimental. Three repos would depend on it.
- `herdr-webui` is **9 stars, 2 forks, single maintainer**. That is unvetted software sitting
  between Jamie and every agent, and it would be exposed over Tailscale. Auth exists but is
  undocumented in what was reviewed. Prefer herdr's built-in dashboard first.
- **herdr provides no sandboxing.** Agents run with whatever permissions they are given.
  Combined with an always-on machine running unattended sessions, and this repo's wide
  user-scope Edit/Write/Bash allow rules in Auto mode, that is a decision to make deliberately
  rather than inherit.

## Open questions

- Trial repo before committing all three? (`guitar-practice` is the obvious candidate — no
  secrets, no production surface.)
- Unattended permission posture on an always-on host: keep Auto mode with wide allow rules, or
  tighten for sessions that run while Jamie is away?
- Notification transport: Claude Code `Stop` / `Notification` hooks → what? (ntfy, Pushover,
  Telegram, Slack.) This is orthogonal to herdr and could ship independently, today.
- Does the Air keep a read-only checkout for reading code offline, or nothing at all?

## Machine-bound state that must move (not yet enumerated in full)

From `reference_deployment.md` and `feedback_technical_rules.md`:
- `.env` (gitignored) and `.ngrok/ngrok.yml` (gitignored; master copy in the iCloud repo copy)
- ngrok: two separate accounts — the machine-wide paid authtoken behind `/preview`'s
  `ra-1`…`ra-5` pool, and the `tahr-large` config-file account
- MCP stdio server config (`customer-service/server.js`)
- Local dashboard on port 3847, and the `scripts/restart-dashboard.sh` convention
- Worktrees under `~/Code/rubies-repo/worktrees/` with `.env` / `node_modules` symlinks
- `gh` auth, Railway CLI auth
- Google OAuth authorized origins are per-origin, not per-machine → `localhost:3847` unaffected

Production (Railway, Supabase, webhooks) is unaffected by this migration.

---

## Update 2026-08-28 — Remote Control found; revises the design

### Claude Code install drift (must fix BEFORE migrating)

Three installs on the Air, three versions:

| Install | Version | Status |
|---|---|---|
| `~/.nvm/versions/node/v22.20.0/bin/claude` (npm global) | 2.1.154 | wins on PATH, last updated 28 May |
| `/usr/local/bin/claude` (root symlink → system npm) | 2.1.73 | 11 Mar, shadowed |
| VS Code extension bundle | 2.1.241 (2.1.250 staged) | what the extension runs |

`~/.claude/settings.json` sets `"model": "opus"` — an **alias, not a pinned ID**. Each binary
resolves it to the newest Opus it knows about, so 2.1.154 → Opus 4.8 and 2.1.241 → Opus 5.
Nothing misconfigured; the terminal binary is three months stale, and npm-installed Claude Code
does not self-update the way the native installer does.

**Migration hazard:** herdr launches whatever `claude` is on PATH. As configured today, moving to
herdr would silently downgrade every agent from Opus 5 to Opus 4.8 — no error, just worse output,
easily misattributed to the terminal switch. Fix the install first; on the iMac install once via
the native installer so it stays current.

### Remote Control changes the phone design

`claude --remote-control` registers the machine as a device card in the Claude mobile app and
claude.ai/code. Code, env vars, MCP connections and project config stay on the host; the phone is
a window into the running local process. Outbound HTTPS with polling — **no listening ports**.
Since the Aug 2026 update, a new session can be started from the phone by picking a directory on a
connected machine. Present in both 2.1.154 and 2.1.250.

**Cloud sessions (`--cloud`) are a different thing and cannot host rubies-automations** — no
`.env`, no stdio MCP server, no Supabase service keys, no 3847 dashboard, no ngrok. Using them
would mean putting production credentials into a hosted sandbox. Possibly viable for
guitar-practice only.

### Revised positions

- **Remote Control replaces `herdr-webui`** for the phone goal. Drops the 9-star single-maintainer
  dependency and its Tailscale exposure — the largest risk previously flagged.
- **Remote Control does not replace herdr** for continuity or fleet view: an SSH session still
  dies on disconnect without a multiplexer, and there is no working/blocked/idle board across
  workspaces.
- **Tailscale downgrades from required to nice-to-have** — still wanted for SSH and reaching the
  3847 dashboard, no longer load-bearing for the phone goal.
- **The herdr decision is now worth re-examining.** Remote Control + plain tmux may cover enough of
  goals 1–3 that herdr is optional. Its unique contribution is reduced to the cross-agent status
  board — which is real, but is now the sole justification for a 0.7.x dependency.

### Revised open questions

- herdr vs plain tmux, given Remote Control covers the phone goal natively?
- Fix the Claude Code install drift on the Air now, or only set it up cleanly on the iMac?
- Trial repo (`guitar-practice`) still the right first move?
- Unattended permission posture on an always-on host.

### RESOLVED 2026-08-28 — install drift cleaned up on the Air

- Removed the nvm npm global install (was 2.1.154).
- Installed the native build via `claude install` → `~/.local/bin/claude`, now **2.1.251**.
  `claude doctor`: install method `native`, **auto-updates enabled**, channel `latest`.
- Verified `"model": "opus"` now resolves to `claude-opus-5` (confirmed via
  `claude -p --output-format json`, not assumed).
- Left for Jamie (needs sudo): root-owned orphan from a March install —
  `sudo rm -rf /usr/local/lib/node_modules/@anthropic-ai /usr/local/bin/claude`.
  Already shadowed (`~/.local/bin` is PATH position 3, `/usr/local/bin` position 8) and there is
  no `node` at `/usr/local/bin` any more, so it is a dead cli.js — but it is a trap if PATH order
  ever changes.
- **Deliberately not touched:** the VS Code extension's bundled binary
  (`~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude`). That is how the
  extension runs and it updates with the extension; deleting it breaks the extension. "One Claude"
  means one on PATH.

**iMac recipe (settled): `claude install`, never npm.** npm-installed Claude Code does not
self-update, which is precisely what would leave herdr launching a stale binary on a stale model.
Also worth not reproducing on the iMac: the Air's PATH has duplicates (nvm 3×, `~/.local/bin` 2×)
from `.zshrc`/`.zprofile` sourcing twice.

## Update 2026-08-28 (b) — notification design; keybinding correction

**Correction: `keybindingFlavor` is not a real setting.** It came from a third-party blog and does
not appear in the official keybindings reference; writing it into settings.json would silently do
nothing. The real position is better than first described: **readline-style editing is already the
default** (Ctrl+A/E/W/U/K, Ctrl+Y to paste back a deletion). There is no flavour switch. The only
real choice is default vs `editorMode: "vim"`. Remapping, if wanted, goes in
`~/.claude/keybindings.json` (contexts + `namespace:action`, chords, `null` to unbind).

Also: Jamie is already on `tui: fullscreen`, which provides **mouse text selection and Cmd+C copy**
inside the TUI (`selection:*` and `scroll:*` actions are fullscreen-only). The terminal experience
is less impoverished than the first pass assumed.

### Notifications — local hooks fire on the WRONG machine

Once Claude runs on the iMac, an `afplay`/`osascript` Notification hook executes on the iMac, where
nobody is sitting. It would look configured and deliver nothing. Only two channels actually reach
Jamie on the Air:

- **The terminal's escape-sequence desktop notification, which travels over SSH** (documented).
  Native in Ghostty, Kitty and iTerm2. **The VS Code integrated terminal gets none** — it needs
  `preferredNotifChannel: "terminal_bell"` or a Notification hook instead.
- **Phone push** — `agentPushNotifEnabled` is **already `true`** in Jamie's settings, so part of
  goal #3 is already in place.

**Multiplexers swallow these notifications.** tmux requires `set -g allow-passthrough on` (plus
`extended-keys on` and `terminal-features 'xterm*:extkeys'` for Shift+Enter). Whichever multiplexer
wins, this must be configured or goal #3 breaks silently — **a concrete question to put to herdr
during the trial.**

This also feeds the terminal choice for the Air: prefer Ghostty or iTerm2 over the VS Code
integrated terminal, because they forward notifications over SSH natively. iTerm2 additionally
needs Settings → Profiles → Terminal → "Notification Center Alerts" + "Send escape
sequence-generated alerts". Option-as-Meta (needed for Meta+P/Meta+O) is iTerm2 Settings →
Profiles → Keys → Left/Right Option = "Esc+".

### Immediate next step (on the Air, no migration required)

`claude --remote-control`, then open the Claude mobile app. Tests the phone goal for real. If it
satisfies, `herdr-webui` is off the table permanently.
