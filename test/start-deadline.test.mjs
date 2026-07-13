/**
 * Unit tests for createStartDeadline (subagent never-start guard).
 *
 * Run: npm test   (or: node test/start-deadline.test.mjs)
 */

import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { createStartDeadline } = await jiti.import("../extensions/lib/subagent-core.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
	if (!cond) failures++;
};

// Start event before deadline → not timed out; timer cleaned.
{
	let timeoutCount = 0;
	const d = createStartDeadline({ ms: 80, onTimeout: () => timeoutCount++ });
	d.markStarted();
	await sleep(120);
	check("markStarted before deadline: not timed out", !d.isTimedOut());
	check("markStarted before deadline: onTimeout not called", timeoutCount === 0);
	d.dispose();
	await sleep(40);
	check("markStarted before deadline: still not timed out after dispose wait", !d.isTimedOut());
}

// No start by deadline → timed out; onTimeout called once.
{
	let timeoutCount = 0;
	const d = createStartDeadline({ ms: 50, onTimeout: () => timeoutCount++ });
	await sleep(90);
	check("no start: timed out", d.isTimedOut());
	check("no start: onTimeout once", timeoutCount === 1);
	d.dispose();
}

// markStarted after timeout does not clear timed out.
{
	const d = createStartDeadline({ ms: 40, onTimeout: () => {} });
	await sleep(70);
	check("late markStarted: already timed out", d.isTimedOut());
	d.markStarted();
	check("late markStarted: still timed out", d.isTimedOut());
	d.dispose();
}

// timedOutPromise resolves when deadline fires.
{
	const d = createStartDeadline({ ms: 45, onTimeout: () => {} });
	let raced = false;
	const p = d.timedOutPromise.then(() => {
		raced = true;
	});
	await sleep(90);
	await p;
	check("timedOutPromise resolves on timeout", raced);
	d.dispose();
}

// markStarted before timeout: timedOutPromise does not resolve within window.
{
	const d = createStartDeadline({ ms: 100, onTimeout: () => {} });
	d.markStarted();
	let raced = false;
	const p = d.timedOutPromise.then(() => {
		raced = true;
	});
	await sleep(130);
	check("timedOutPromise idle when started early", !raced);
	d.dispose();
}

// dispose() before fire: timer cleared, onTimeout not called.
{
	let timeoutCount = 0;
	const d = createStartDeadline({ ms: 80, onTimeout: () => timeoutCount++ });
	d.dispose();
	await sleep(120);
	check("dispose before fire: not timed out", !d.isTimedOut());
	check("dispose before fire: onTimeout not called", timeoutCount === 0);
}

// throwing onTimeout still resolves timedOutPromise.
{
	const d = createStartDeadline({
		ms: 45,
		onTimeout: () => {
			throw new Error("boom");
		},
	});
	let raced = false;
	const p = d.timedOutPromise.then(() => {
		raced = true;
	});
	await sleep(90);
	await p;
	check("throwing onTimeout: timed out", d.isTimedOut());
	check("throwing onTimeout: promise resolved", raced);
	d.dispose();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);