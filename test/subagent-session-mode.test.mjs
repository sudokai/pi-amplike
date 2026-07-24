/**
 * Subagent session mode resolution — lineage-only default, fork on demand.
 *
 * Run: node test/subagent-session-mode.test.mjs
 */

import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const {
	resolveEffectiveSessionMode,
	resolveLaunchBehavior,
	parseAgentDefinition,
} = await jiti.import("../extensions/vendor/pi-herdr-subagents/src/agents.ts");

let failures = 0;
const ok = (name, cond, detail = "") => {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
};

ok("default → lineage-only", resolveEffectiveSessionMode({ name: "x", task: "y" }, null) === "lineage-only");
ok(
	"fork param wins",
	resolveEffectiveSessionMode({ name: "x", task: "y", fork: true }, null) === "fork",
);
ok(
	"agent session-mode respected",
	resolveEffectiveSessionMode({ name: "x", task: "y" }, { sessionMode: "fork" }) === "fork",
);

const lineageBehavior = resolveLaunchBehavior({ name: "x", task: "y" }, null);
ok("lineage-only seeds session", lineageBehavior.seededSessionMode === "lineage-only");
ok("lineage-only uses artifact delivery", lineageBehavior.taskDelivery === "artifact");
ok("lineage-only does not inherit context", !lineageBehavior.inheritsConversationContext);

const forkBehavior = resolveLaunchBehavior({ name: "x", task: "y", fork: true }, null);
ok("fork seeds session", forkBehavior.seededSessionMode === "fork");
ok("fork uses direct delivery", forkBehavior.taskDelivery === "direct");
ok("fork inherits context", forkBehavior.inheritsConversationContext);

const legacy = parseAgentDefinition(
	"---\nname: legacy\nsession-mode: standalone\n---\nbody",
	"legacy",
);
ok("legacy standalone frontmatter → lineage-only", legacy?.sessionMode === "lineage-only");

process.exit(failures === 0 ? 0 : 1);
