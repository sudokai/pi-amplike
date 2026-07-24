## Learned User Preferences

- Prefer herdr (not tmux) for subagent terminal panes; run pi inside a herdr pane
- Default subagent launches are autonomous (non-interactive): auto-exit when done and close the herdr pane
- Interactive subagents stay open until the user exits or uses `/done`; they must not auto-exit or call `subagent_done` on their own
- `/done` on an interactive subagent should end the pi session and close the herdr pane
- Subagent pane layout: first subagent splits vertically right of the orchestrator (50/50); later subagents split horizontally below the most recently launched subagent pane in the right column
- When simplifying subagent APIs, prefer clarity over backward compatibility
- Prefer vendoring pi-herdr-subagents with an amplike mode-expansion hook over depending on the upstream package separately
- Remove legacy subagent env flags and controls (e.g., `PI_SUBAGENT_CHILD`, `PI_TIDY_SUBAGENT_CHILD`, `subagent_control`) rather than keeping compatibility shims
- Use the commit skill (Conventional Commits, commit only, no push) when asked to commit

## Learned Workspace Facts

- pi-amplike vendors pi-herdr-subagents under `extensions/vendor/pi-herdr-subagents/`; do not also install `pi-herdr-subagents` as a separate package
- `extensions/subagent.ts` re-exports the vendored herdr subagent extension; list pi-amplike before pi-interactive-subagents in packages so its `subagent` tool wins the registry race
- Requires herdr ≥ 0.7.5 and pi run inside a herdr pane (`HERDR_ENV=1`) for subagents
- Agent personas are discovered from `~/.pi/agent/agents/*.md` and `.pi/agents/*.md`; package samples under `extensions/agents/*.md` are templates—install via `/subagents-init`
- Per-spawn amplike mode expansion precedence: parent session → `mode` → explicit `model` → explicit `thinking`
- Subagent child sessions use `lineage-only` mode by default (child of parent session); `fork` forces full-context fork
- Subagents run without permission prompts (existing amplike fail-closed behavior for children)
- Autonomous subagent completions (`subagent_done` / caller ping) auto-close the herdr pane; interactive subagents keep the pane open until user exit or `/done`
