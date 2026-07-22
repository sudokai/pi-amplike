/**
 * Finished session children remain listed/inspectable in status and /subagents.
 *
 * Run: node test/subagent-status-list.test.mjs
 */

import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { SessionCoordinator } = await jiti.import(
	"../extensions/vendor/pi-tidy-subagents/coordinator.ts",
);
const { managementActions, managementItems } = await jiti.import(
	"../extensions/vendor/pi-tidy-subagents/ui.ts",
);

let failures = 0;
const eq = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
	if (!ok) {
		console.log(`  got:  ${JSON.stringify(got)}`);
		console.log(`  want: ${JSON.stringify(want)}`);
		failures++;
	}
};

const baseTime = 1_800_000_000_000;
const runDir = "/tmp/pi-amplike-status-list-run";

const child = (overrides = {}) => ({
	index: 0,
	id: "child-001",
	label: "agent",
	reason: "test",
	prompt: "go",
	status: "completed",
	model: "model",
	thinking: "low",
	startedAt: baseTime - 20_000,
	endedAt: baseTime - 5_000,
	toolCount: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	providerTraffic: 0,
	tokens: 0,
	activities: [],
	activeTools: [],
	eventCount: 0,
	response: "done",
	artifactPath: "/tmp/child.md",
	target: "run:child-001",
	ownership: "foreground",
	...overrides,
});

const put = (coordinator, entry) => {
	const state = child(entry);
	coordinator.records.set(state.target, {
		child: state,
		widgetSnapshot: state,
		settledCommitted: !["queued", "starting", "running"].includes(state.status),
		details: { runDir },
	});
	return state;
};

