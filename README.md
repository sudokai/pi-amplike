# pi-amplike

[Pi](https://github.com/badlogic/pi-mono) skills and extensions that give Pi similar capabilities to [Amp Code](https://ampcode.com/) out of the box.

<p align="center">
<img src="demo.gif" alt="Pi amplike handoff and modes demo" width="700" />
</p>

## Features

### Session Management
- **Handoff** - Create a new focused session with AI-generated context transfer:
  - **`/handoff <goal>`** command - Manually create a handoff session (potentially with `-mode <name>` / `-model <provider/id>` / `-thinking <level>` to configure the new session)
  - **`handoff` tool** - The agent can invoke this (with optional `mode`/`model`/`thinkingLevel` parameters) when you explicitly request a handoff
- **`session_query` tool** - The agent in handed-off sessions automatically gets the ability to query the parent session for context, decisions, or code changes; analysis uses the queried session's own model
- Use `/resume` to switch between and navigate handed-off sessions

### Subagents (tidy-style RPC children)
- **`subagent` tool** - Launch ordered foreground and/or background child Pi agents (`agents[]` with `label?`, `reason`, `prompt`, optional `mode` / `model` / `thinking` / `execution`)
- **`subagent_control` tool** - Inspect, steer, cancel, set delivery, or collect session-scoped background children
- **`/subagents`** (and `Ctrl+Shift+B`) - TUI management overlay for active/completed children
- Per-child **amplike modes** (`modes.json`) expand to model/thinking with precedence: parent session → `mode` → explicit `model` → explicit `thinking`
- Children are isolated RPC processes: built-in tools only, Amp fail-closed bash (never prompts), nested subagents disabled
- Results use tidy envelopes and agent-dir artifacts (`child-*.md`, `run.json`, event jsonl) — not Pi session `.jsonl` paths for `session_query`

### Permissions
- **`/permissions`** command toggles bash command allow/deny permissions, directly read from AmpCode's configuration files.

### Prompt Modes
- **`/mode`** command with interactive mode selector/configuration UI (a mode is a model + thinking + color preset, active mode is shown in prompt editor border)
- **Shortcuts**:
  - **`Ctrl+Shift+S`** - mode selector
  - **`Ctrl+Space`** - cycle modes

### Amp Skill Compatibility
- Auto-loads Amp skill directories when present:
  - `~/.config/agents/skills`
  - `~/.config/amp/skills`
  - `.agents/skills` (project-local)

## Installation

### Option A: Install from npm (recommended)

```bash
pi install npm:pi-amplike
```

### Option B: Install from git

```bash
pi install https://github.com/pasky/pi-amplike
```

### Option C: Local development

```bash
git clone https://github.com/pasky/pi-amplike ~/.pi/packages/pi-amplike
cd ~/.pi/packages/pi-amplike
npm install
```

Then add `"packages/pi-amplike"` to the `"packages"` array in `~/.pi/agent/settings.json`.

**Do not also install `@mobrienv/pi-tidy-subagents`** — pi-amplike vendors that runtime and registers the same `subagent` / `subagent_control` tools.

**Node:** `>=22.19.0` (matches the vendored tidy runtime).

## Usage

### Session Handoff

When your conversation gets long or you want to branch off to a focused task, you can use handoff in two ways:

**Manual handoff via command:**
```
/handoff now implement this for teams as well
/handoff -mode rush execute phase one of the plan
/handoff -model anthropic/claude-haiku-4-5 check other places that need this fix
/handoff -thinking high now implement the performance work
```

Optional flags (can be combined):
- `-mode <name>` — start the new session in a named mode (e.g. `rush`, `smart`, `deep`); may set model and thinking from `modes.json`
- `-model <provider/id>` — start the new session with a specific model (e.g. `anthropic/claude-haiku-4-5`); overrides the mode's model only
- `-thinking <level>` — thinking level for the new session: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`; overrides the mode's thinking preset

**Precedence** (each step only overrides that dimension): start from the current session's model and thinking → `-mode` may set both from `modes.json` → `-model` overrides model only → `-thinking` overrides thinking only.

Without these flags, `/handoff` keeps the current model and thinking level in the new session.

The handoff summary is always generated with the *current* session's model before switching.

After generation, you review and edit the prompt in the editor. Accepting opens a new session and submits the approved message; cancelling leaves you in the current session.

**Agent-invoked handoff:**
The agent can also initiate a handoff when you explicitly ask for it:
```
"Please hand this off to a new session to implement the fix"
"Create a handoff session to execute phase one"
```

The `handoff` tool also accepts optional `mode`, `model`, and `thinkingLevel` parameters (agent should set these only when you explicitly ask). The tool path shows the same editor review before switching; cancelling does not switch sessions.

Both methods create a new session with:
- AI-generated summary of relevant context from the current conversation
- List of relevant files that were discussed or modified
- Clear task description based on your goal
- Reference to parent session (accessible via `session_query` tool)

#### Session Navigation

Use Pi's built-in `/resume` command to switch between sessions, including handed-off sessions. The handoff creates sessions with descriptive names that make them easy to find.

#### Querying Past Sessions

The `session_query` tool lets the model look up information from previous sessions. It's automatically used when a handoff includes parent session reference, but can also be invoked directly. The analysis call uses the queried session's own model (falling back to the current model if unavailable):

```
session_query("/path/to/session.jsonl", "What files were modified?")
session_query("/path/to/session.jsonl", "What approach was chosen?")
```

### Subagents

Ask your agent to "use subagents to …" for independent, well-defined work that benefits from isolation or parallelism.

The `subagent` tool takes an ordered `agents[]` list (no `tasks[]` shim):

| Field | Required | Description |
|-------|----------|-------------|
| `reason` | yes | Short present-tense intent for the transcript |
| `prompt` | yes | Full context and objective sent verbatim to the child |
| `label` | no | Display label (default `agent`) |
| `mode` | no | Amplike mode name from `modes.json` (only when the user asks) |
| `model` | no | Exact `provider/model-id` (omit inherits parent / mode) |
| `thinking` | no | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `execution` | no | `foreground` (default, waits) or `background` (ack + control plane) |

**Mode / model / thinking precedence** (same as handoff): parent session → `mode` → explicit `model` → explicit `thinking`. Unknown `mode` fails the whole batch (no partial children). Invalid or unauthenticated explicit models also fail preflight.

**Foreground** children block the tool call until they settle; **background** children register and return durable acknowledgements. Use `subagent_control` (`status` / `steer` / `cancel` / `inspect` / `set_delivery` / `collect` / `background`) or `/subagents` to manage them.

#### Child isolation and bash policy

Each child is spawned roughly as:

```text
pi --mode rpc --no-session --no-extensions --approve \
   -e <package>/extensions/lib/subagent-bash-gate.ts \
   --tools read,write,edit,bash,grep,find,ls \
   --model … --thinking …
```

- No package extension discovery (`--no-extensions`); only the Amp bash gate is loaded via `-e`
- Built-in tools only (no nested `subagent` in children; `PI_TIDY_SUBAGENT_CHILD=1`)
- Always `--approve` (no interactive approval UI in children)
- **Bash fail-closed** (never prompts in children):
  - Parent YOLO (`/permissions` → yolo, persisted in `~/.pi/agent/amplike.json`) → allow all bash
  - Amp `allow` → run
  - Amp `ask` / `deny` / `reject` → block with a clear error
- Parent interactive `/permissions` still prompts on `ask` in the main session

Artifacts for a run live under the Pi agent dir (tidy store): `run.json`, `child-*.md`, event jsonl. Use those (and tool envelopes) instead of `session_query` for subagent transcripts.

### Permissions

The permissions extension enforces Amp-style bash command permissions automatically. Use the `/permissions` command to toggle modes:

```
/permissions    # toggles between enabled and yolo
```

- **enabled** (default): Amp permission rules from `~/.config/amp/settings.json` are enforced
- **yolo**: All bash commands are allowed without any checks; `YOLO mode` shown in status bar

The selected mode is persisted in `~/.pi/agent/amplike.json` and restored on the next pi invocation.

### Prompt Modes

```text
/mode              # mode picker
/mode configure    # open mode configuration UI
/mode <name>       # switch directly
/mode store <name> # store current model+thinking into a mode
```

Notes:
- The extension bootstraps with default modes are `rush`, `smart`, and `deep`; they somewhat mirror Amp defaults.
- Modes config is loaded from `.pi/modes.json` (project), falling back to `~/.pi/agent/modes.json` (global).
- Deleting all modes or setting `"modes": {}` in your modes file disables mode overlay behavior (shortcuts + editor mode border), while keeping `/mode` config UI available.

## Components

| Component | Type | Description |
|-----------|------|-------------|
| [amp-skills](extensions/amp-skills.ts) | Extension | Adds Amp-compatible skill discovery paths (`~/.config/agents/skills`, `~/.config/amp/skills`, `.agents/skills`) |
| [permissions](extensions/permissions.ts) | Extension | Reads `amp.commands.allowlist` and `amp.permissions` from `~/.config/amp/settings.json` (and `.agents/settings.json`) and intercepts bash tool calls accordingly; `/permissions` toggles between `enabled` and `yolo` (all commands allowed, status bar indicator, persisted in `~/.pi/agent/amplike.json`) |
| [handoff](extensions/handoff.ts) | Extension | `/handoff [-mode <name>] [-model <provider/id>] [-thinking <level>] <goal>` command + `handoff` tool (with `mode`/`model`/`thinkingLevel` params) for AI-powered context transfer |
| [modes](extensions/modes.ts) | Extension | Prompt mode manager with model/thinking/color presets, editor border overlay, and shortcuts |
| [subagent](extensions/subagent.ts) | Extension | Tidy-style `subagent` + `subagent_control` with per-child amplike `mode`; vendored runtime under `extensions/vendor/pi-tidy-subagents/` |
| [session-query](extensions/session-query.ts) | Extension | `session_query` tool for querying parent sessions; uses the queried session's own model for analysis |
| [session-query](skills/session-query/) | Skill | Instructions for using the session_query tool |

## Breaking changes (2.0.0)

- In-process `tasks[]` subagent runner and **`/btw`** are removed
- Tool schema is tidy-style **`agents[]`** (`reason`, `prompt`, optional `mode`/`model`/`thinking`/`execution`) plus **`subagent_control`**
- Subagents no longer produce Pi `.jsonl` session files for `session_query`
- Node engine requirement is **`>=22.19.0`**

## Why "AmpCode-like"?

Amp Code has excellent session management built-in - you can branch conversations, reference parent context, and navigate session history. This package brings similar workflows to Pi:

- **Context handoff** → Amp's conversation branching
- **Session querying** → Amp's ability to reference parent context

## License

MIT

Vendored [pi-tidy-subagents](https://github.com/mikeyobrien/pi-tidy-tools/tree/main/packages/pi-tidy-subagents) is MIT (see `extensions/vendor/pi-tidy-subagents/THIRD_PARTY.md`).
