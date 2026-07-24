/**
 * Auto-close herdr pane when a subagent shuts down intentionally.
 *
 * Run: node test/subagent-pane-close.test.mjs
 */

import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { __test__ } = await jiti.import("../extensions/vendor/pi-herdr-subagents/index.ts");
const { shouldAutoCloseSubagentPane } = __test__;

let failures = 0;
const ok = (name, cond, detail = "") => {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
};

ok("completed → close pane", shouldAutoCloseSubagentPane({ kind: "completed", summary: "done", exitCode: 0 }));
ok("ping → close pane", shouldAutoCloseSubagentPane({ kind: "ping", name: "worker", message: "help" }));
ok(
	"completed-user-exit → keep pane",
	!shouldAutoCloseSubagentPane({ kind: "completed-user-exit", summary: "bye", exitCode: 0 }),
);
ok("crashed → keep pane", !shouldAutoCloseSubagentPane({ kind: "crashed", exitCode: 1, summary: null }));
ok(
	"launch-failed → keep pane",
	!shouldAutoCloseSubagentPane({ kind: "launch-failed", exitCode: 1, heldOpen: true }),
);
ok("cancelled → keep pane", !shouldAutoCloseSubagentPane({ kind: "cancelled" }));

process.exit(failures === 0 ? 0 : 1);
