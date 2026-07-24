/**
 * Auto-close herdr pane when a subagent shuts down intentionally via
 * subagent_done or caller_ping, regardless of interactivity.
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

const completed = { kind: "completed", summary: "done", exitCode: 0 };
const ping = { kind: "ping", name: "worker", message: "help" };
const completedUserExit = { kind: "completed-user-exit", summary: "bye", exitCode: 0 };
const crashed = { kind: "crashed", exitCode: 1, summary: null };
const launchFailed = { kind: "launch-failed", exitCode: 1, heldOpen: true };
const cancelled = { kind: "cancelled" };

// Non-interactive subagents: intentional exits close the pane.
ok("non-interactive completed → close pane", shouldAutoCloseSubagentPane(completed, false));
ok("non-interactive ping → close pane", shouldAutoCloseSubagentPane(ping, false));

// Interactive subagents: close pane on intentional exits (subagent_done / caller_ping).
ok("interactive completed → close pane", shouldAutoCloseSubagentPane(completed, true));
ok("interactive ping → close pane", shouldAutoCloseSubagentPane(ping, true));

// Other outcomes never auto-close, regardless of interactivity.
ok("completed-user-exit → keep pane", !shouldAutoCloseSubagentPane(completedUserExit, false));
ok("crashed → keep pane", !shouldAutoCloseSubagentPane(crashed, false));
ok("launch-failed → keep pane", !shouldAutoCloseSubagentPane(launchFailed, false));
ok("cancelled → keep pane", !shouldAutoCloseSubagentPane(cancelled, false));

process.exit(failures === 0 ? 0 : 1);