{
	const coordinator = new SessionCoordinator({}, {});
	const finishedFg = put(coordinator, {
		id: "child-fg",
		target: "run:child-fg",
		label: "fg-done",
		ownership: "foreground",
		status: "completed",
		endedAt: baseTime - 3_000,
		collectionCount: 0,
		artifactPath: `${runDir}/child-fg.md`,
		response: "full finished FG body that must not be inlined by inspect",
	});
	const collectedBg = put(coordinator, {
		id: "child-bg-done",
		target: "run:child-bg-done",
		label: "bg-done",
		ownership: "background",
		status: "completed",
		deliveryPolicy: "auto",
		endedAt: baseTime - 2_000,
		collectionCount: 1,
		followUpAcceptedAt: baseTime - 1_500,
		artifactPath: `${runDir}/child-bg-done.md`,
	});
	const uncollectedBg = put(coordinator, {
		id: "child-bg-open",
		target: "run:child-bg-open",
		label: "bg-open",
		ownership: "background",
		status: "completed",
		deliveryPolicy: "manual",
		endedAt: baseTime - 1_000,
		collectionCount: 0,
		artifactPath: `${runDir}/child-bg-open.md`,
	});
	const failedFg = put(coordinator, {
		id: "child-fg-failed",
		target: "run:child-fg-failed",
		label: "fg-failed",
		ownership: "foreground",
		status: "failed",
		error: "boom",
		endedAt: baseTime - 4_000,
		collectionCount: 0,
		artifactPath: `${runDir}/child-fg-failed.md`,
	});
	const cancelledBg = put(coordinator, {
		id: "child-bg-cancelled",
		target: "run:child-bg-cancelled",
		label: "bg-cancelled",
		ownership: "background",
		status: "cancelled",
		deliveryPolicy: "manual",
		endedAt: baseTime - 500,
		collectionCount: 0,
		artifactPath: `${runDir}/child-bg-cancelled.md`,
	});
	put(coordinator, {
		id: "child-active",
		target: "run:child-active",
		label: "bg-active",
		ownership: "background",
		status: "running",
		deliveryPolicy: "auto",
		endedAt: undefined,
	});
	put(coordinator, {
		id: "child-fg-active",
		target: "run:child-fg-active",
		label: "fg-active",
		ownership: "foreground",
		status: "running",
		endedAt: undefined,
	});

	const status = await coordinator.control("status");
	const details = status.details;
	const text = status.content[0].text;

	eq(
		"status terminal includes finished FG + collected BG + uncollected BG + failed/cancelled",
		details.terminal.map((c) => c.target),
		[
			cancelledBg.target,
			uncollectedBg.target,
			collectedBg.target,
			finishedFg.target,
			failedFg.target,
		],
	);
	eq(
		"status terminalUncollected is only uncollected background",
		details.terminalUncollected.map((c) => c.target),
		[cancelledBg.target, uncollectedBg.target],
	);
	eq(
		"status keeps active foreground/background separate from terminal",
		{
			activeForeground: details.activeForeground.map((c) => c.target),
			activeBackground: details.activeBackground.map((c) => c.target),
		},
		{
			activeForeground: ["run:child-fg-active"],
			activeBackground: ["run:child-active"],
		},
	);
	eq(
		"status text uses Terminal group (not Terminal uncollected only)",
		text.includes("Terminal: 5") && !text.includes("Terminal uncollected"),
		true,
	);
	eq(
		"status text marks ownership on terminal FG rows",
		/- fg-done run:child-fg completed ownership=foreground age=/.test(text),
		true,
	);
	eq(
		"status text marks ownership+delivery on terminal BG rows",
		/- bg-open run:child-bg-open completed ownership=background delivery=manual age=/.test(text),
		true,
	);
	eq(
		"status text marks collected terminal rows after artifact",
		/- bg-done run:child-bg-done completed ownership=background delivery=auto age=\S+ artifact=\S+ · collected/.test(text),
		true,
	);
	eq(
		"status text includes non-completed terminal statuses",
		/- fg-failed run:child-fg-failed failed ownership=foreground age=/.test(text)
			&& /- bg-cancelled run:child-bg-cancelled cancelled ownership=background delivery=manual age=/.test(text),
		true,
	);

	const items = managementItems(details);
	eq(
		"management items list Terminal for all finished children",
		items.filter((item) => item.group === "Terminal").map((item) => item.child.target),
		[
			cancelledBg.target,
			uncollectedBg.target,
			collectedBg.target,
			finishedFg.target,
			failedFg.target,
		],
	);
	eq(
		"management items keep active groups",
		items.map((item) => item.group),
		[
			"Active foreground",
			"Active background",
			"Terminal",
			"Terminal",
			"Terminal",
			"Terminal",
			"Terminal",
		],
	);

	const fgTerminal = items.find((item) => item.child.target === finishedFg.target);
	const fgFailed = items.find((item) => item.child.target === failedFg.target);
	const bgUncollected = items.find((item) => item.child.target === uncollectedBg.target);
	const bgCollected = items.find((item) => item.child.target === collectedBg.target);
	const bgCancelled = items.find((item) => item.child.target === cancelledBg.target);

	eq("FG terminal actions are inspect-only", managementActions(fgTerminal), ["inspect"]);
	eq("failed FG terminal actions are inspect-only", managementActions(fgFailed), ["inspect"]);
	eq(
		"BG uncollected terminal keeps set_delivery + collect",
		managementActions(bgUncollected),
		["inspect", "set_delivery", "collect"],
	);
	eq(
		"BG collected terminal (follow-up accepted) keeps inspect + collect",
		managementActions(bgCollected),
		["inspect", "collect"],
	);
	eq(
		"cancelled BG terminal keeps set_delivery + collect",
		managementActions(bgCancelled),
		["inspect", "set_delivery", "collect"],
	);

	const inspect = await coordinator.control("inspect", finishedFg.target);
	eq(
		"inspect resolves finished FG in-memory",
		Boolean(inspect.details.child?.target === finishedFg.target),
		true,
	);
	eq(
		"inspect stays path-oriented with artifact/transcript paths",
		{
			artifactPath: inspect.details.artifactPath,
			transcriptPath: inspect.details.transcriptPath,
		},
		{
			artifactPath: `${runDir}/child-fg.md`,
			transcriptPath: `${runDir}/child-fg.transcript.md`,
		},
	);
	eq(
		"inspect does not inline finished FG body",
		inspect.details.child?.response === ""
			&& !inspect.content[0].text.includes("full finished FG body"),
		true,
	);
	eq(
		"inspect text summarizes paths instead of body",
		inspect.content[0].text.includes(`artifact ${runDir}/child-fg.md`)
			&& inspect.content[0].text.includes(`transcript ${runDir}/child-fg.transcript.md`),
		true,
	);
}

{
	// Pure managementActions edge: accepted follow-up still allows collect; FG terminal never set_delivery.
	eq(
		"Terminal FG with background-like delivery fields still inspect-only",
		managementActions({
			group: "Terminal",
			child: child({
				ownership: "foreground",
				followUpAcceptedAt: undefined,
				deliveryPolicy: "manual",
			}),
		}),
		["inspect"],
	);
	eq(
		"Terminal BG without followUpAcceptedAt allows set_delivery",
		managementActions({
			group: "Terminal",
			child: child({
				ownership: "background",
				followUpAcceptedAt: undefined,
				collectionCount: 2,
			}),
		}),
		["inspect", "set_delivery", "collect"],
	);
	eq(
		"unexpected management group falls back to inspect-only",
		managementActions({
			group: "Unknown",
			child: child({ ownership: "background", followUpAcceptedAt: undefined }),
		}),
		["inspect"],
	);
	eq(
		"managementItems consumes terminal (not only terminalUncollected)",
		managementItems({
			activeForeground: [],
			activeBackground: [],
			terminal: [child({ target: "run:a", ownership: "foreground" })],
		}).map((item) => item.group),
		["Terminal"],
	);
}

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nAll subagent status list tests passed.");
