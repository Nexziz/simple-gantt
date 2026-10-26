import assert from "node:assert/strict";
import { toDay } from "../src/core/dates";
import { checkInSlots, dueCheckIn, slotStates } from "../src/core/journal";
import { computeNudges, nextDeadline, overallProgress, rippleShift } from "../src/core/nudges";
import { normalizeProject, toPlain } from "../src/core/serialize";
import { cloneProject } from "../src/core/types";
import { SAMPLE } from "./sample";

let failed = 0;
function t(name: string, fn: () => void) {
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failed++;
		console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
	}
}
const today = toDay("2026-10-26");

t("fortnightly check-in slots start at the project start", () => {
	const p = { ...cloneProject(SAMPLE), checkin: "fortnightly" as const, journal: [] };
	const slots = checkInSlots(p);
	assert.equal(slots[0], toDay("2026-09-01"));
	assert.equal(slots[1], toDay("2026-09-15"));
	assert.equal(slots.length, 27);
});

t("monthly slots follow calendar months", () => {
	const p = { ...cloneProject(SAMPLE), checkin: "monthly" as const };
	assert.deepEqual(checkInSlots(p).slice(0, 3), [toDay("2026-09-01"), toDay("2026-10-01"), toDay("2026-11-01")]);
});

t("a check-in is due until an entry is written in that period", () => {
	const p = { ...cloneProject(SAMPLE), checkin: "fortnightly" as const, journal: [] as any[] };
	assert.equal(dueCheckIn(p, today)?.day, toDay("2026-10-13"));
	p.journal.push({ id: "x", date: "2026-10-20", text: "Good progress" });
	assert.equal(dueCheckIn(p, today), null);
	assert.equal(slotStates(p, today).find((s) => s.day === toDay("2026-09-01"))?.state, "missed");
});

t("nudges: decision due comes first, then check-in, reached, upcoming", () => {
	const p = cloneProject(SAMPLE);
	p.items = p.items.filter((i) => i.id !== "a0");
	p.items.find((i) => i.id === "b1")!.planB = { by: "2026-10-20", title: "Use existing framework" };
	p.items.push({ id: "m", type: "milestone", title: "Topic approved", start: "2026-10-15" });
	p.items.push({ id: "d", type: "deadline", title: "Funding report", start: "2026-11-02" });
	const n = computeNudges(p, today);
	assert.deepEqual(n.map((x) => x.kind), ["decision", "checkin", "reached", "upcoming"]);
	p.items.find((i) => i.id === "m")!.done = true;
	assert.ok(!computeNudges(p, today).some((x) => x.kind === "reached"));
});

t("next deadline countdown", () => {
	const nd = nextDeadline(SAMPLE, today);
	assert.equal(nd?.item.id, "k1");
	assert.equal(nd?.days, toDay("2027-01-08") - today);
});

t("overall progress weights by duration", () => {
	const v = overallProgress(SAMPLE);
	assert.ok(v > 5 && v < 20, String(v));
});

t("ripple shift moves the item and everything after it, not earlier or done ones", () => {
	const p = cloneProject(SAMPLE);
	const pivot = p.items.find((i) => i.id === "b3")!; // Pilot study, 18 Jan
	const moved = rippleShift(p, pivot, 14);
	assert.equal(pivot.start, "2027-02-01");
	assert.equal(p.items.find((i) => i.id === "k2")!.start, "2027-09-10");
	assert.equal(p.items.find((i) => i.id === "a1")!.start, "2026-09-01");
	assert.ok(moved > 10);
});

t("plan B, reviews, journal survive a save/load round trip", () => {
	const p = cloneProject(SAMPLE);
	const it = p.items.find((i) => i.id === "b2")!;
	it.planB = { by: "2026-12-01", title: "Use secondary data", start: "2027-01-05", end: "2027-02-20", note: "Ask supervisor" };
	const m = p.items.find((i) => i.id === "a3")!;
	m.done = true;
	m.doneOn = "2027-01-20";
	m.review = { mood: 4, text: "Harder than expected" };
	p.items.find((i) => i.id === "a2")!.dropped = true;
	p.checkin = "weekly";
	p.journal = [{ id: "j1", date: "2026-10-20", mood: 5, text: "Great week" }];
	const back = normalizeProject(JSON.parse(JSON.stringify(toPlain(p))));
	assert.deepEqual(back.items.find((i) => i.id === "b2")!.planB, it.planB);
	assert.deepEqual(back.items.find((i) => i.id === "a3")!.review, m.review);
	assert.equal(back.items.find((i) => i.id === "a3")!.doneOn, "2027-01-20");
	assert.equal(back.items.find((i) => i.id === "a2")!.dropped, true);
	assert.equal(back.checkin, "weekly");
	assert.deepEqual(back.journal, p.journal);
});

console.log(failed ? `\n${failed} failed` : `\nall nudge/journal tests passed`);
if (failed) process.exit(1);
