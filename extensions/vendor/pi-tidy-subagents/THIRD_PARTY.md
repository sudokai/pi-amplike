# Third-party: pi-tidy-subagents

This directory vendors a snapshot of [pi-tidy-subagents](https://github.com/mikeyobrien/pi-tidy-tools/tree/main/packages/pi-tidy-subagents)
from [mikeyobrien/pi-tidy-tools](https://github.com/mikeyobrien/pi-tidy-tools).

- **Upstream package**: `@mobrienv/pi-tidy-subagents`
- **Source**: https://github.com/mikeyobrien/pi-tidy-tools/tree/main/packages/pi-tidy-subagents
- **Commit**: `1dc98d42e63bf9880cbb4bed7934a3a82273aa7e`
- **License**: MIT (see `LICENSE` in this directory; Copyright (c) 2026 Mikey O'Brien)

## Local modifications

- `runner.ts` `buildChildArgs`: always isolate children with `--no-extensions`, absolute `-e` Amp bash-gate path, fixed built-in `--tools`, and `--approve`.
- `index.ts`: routing command and routing prompt guidance removed for amplike (modes replace routing). Default export retained as a library entry only — not auto-loaded by Pi (nested under `extensions/vendor/`).

Do **not** also install `@mobrienv/pi-tidy-subagents` alongside pi-amplike (duplicate `subagent` tool).
