# OpenCode Go Usage (Dinotty plugin)

Shows OpenCode Go plan usage in Dinotty's status bar, next to the system
monitor, and in a click-through popover.

- 5-hour rolling / weekly / monthly **usage percentages** and reset countdowns
  in the popover; the status bar itself shows the 5-hour rolling window and the
  current session cost (`Go 5h 23% | $0.42`)
- **Estimated spend** per window from your plan caps (Go `$12/$30/$60`,
  Go Plus `$48/$120/$240`)
- **Current opencode session cost**, read from opencode's local service and
  updated live when the visible opencode tab changes or a prompt completes

## Data sources

- `GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <key>`
  returns `{usage:{rolling,weekly,monthly:{status,percent,resetsAt}}}`.
- `~/.local/state/opencode/service.json` → `GET <url>/api/event` (SSE) emits
  `session.viewed` (tab switch) and `session.usage.updated` (`cost`, `tokens`).
  The renderer opens this stream itself; opencode allows the CORS preflight for
  loopback and Tauri origins.
- `GET <url>/api/session` seeds the session list on startup and every five
  minutes; it is also the fallback when the event stream is unavailable (for
  example a LAN web-UI origin that opencode does not CORS-allow).

The usage endpoint answers CORS preflights with 404, so a renderer `fetch` is
blocked. The plugin ships a small `bin/` helper that performs the request
server-side with the key in the environment. On Windows it uses PowerShell's
`Invoke-WebRequest` (a `.cmd` shim + `.ps1`); on macOS/Linux it uses `curl`.
That is why the plugin asks for `native.execute` and `workspace.read`.

## Install

1. Place this directory under `~/.dinotty/plugins/opencode-go-usage` (or
   `~/.dinottydbg/plugins/` for a debug build), or use **Settings → Plugins →
   Install from directory**.
2. Approve the native-execution permission.
3. Open the plugin tab, paste an OpenCode Go API key, or press **Import from
   opencode** to reuse `~/.local/share/opencode/auth.json`.
4. Pick your plan (Go / Go Plus) so the cost estimates use the right caps.

The key is stored as JSON under Dinotty's plugin data directory
(`~/.dinotty/plugin-data/opencode-go-usage/`). Requests go only to
`opencode.ai` and `127.0.0.1`.

## Notes

- The usage endpoint reports a plan-level percentage, not per-model dollars.
  Cost rows are therefore estimates (`percent × cap`) and are labelled `≈`.
- “Current session” is the opencode tab you are on. Two signals are combined:
  the terminal title opencode writes on every tab switch (`OC | <session
  title>`, truncated to 40 chars) and opencode's `session.viewed` event. The
  title poll (1s, in-process) means switching between already-read tabs updates
  the cost immediately; `session.viewed` alone only fires when a view clears an
  unread idle transition, so it is now a fast path rather than the only source.
- Cost accuracy is whatever opencode reports. Models without pricing metadata
  (for example `opencode-go` models) legitimately report `$0`.
- **Live session cost** can be turned off in the plugin tab. It only controls
  the event stream; plan usage polling and the five-minute session reconcile
  keep working, so the cost falls back to one refresh per polling interval.
- Credential fallback: the plugin does not read `OPENCODE_GO_API_KEY` from the
  environment; use the key field or the import button.
