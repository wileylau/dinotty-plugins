# Dinotty Plugins

Extra plugins for [Dinotty](https://github.com/xichan96/dinotty), the web terminal IDE.

## Plugins

| Plugin | Description |
| --- | --- |
| [`opencode-go-usage`](opencode-go-usage) | OpenCode Go plan usage (5h / weekly / monthly), estimated spend, and the current opencode session cost in Dinotty's status bar. Follows opencode tab switches via the terminal title. |

## Install a plugin

From the Dinotty UI:

1. **Settings → Plugins → Install from directory** and pick the plugin folder, or
2. **Install from Git** with this repository URL and the plugin's subdirectory.

For development, link a plugin checkout so edits hot-reload:

```text
Settings → Plugins → Install from directory → enable "dev link"
```

The link is created under `~/.dinotty/plugins/<plugin-id>` (or
`~/.dinotty<config-suffix>/plugins` when Dinotty runs with a config suffix).

## Plugin layout

```text
<plugin-id>/
├── plugin.json     # manifest: id, entry, permissions, bin, commands
├── main.js         # activate(ctx) exports the UI + monitor series
├── styles.css      # scoped styles for the plugin UI
├── bin/            # optional native helpers (declared in plugin.json)
└── test/           # optional fixtures
```

See [`plugin-api/index.d.ts`](https://github.com/xichan96/dinotty/blob/dev/plugin-api/index.d.ts)
in the main repository for the host API.
