# Third-party: pi-tidy-subagents

This directory vendors a snapshot of [pi-tidy-subagents](https://github.com/mikeyobrien/pi-tidy-tools/tree/main/packages/pi-tidy-subagents)
from [mikeyobrien/pi-tidy-tools](https://github.com/mikeyobrien/pi-tidy-tools).

- **Upstream package**: `@mobrienv/pi-tidy-subagents`
- **Source**: https://github.com/mikeyobrien/pi-tidy-tools/tree/main/packages/pi-tidy-subagents
- **Commit**: `1dc98d42e63bf9880cbb4bed7934a3a82273aa7e`
- **License**: MIT (see `LICENSE` in this directory; Copyright (c) 2026 Mikey O'Brien)

## Local modifications

- `runner.ts` `buildChildArgs`: `--mode rpc --no-session --approve` plus model/thinking; `buildChildEnv` sets `PI_TIDY_SUBAGENT_CHILD=1`.
- `index.ts`: library entry only (not auto-loaded under `extensions/vendor/`); re-exports `isChildRpcProcess` from amplike `permissions-core`. Parent registration is `extensions/subagent.ts`.
- `scheduler.ts` `concurrencyCap`: CPU-only `max(1, floor(availableParallelism() / 2))`. Dropped `os.freemem()` — on macOS free memory is often near-zero while most RAM is reclaimable cache, which forced `cap = 1` on large multi-core hosts.
- `runner.ts` `finalizeChildTerminalStatus`: on child exit, set status from settlement, process errors, and assistant `stopReason` / `errorMessage` (`error` and `aborted` → `failed`; `length` → `warning`).
- `envelope.ts` `envelopeChildContent`: for `failed` / `cancelled` / `warning`, put harness `error` before partial `response`; used for parent tool CDATA, on-disk artifacts (`store.saveRun`), and TUI terminal stamps.
- `coordinator.ts` `status` / `ui.ts` management: list **all** terminal children for the parent session (foreground + background, collected or not) under one `Terminal` group; keep `terminalUncollected` as a filtered subset. FG terminal overlay actions are inspect-only; BG terminal keeps delivery/collect eligibility.
- `coordinator.ts` `inspect`: strip ANSI and collapse whitespace in the activity summary before embedding it in plain tool/control text (TUI cards keep colored activity lines).
- `ui.ts` / `render.ts`: collapsed background widget and multi-child tool cards keep line budgets; **expanded (ctrl+o) does not truncate** so every child remains visible.

Do **not** also install `@mobrienv/pi-tidy-subagents` alongside pi-amplike (duplicate `subagent` tool).
