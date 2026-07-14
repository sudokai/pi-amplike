/**
 * Regression tests for stable, bounded subagent components and semantic widget refreshes.
 *
 * Run: node test/render-stability.test.mjs
 */

import { createJiti } from "@mariozechner/jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url);
const {
	MAX_FOREGROUND_BATCH_LINES,
	SnapshotComponent,
	ToolSnapshotComponent,
} = await jiti.import("../extensions/vendor/pi-tidy-subagents/render.ts");
const {
	MAX_BACKGROUND_WIDGET_LINES,
	BackgroundStampComponent,
	BackgroundWidgetComponent,
	ManagementOverlay,
	backgroundWidgetStateKey,
} = await jiti.import("../extensions/vendor/pi-tidy-subagents/ui.ts");
const { SessionCoordinator } = await jiti.import(
	"../extensions/vendor/pi-tidy-subagents/coordinator.ts",
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
const child = (status) => ({
	index: 0,
	id: "child-001",
	label: "agent",
	reason: "test rendering",
	prompt: "go",
	status,
	model: "model",
	thinking: "low",
	startedAt: baseTime - 10_000,
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
	response: status === "completed" ? "done" : "",
	artifactPath: "/tmp/child.md",
});
const details = (entry) => ({
	schemaVersion: 3,
	runId: "run",
	runDir: "/tmp/run",
	cwd: "/tmp",
	createdAt: new Date(baseTime).toISOString(),
	cap: 1,
	runtime: {
		provider: "provider",
		modelId: "model",
		model: "provider/model",
		thinking: "low",
		activeTools: [],
		projectTrusted: true,
	},
	children: [entry],
});

const originalDateNow = Date.now;
try {
	Date.now = () => baseTime;
	const runningChild = child("running");
	const running = new SnapshotComponent(details(runningChild), false);
	const completedChild = { ...child("completed"), endedAt: baseTime - 5_000 };
	const completed = new ToolSnapshotComponent(details(completedChild), false);
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const widget = new BackgroundWidgetComponent(() => [runningChild], theme);
	const handoffStamp = new BackgroundStampComponent(
		{ kind: "handoff", target: "run:child-001", timestamp: baseTime, child: runningChild },
		false,
		theme,
	);

	const runningInitial = running.render(120);
	const completedInitial = completed.render(120);
	const widgetInitial = widget.render(120);
	const handoffInitial = handoffStamp.render(120);

	Date.now = () => baseTime + 125_000;
	eq("running snapshot remains stable across later TUI renders", running.render(120), runningInitial);
	eq("completed tool snapshot remains stable across later TUI renders", completed.render(120), completedInitial);
	eq("background widget remains stable until its component is replaced", widget.render(120), widgetInitial);
	eq("historical handoff stamp remains stable across later TUI renders", handoffStamp.render(120), handoffInitial);

	const management = new ManagementOverlay(
		[{ group: "Terminal uncollected", child: completedChild }],
		theme,
		() => {},
	);
	const managementInitial = management.render(120);
	Date.now = () => baseTime + 245_000;
	eq("management overlay age remains stable per overlay", management.render(120), managementInitial);
} finally {
	Date.now = originalDateNow;
}

{
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const children = Array.from({ length: 6 }, (_, index) => ({
		...child("running"),
		index,
		id: `child-${index}`,
		label: `agent-${index}`,
		activities: Array.from({ length: 15 }, (__, activity) => `activity ${index}-${activity}`),
	}));
	const widgetLines = new BackgroundWidgetComponent(() => children, theme, () => true).render(120);
	eq("background widget obeys fixed line budget", widgetLines.length <= MAX_BACKGROUND_WIDGET_LINES, true);
	eq("background widget reports hidden lines", widgetLines.at(-1)?.includes("hidden"), true);
	const narrowWidgetLines = new BackgroundWidgetComponent(() => children, theme, () => true).render(12);
	eq("background widget truncation notice respects width", narrowWidgetLines.every((line) => visibleWidth(line) <= 12), true);

	const batchLines = new ToolSnapshotComponent({ ...details(children[0]), children }, true).render(120);
	eq("foreground batch obeys fixed line budget", batchLines.length <= MAX_FOREGROUND_BATCH_LINES, true);
	eq("foreground batch reports hidden lines", batchLines.at(-1)?.includes("hidden"), true);

	const changedOutsideCollapsedTail = children.map((entry, index) =>
		index === 0 ? { ...entry, activities: ["changed but hidden", ...entry.activities.slice(1)] } : entry,
	);
	eq(
		"collapsed widget key ignores activity outside visible tail",
		backgroundWidgetStateKey(changedOutsideCollapsedTail, false),
		backgroundWidgetStateKey(children, false),
	);
	eq(
		"expanded widget key includes activity inside expanded view",
		backgroundWidgetStateKey(changedOutsideCollapsedTail, true) === backgroundWidgetStateKey(children, true),
		false,
	);
	const changedBelowWidgetCap = children.map((entry, index) =>
		index === children.length - 1 ? { ...entry, activities: [...entry.activities.slice(0, -1), "hidden child change"] } : entry,
	);
	eq(
		"collapsed widget key ignores changes below line cap",
		backgroundWidgetStateKey(changedBelowWidgetCap, false, 20),
		backgroundWidgetStateKey(children, false, 20),
	);
	const layoutChildren = children.slice(0, 3);
	const changedByWideLayout = layoutChildren.map((entry, index) =>
		index === 1 ? { ...entry, activities: [...entry.activities.slice(0, -1), "wide-layout-visible change"] } : entry,
	);
	eq(
		"narrow widget key ignores activity below its line cap",
		backgroundWidgetStateKey(changedByWideLayout, false, 20),
		backgroundWidgetStateKey(layoutChildren, false, 20),
	);
	eq(
		"wide widget key includes activity exposed by combined layout",
		backgroundWidgetStateKey(changedByWideLayout, false, 120) === backgroundWidgetStateKey(layoutChildren, false, 120),
		false,
	);

	const widgetUpdates = [];
	const coordinator = new SessionCoordinator({}, {});
	coordinator.attachContext({
		mode: "tui",
		ui: {
			setWidget: (...args) => widgetUpdates.push(args),
			getToolsExpanded: () => false,
		},
	});
	const visibleChild = { ...children[0], ownership: "background" };
	const record = { child: visibleChild, widgetSnapshot: visibleChild, settledCommitted: false };
	coordinator.records.set("run:child-001", record);
	coordinator.refreshWidget();
	const updatesAfterInitialRender = widgetUpdates.length;
	record.widgetSnapshot = { ...visibleChild, prompt: "invisible prompt change" };
	coordinator.refreshWidget();
	eq("coordinator skips semantically invisible widget refresh", widgetUpdates.length, updatesAfterInitialRender);
	record.widgetSnapshot = { ...visibleChild, activities: [...visibleChild.activities.slice(0, -1), "visible tail change"] };
	coordinator.refreshWidget();
	eq("coordinator refreshes for visible collapsed change", widgetUpdates.length, updatesAfterInitialRender + 1);

	const layoutUpdates = [];
	const layoutCoordinator = new SessionCoordinator({}, {});
	layoutCoordinator.attachContext({
		mode: "tui",
		ui: {
			setWidget: (...args) => layoutUpdates.push(args),
			getToolsExpanded: () => false,
		},
	});
	const layoutRecords = layoutChildren.map((entry) => ({
		child: { ...entry, ownership: "background" },
		widgetSnapshot: { ...entry, ownership: "background" },
		settledCommitted: false,
	}));
	layoutRecords.forEach((entry, index) => layoutCoordinator.records.set(`run:child-${index}`, entry));
	layoutCoordinator.refreshWidget();
	const layoutFactory = layoutUpdates.at(-1)[1];
	layoutFactory(null, theme).render(120);
	const updatesAfterWideLayout = layoutUpdates.length;
	layoutRecords[2].widgetSnapshot = {
		...layoutRecords[2].widgetSnapshot,
		activities: [...layoutRecords[2].widgetSnapshot.activities.slice(0, -1), "still hidden at wide width"],
	};
	layoutCoordinator.refreshWidget();
	eq("coordinator skips changes hidden by actual wide layout", layoutUpdates.length, updatesAfterWideLayout);
	layoutRecords[1].widgetSnapshot = {
		...layoutRecords[1].widgetSnapshot,
		activities: [...layoutRecords[1].widgetSnapshot.activities.slice(0, -1), "visible at wide width"],
	};
	layoutCoordinator.refreshWidget();
	eq("coordinator refreshes activity visible in actual wide layout", layoutUpdates.length, updatesAfterWideLayout + 1);

	const resizeUpdates = [];
	const resizeCoordinator = new SessionCoordinator({}, {});
	resizeCoordinator.attachContext({
		mode: "tui",
		ui: {
			setWidget: (...args) => resizeUpdates.push(args),
			getToolsExpanded: () => false,
		},
	});
	const addResizeRecords = () => layoutChildren.map((entry, index) => {
		const resizeRecord = {
			child: { ...entry, ownership: "background" },
			widgetSnapshot: { ...entry, ownership: "background" },
			settledCommitted: false,
		};
		resizeCoordinator.records.set(`resize:child-${index}`, resizeRecord);
		return resizeRecord;
	});
	addResizeRecords();
	resizeCoordinator.refreshWidget();
	resizeUpdates.at(-1)[1](null, theme).render(20);
	resizeCoordinator.records.clear();
	resizeCoordinator.refreshWidget();
	const resizedRecords = addResizeRecords();
	resizeCoordinator.refreshWidget();
	const updatesBeforeFirstResizedRender = resizeUpdates.length;
	resizedRecords[1].widgetSnapshot = {
		...resizedRecords[1].widgetSnapshot,
		activities: [...resizedRecords[1].widgetSnapshot.activities.slice(0, -1), "visible after absent resize"],
	};
	resizeCoordinator.refreshWidget();
	eq(
		"coordinator uses conservative key after widget removal",
		resizeUpdates.length,
		updatesBeforeFirstResizedRender + 1,
	);
}

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nAll render stability tests passed.");
