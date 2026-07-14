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

Do **not** also install `@mobrienv/pi-tidy-subagents` alongside pi-amplike (duplicate `subagent` tool).
