import assert from "node:assert/strict";
import { computeLayout, repeatsPhase } from "../src/core/layout";
import { normalizeProject } from "../src/core/serialize";

assert.equal(repeatsPhase("Firmware extraction and component identification", "Firmware extraction"), true);
assert.equal(repeatsPhase("VEX statements and comparison against prior scan", "VEX and comparison"), true);
assert.equal(repeatsPhase("Continuous write up", "Write up"), true);
assert.equal(repeatsPhase("Selection and acquisition of ECU", "Data collection: ECU"), false);

const project = normalizeProject({
	title: "T", start: "2026-11-01", end: "2027-04-30",
	phases: [{ id: "fw", name: "Firmware extraction" }, { id: "ecu", name: "Data collection: ECU" }],
	items: [
		{ id: "a", title: "Firmware extraction and component identification", type: "task", phase: "fw", start: "2026-12-01", end: "2027-01-18" },
		{ id: "b", title: "Christmas break buffer", type: "task", phase: "fw", start: "2026-12-21", end: "2026-12-23", buffer: true },
		{ id: "c", title: "Selection and acquisition of ECU", type: "task", phase: "ecu", start: "2026-11-10", end: "2026-12-04",
			planB: { by: "2026-11-27", title: "Use public image", start: "2026-11-30", end: "2026-12-11" } },
		{ id: "d", title: "ECU in hand", type: "milestone", phase: "ecu", start: "2026-12-04" },
	],
});
const measure = (t: string) => t.length * 7;
const plain = computeLayout(project, { pxPerDay: 6, showEmptyLanes: false, measure, datedLabels: true });
const clean = computeLayout(project, { pxPerDay: 6, showEmptyLanes: false, measure, datedLabels: true, clean: true });
const by = (l: typeof clean, id: string) => l.placed.find((p) => p.item.id === id)!;

// Normal mode is unchanged: full titles, Plan B and decision text, badge padding on milestones.
assert.equal(by(plain, "a").label, "Firmware extraction and component identification");
assert.ok(plain.placed.some((p) => p.kind === "ghost" && p.label.startsWith("Plan B")));
assert.ok(plain.placed.some((p) => p.kind === "decision" && p.label.startsWith("Decide")));

// Paper mode says each thing once.
assert.equal(by(clean, "a").label, "1 Dec to 18 Jan");
assert.equal(by(clean, "c").label, "Selection and acquisition of ECU");
assert.equal(by(clean, "b").label, "", "a buffer too small for its name drops the label");
assert.ok(clean.placed.filter((p) => p.kind === "ghost" || p.kind === "decision").every((p) => p.label === ""));
assert.equal(by(clean, "d").label, "ECU in hand · 4 Dec");
assert.equal(by(clean, "d").labelW, by(plain, "d").labelW - 18, "no badge padding on paper");
console.log("clean layout tests passed");
