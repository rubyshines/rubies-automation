---
name: Ad Hoc Operator Console
description: Ad-hoc Opus operator console accessible from dashboard top-nav (desktop) and bottom-nav (mobile). All RUBIES tools, no ticket context.
type: project
domain: cs
done_when: |
  - Ad Hoc tab visible in dashboard top nav (desktop) and bottom nav (mobile)
  - Standalone agent runs claude-opus-4-6 with all CS server tools (minus self-referential csAdvisorMcp and advisorTester)
  - Ephemeral history works (resets on tab switch / refresh)
  - Two-phase preview→confirm verified end-to-end for at least one destructive action (e.g. test refund or test exchange)
  - Dead apiActionChatStandalone, ACTION_CHAT_TOOLS, executeActionTool removed from dashboard/server.js
originSessionId: 9ada4ce1-a9ff-4205-84ba-2393b50a33c8
---
## Goal

Standalone operator console for ad-hoc CS work, lookups, and general business questions. Same UI feel as the existing in-ticket operator action-chat, but with no ticket context preloaded — Jamie types whatever he needs from any device.

## Build steps

1. **Backend:** `customer-service/lib/operatorAgentStandalone.js` (Opus, agentic loop, streaming, prompt caching, all tools). New endpoints in `dashboard/server.js`: `POST /api/console/chat` and `POST /api/console/chat-stream` (SSE). Delete dead `apiActionChatStandalone`, `ACTION_CHAT_TOOLS`, `executeActionTool`.
2. **Frontend:** extract action-chat UI from ticket panel into a reusable component; wire into existing ticket flow and new Ad Hoc Operator panel. Verify ticket flow still works.
3. Add `Ad Hoc` tab + `panel-helm` markup. Ephemeral in-memory history. (Internal code identifiers — `panel-helm`, `helm-chat-input`, etc. — kept as-is; only the user-facing label is "Ad Hoc Operator".)
4. **Mobile:** bottom nav bar (Ad Hoc + 4 most-used ticket tabs visible, others under "More"). Top header collapses to logo + stats + sign-out.
5. Manual smoke test on desktop and mobile via Railway.

## Decisions made (design conversation 2026-04-28)

- **Model:** Opus (claude-opus-4-6). Considered Sonnet+thinking, decided against — CLAUDE.md rule + standalone is more exposed to multi-tool agentic failure than ticket-bound + cost is negligible at solo-operator volume + the operator-agent shadow eval data isn't analyzed yet, so don't pre-empt.
- **Tools:** all 30+ CS server tools except `csAdvisorMcp` (would call advisor on itself) and `advisorTester` (test utility).
- **Persistence:** ephemeral. In-memory history only, lost on tab switch / refresh. Resumability not worth the storage + sync cost for solo use.
- **Mobile nav:** bottom nav bar pattern (native PWA feel) over "More ▾" overflow. Bigger refactor but cleaner long-term as more tabs get added.
- **Tab name:** "Ad Hoc Operator" (user-facing). Renamed from "Helm" in commit 86e233f. Internal code identifiers kept on `helm` for now.
- **Auth:** reuses existing dashboard session.
- **Shadow eval:** skipped for standalone — low volume, no need.
- **Voice input:** built across all 4 dashboard inputs (steer, draft, in-ticket operator, Ad Hoc). Web Speech API, toggle, continuous, append-at-cursor, no auto-send.
