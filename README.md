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

### Subagents (herdr async panes)
- **`subagent` tool** — Spawn a sub-agent in a dedicated herdr pane (`name`, `task`, optional `agent` / `mode` / `model` / `thinking` / `cwd` / `fork` / …)
- **`subagent_resume`**, **`subagent_interrupt`**, **`subagents_list`** — Resume, interrupt, or list running subagents
- **`/subagent`**, **`/iterate`**, **`/subagents-init`** — Commands for spawn, forked iteration, and example agent setup
- Per-spawn **amplike modes** (`modes.json`) expand to model/thinking with precedence: parent session → `mode` → explicit `model` → explicit `thinking`
- Requires **herdr** ≥ 0.7.5 — run pi inside a herdr pane (`HERDR_ENV=1`)
- Children are interactive Pi sessions in separate panes; results are delivered to the parent automatically via steer messages

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

**Do not also install `pi-herdr-subagents`** — pi-amplike vendors that runtime and registers the same `subagent` tools.

**Herdr:** install [herdr](https://github.com/ogulcancelik/herdr) ≥ 0.7.5 and run pi inside a herdr pane for subagents.

**Node:** `>=22.19.0`.

## Usage

### Session Handoff

When your conversation gets long or you want to branch off to a focused task, you can use handoff in two ways:

**Manual handoff via command:**
```
/handoff now implement this for teams as well
/handoff -mode fast execute phase one of the plan
/handoff -model anthropic/claude-haiku-4-5 check other places that need this fix
/handoff -thinking high now implement the performance work
```

Optional flags (can be combined):
- `-mode <name>` — start the new session in a named mode from `modes.json`; may set model and thinking
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

Subagents require pi to run inside a [herdr](https://github.com/ogulcancelik/herdr) pane. Ask your agent to "use subagents to …" for independent work that benefits from isolation or parallelism.

The `subagent` tool is fire-and-forget: it returns immediately and the harness delivers the child's result as a steer message when finished.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Display name for the subagent pane |
| `task` | yes | Task/prompt for the sub-agent |
| `agent` | no | Agent definition from `~/.pi/agent/agents/<name>.md` or `.pi/agents/` |
| `mode` | no | Amplike mode name from `modes.json` (only when the user asks) |
| `model` | no | Exact `provider/model-id` (omit inherits parent / mode / agent) |
| `thinking` | no | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `cwd` | no | Working directory for the child |
| `fork` | no | Inherit parent session conversation |
| `interactive` | no | Long-running pane the user drives |

**Mode / model / thinking precedence** (same as handoff): parent session → `mode` → explicit `model` → explicit `thinking`. Unknown `mode` or invalid model fails before launch.

Use **`subagent_resume`** to continue a finished subagent, **`subagent_interrupt`** to stop one, and **`subagents_list`** to see running subagents. **`/subagents-init`** copies example agents (`worker`, `planner`, `scout`, `reviewer`) into your agent directory.

Child sessions use normal Pi `.jsonl` session files under the child's cwd. Inspect panes in herdr or read session artifacts under the orchestrator session directory.

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
- Modes are user-defined in `.pi/modes.json` (project) or `~/.pi/agent/modes.json` (global). Use `/mode configure` to add your first mode.
- Setting `"modes": {}` or having no modes disables the mode overlay (shortcuts + editor border), while keeping `/mode` config UI available.

## Components

| Component | Type | Description |
|-----------|------|-------------|
| [amp-skills](extensions/amp-skills.ts) | Extension | Adds Amp-compatible skill discovery paths (`~/.config/agents/skills`, `~/.config/amp/skills`, `.agents/skills`) |
| [permissions](extensions/permissions.ts) | Extension | Amp bash permissions (`amp.commands.allowlist` / `amp.permissions`); `/permissions` toggles `enabled` vs `yolo`; fail-closed (no prompt) in no-UI sessions |
| [handoff](extensions/handoff.ts) | Extension | `/handoff [-mode <name>] [-model <provider/id>] [-thinking <level>] <goal>` command + `handoff` tool (with `mode`/`model`/`thinkingLevel` params) for AI-powered context transfer |
| [modes](extensions/modes.ts) | Extension | Prompt mode manager with model/thinking/color presets, editor border overlay, and shortcuts |
| [subagent](extensions/subagent.ts) | Extension | Herdr async `subagent` tools with per-spawn amplike `mode`; vendored runtime under `extensions/vendor/pi-herdr-subagents/` |
| [session-query](extensions/session-query.ts) | Extension | `session_query` tool for querying parent sessions; uses the queried session's own model for analysis |
| [session-query](skills/session-query/) | Skill | Instructions for using the session_query tool |

## Breaking changes (3.0.0)

- **Subagents:** tidy-style RPC children (`agents[]`, `subagent_control`, `/subagents`, `Ctrl+Shift+B`) replaced by **herdr async panes** (`subagent`, `subagent_resume`, `subagent_interrupt`, `subagents_list`, `/subagent`, `/iterate`, `/subagents-init`)
- **Herdr required** for subagents — install herdr ≥ 0.7.5 and run pi inside a herdr pane
- Per-spawn **`mode` / `model` / `thinking`** on `subagent` preserved (amplike `modes.json` expansion)
- Child sessions are normal Pi `.jsonl` files in herdr panes (not tidy `child-*.md` / `run.json` artifacts)
- Removed `PI_TIDY_SUBAGENT_CHILD` fail-closed bash path — herdr children are interactive sessions with their own TUI

## Breaking changes (2.0.0)

- In-process `tasks[]` subagent runner and **`/btw`** are removed
- Tool schema was tidy-style **`agents[]`** plus **`subagent_control`** (superseded in 3.0.0 by herdr tools)
- Node engine requirement is **`>=22.19.0`**

## Why "AmpCode-like"?

Amp Code has excellent session management built-in - you can branch conversations, reference parent context, and navigate session history. This package brings similar workflows to Pi:

- **Context handoff** → Amp's conversation branching
- **Session querying** → Amp's ability to reference parent context

## License

MIT

Vendored [pi-herdr-subagents](https://github.com/modem-dev/pi-herdr-subagents) is MIT (see `extensions/vendor/pi-herdr-subagents/THIRD_PARTY.md`).
