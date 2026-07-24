/**
 * Subagent pane split layout: first pane right of orchestrator, later panes
 * stacked down from the most recently launched subagent.
 *
 * Run: node test/subagent-pane-layout.test.mjs
 */

import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { __test__ } = await jiti.import("../extensions/vendor/pi-herdr-subagents/index.ts");
const { resolveSubagentPaneSplit, startSubagentPaneWithLayout, __paneLayoutTest__ } = __test__;

let failures = 0;
const ok = (name, cond, detail = "") => {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
};

__paneLayoutTest__.resetSubagentPaneLayoutState();

ok("no running subagents → split right", resolveSubagentPaneSplit([]).split === "right");
ok(
	"no running subagents → no splitFromPaneId",
	resolveSubagentPaneSplit([]).splitFromPaneId === undefined,
);

const first = {
	id: "a",
	name: "first",
	task: "t",
	paneId: "pane-1",
	startTime: 100,
	sessionFile: "/tmp/a.jsonl",
	launchScriptFile: "/tmp/a.sh",
	interactive: false,
};
const oneRunning = resolveSubagentPaneSplit([first]);
ok(
	"one running subagent → split down from that pane",
	oneRunning.split === "down" && oneRunning.splitFromPaneId === "pane-1",
);

const second = {
	...first,
	id: "b",
	name: "second",
	paneId: "pane-2",
	startTime: 200,
};
const twoRunning = resolveSubagentPaneSplit([first, second]);
ok(
	"two running subagents → split down from most recent pane",
	twoRunning.split === "down" && twoRunning.splitFromPaneId === "pane-2",
);

const pendingOnly = resolveSubagentPaneSplit([], "pane-pending");
ok(
	"latest pane id with no running subagents → split down",
	pendingOnly.split === "down" && pendingOnly.splitFromPaneId === "pane-pending",
);

const launchOrder = [];
await Promise.all([
	startSubagentPaneWithLayout({ cwd: "/tmp" }, [], async (payload) => {
		launchOrder.push(payload.split);
		await new Promise((r) => setTimeout(r, 20));
		return { paneId: "pane-a" };
	}),
	startSubagentPaneWithLayout({ cwd: "/tmp" }, [], async (payload) => {
		launchOrder.push(payload.split);
		return { paneId: "pane-b" };
	}),
]);
ok(
	"concurrent launches serialize layout: right then down",
	launchOrder[0] === "right" && launchOrder[1] === "down",
	JSON.stringify(launchOrder),
);

process.exit(failures === 0 ? 0 : 1);
