/**
 * Unit tests for envelopeChildContent (tool CDATA, artifacts, TUI stamps).
 *
 * Run: node test/envelope-content.test.mjs
 */

import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const { envelopeChildContent } = await jiti.import(
	"../extensions/vendor/pi-tidy-subagents/envelope.ts",
);

let failures = 0;
const eq = (name, got, want) => {
	const ok = got === want;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
	if (!ok) failures++;
};

eq(
	"failed: error before partial response",
	envelopeChildContent({
		status: "failed",
		error: "terminated",
		response: "partial output",
	}),
	"terminated\n\n---\n\npartial output",
);

eq(
	"completed: response only",
	envelopeChildContent({
		status: "completed",
		response: "done",
	}),
	"done",
);

eq(
	"failed: error only",
	envelopeChildContent({
		status: "failed",
		error: "terminated",
		response: "",
	}),
	"terminated",
);

eq(
	"warning: error before response",
	envelopeChildContent({
		status: "warning",
		error: "length limit",
		response: "truncated",
	}),
	"length limit\n\n---\n\ntruncated",
);

eq(
	"cancelled: error before response",
	envelopeChildContent({
		status: "cancelled",
		error: "Cancelled",
		response: "partial",
	}),
	"Cancelled\n\n---\n\npartial",
);

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nAll envelope content tests passed.");