# opencode-hunk

OpenCode (V2 plugin API) integration for [hunk](https://github.com/modem-dev/hunk), the terminal diff viewer.

- **CLI plugin** (`hunk.cli`): `/hunk` opens hunk for the current session's directory; your inline comments can be sent to the agent.
- **Server plugin** (`hunk`): `hunk_*` tools let the agent inspect/steer the live hunk session you have open (navigate, comment, highlight, reload).

Requires `hunk` >= 0.23 on `PATH` (or set `bin`).

## Install

Add the plugin to `opencode.json(c)` (installed from the `release` branch, which tracks the latest tagged release):

```jsonc
{ "plugins": ["github:dot-opencode/opencode-hunk#release"] }
```

The CLI plugin is enabled automatically from that entry, but without options. To set CLI options, add the plugin to `~/.config/opencode/cli.json`:

```jsonc
{ "plugins": [{ "package": "github:dot-opencode/opencode-hunk#release", "options": { "mode": "auto", "tmuxSplit": "-h", "bin": "hunk" } }] }
```

Server options (`timeoutMs`, `bin`) go in `opencode.json`:

```jsonc
{ "plugins": [{ "package": "github:dot-opencode/opencode-hunk#release", "options": { "timeoutMs": 30000 } }] }
```

### Local checkout

Point `plugins` at a clone instead:

```jsonc
{ "plugins": ["/path/to/opencode-hunk"] }
```

Local-path loading resolves `<dir>/index` (server) and `<dir>/tui` (CLI) directly; both root files re-export `src/`. Options work the same way as above.

## Options

| Option | Default | Used by | Description |
| --- | --- | --- | --- |
| `bin` | `"hunk"` | both | Hunk binary. |
| `mode` | `"auto"` | CLI | `auto` (tmux split if `$TMUX` is set; else a new Ghostty tab on macOS when `$TERM_PROGRAM` is `ghostty`; else suspend), `suspend`, `tmux`, `ghostty`. |
| `tmuxSplit` | `"-h"` | CLI | `tmux split-window` direction: `-h` (side by side) or `-v`. |
| `pollMs` | `2000` | CLI | Comment polling interval while hunk is running (suspend and ghostty modes). |
| `timeoutMs` | `30000` | server | Timeout for each `hunk session ...` call. |

## Commands (CLI)

- `/hunk [args]` — open hunk. Args go to `hunk diff` (`/hunk --staged`, `/hunk main...HEAD`); `/hunk show HEAD~1` runs `hunk show`.
  - *suspend* mode: OpenCode's TUI is suspended while hunk runs full screen. Your comments are polled while it runs (they vanish when the window closes); on exit you are asked whether to send them to the agent.
  - *ghostty* mode (macOS, Ghostty >= 1.3): opens hunk in a **new Ghostty tab** via AppleScript (`new tab ... with configuration`); the tab closes when hunk quits. The hunk binary is resolved to an absolute path, args are shell-quoted, and the current `PATH` is passed along. In the background the plugin waits (up to 30s) for the session to appear, caches your comments while it is live, and when the session disappears asks whether to send them to the agent (one watcher per repo; stopped when the plugin unloads). The first use may trigger the macOS Automation prompt (allow your terminal to control Ghostty; error `-1743` means it was denied).
  - *tmux* mode: hunk opens in a split pane; the live session stays available to the agent. Run `/hunk-send` when you are done commenting.
- `/hunk-send` — fetch your comments from the live session and send them to the current session.

## Tools (server, namespace `hunk`)

All except `hunk_sessions` accept optional `repo` (default: working directory) and `session` (exact session id).

| Tool | Description |
| --- | --- |
| `hunk_sessions` | List live sessions. |
| `hunk_review` | File/hunk structure (`includePatch`, `includeNotes`). |
| `hunk_context` | Current focus of the user. |
| `hunk_navigate` | `file` + one of `hunk`/`oldLine`/`newLine`, or `comment`, or `direction` next/prev. |
| `hunk_comment` | Batch of notes (`comments[]`: `filePath` + one of `hunk`/`oldLine`/`newLine`, or `replyTo`; plus `summary`, `rationale?`), `focus?`. |
| `hunk_comments` | List comments (`type`: live/all/ai/agent/user, `file?`). |
| `hunk_comment_remove` | Remove a comment by `id`. |
| `hunk_highlight` | `action` add/clear attention marks. |
| `hunk_reload` | Swap session contents, e.g. `args: ["diff", "--staged"]`. Extension/agent-context/`--files` flags are rejected. Uses the `hunk_reload` permission key. |

The tools tell the model never to launch the hunk TUI and to ask you to run `/hunk` when no session exists.

## Development

```sh
bun install
bun run typecheck
bun test
```

## Release

Bump `version` in `package.json`, commit, then tag and push:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

CI checks that the tag matches `package.json`, runs typecheck and tests, creates a GitHub release, and moves the `release` branch to the tagged commit.
