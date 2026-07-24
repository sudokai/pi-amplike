# Third-party: pi-herdr-subagents

Vendored snapshot of [pi-herdr-subagents](https://github.com/modem-dev/pi-herdr-subagents).

- **Source**: https://github.com/modem-dev/pi-herdr-subagents
- **Commit**: `c833a55a4fbb9dbef8d04b0bc9312895c5d8c85b`
- **License**: MIT (see upstream repository)

## Amplike modifications

- `@mariozechner/*` → `@earendil-works/*`, `@sinclair/typebox` → `typebox`
- Extension entry is `extensions/subagent.ts` (upstream `package.json` pi manifest removed)
- `subagent` tool: `mode` and `thinking` params; expansion via `extensions/lib/subagent-mode.ts`
- `src/launch.ts`: `thinking` tool param overrides agent default

Do not install `pi-herdr-subagents` separately — pi-amplike registers the same tools.
