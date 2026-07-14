/**
 * Pure unit tests for vendor concurrencyCap (CPU-only heuristic).
 *
 * Run: node test/concurrency-cap.test.mjs
 */

import { availableParallelism } from "node:os";
import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { concurrencyCap } = await jiti.import("../extensions/vendor/pi-tidy-subagents/scheduler.ts");

let failures = 0;
const eq = (name, got, want) => {
	const ok = got === want;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!ok) failures++;
};

// Pure inputs — no freemem / host free-RAM dependency
eq("concurrencyCap(10) === 5", concurrencyCap(10), 5);
eq("concurrencyCap(1) === 1", concurrencyCap(1), 1);
eq("concurrencyCap(2) === 1", concurrencyCap(2), 1);
eq("concurrencyCap(3) === 1", concurrencyCap(3), 1);
eq("concurrencyCap(0) === 1", concurrencyCap(0), 1);
eq("concurrencyCap(4) === 2", concurrencyCap(4), 2);
eq("concurrencyCap(9) === 4", concurrencyCap(9), 4);

// Default args match max(1, floor(availableParallelism() / 2))
{
	const cpus = availableParallelism();
	const want = Math.max(1, Math.floor(cpus / 2));
	eq(`default concurrencyCap() with availableParallelism=${cpus}`, concurrencyCap(), want);
}

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall concurrency-cap tests passed");
