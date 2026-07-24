/**
 * Subagent pane split layout: first pane right of orchestrator, later panes
 * stacked down from the most recently launched subagent.
 *
 * Run: node test/subagent-pane-layout.test.mjs
 */

import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { __test__ } = await jiti.import("../extensions/vendor/pi-herdr-subagents/index.ts");
const { resolveSubagentPaneSplit } = __test__;

let failures = 0;
const ok = (name, cond, detail = "") => {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
};

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

process.exit(failures === 0 ? 0 : 1);
