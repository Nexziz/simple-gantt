import assert from "node:assert/strict";
import { toDay } from "../src/core/dates";
import { checkInSlots, dueCheckIn, slotStates } from "../src/core/journal";
import { computeNudges, nextDeadline, overallProgress, rippleShift } from "../src/core/nudges";
import { normalizeProject, toPlain } from "../src/core/serialize";
import { addLink, computeSlack, enforceLinks, linkConflicts } from "../src/core/links";
import { baselineSummary, driftOf, saveBaseline } from "../src/core/baseline";
import { toCsv, toMarkdownTable } from "../src/core/table";
import { agenda } from "../src/core/agenda";
import { applyImport, parseImport } from "../src/core/importer";
import { DEFAULT_PRINT, pageSize, printSettingsOf } from "../src/core/printSettings";
import { isOn, setFeature } from "../src/core/features";
import { computeLayout } from "../src/core/layout";
import { createFromTemplate } from "../src/core/templates";
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

t("links: pushing a predecessor pushes its successors, transitively", () => {
	const p = cloneProject(SAMPLE);
	assert.ok(addLink(p, "c1", "d1")); // Transcription after Interviews 1
	assert.ok(addLink(p, "d1", "e2")); // Results after Transcription
	const c1 = p.items.find((i) => i.id === "c1")!;
	c1.end = "2027-05-20";
	const moved = enforceLinks(p);
	assert.equal(p.items.find((i) => i.id === "d1")!.start, "2027-05-21");
	assert.ok(moved.includes("d1") && moved.includes("e2"));
	assert.ok(toDay(p.items.find((i) => i.id === "e2")!.start) > toDay(p.items.find((i) => i.id === "d1")!.end!));
});

t("links: no loops, no duplicates, milestones can share the end day", () => {
	const p = cloneProject(SAMPLE);
	assert.ok(addLink(p, "a2", "a3"));
	assert.equal(addLink(p, "a3", "a2"), false);
	assert.equal(addLink(p, "a2", "a3"), false);
	p.items.find((i) => i.id === "a3")!.start = "2026-12-01";
	enforceLinks(p);
	assert.equal(p.items.find((i) => i.id === "a3")!.start, "2026-12-18");
});

t("links: a deadline never moves; a late predecessor becomes a conflict nudge", () => {
	const p = cloneProject(SAMPLE);
	addLink(p, "f2", "k2"); // Submission after Proofread
	p.items.find((i) => i.id === "f2")!.end = "2027-09-03";
	enforceLinks(p);
	assert.equal(p.items.find((i) => i.id === "k2")!.start, "2027-08-27");
	assert.equal(linkConflicts(p).length, 1);
	assert.ok(computeNudges(p, today).some((n) => n.kind === "conflict"));
});

t("links, buffers and collapsed phases survive a round trip; dangling links are dropped", () => {
	const p = cloneProject(SAMPLE);
	addLink(p, "c1", "d1");
	p.items.push({ id: "buf", type: "task", title: "Buffer", start: "2027-07-01", end: "2027-07-14", phase: "writing", buffer: true });
	p.phases[0].collapsed = true;
	const plain = JSON.parse(JSON.stringify(toPlain(p)));
	plain.items.find((i: any) => i.id === "d2").after = ["missing"];
	const back = normalizeProject(plain);
	assert.deepEqual(back.items.find((i) => i.id === "d1")!.after, ["c1"]);
	assert.equal(back.items.find((i) => i.id === "d2")!.after, undefined);
	assert.equal(back.items.find((i) => i.id === "buf")!.buffer, true);
	assert.equal(back.phases[0].collapsed, true);
});

t("features: switching off hides lanes and nudges but keeps the data", () => {
	const p = cloneProject(SAMPLE);
	const measure = (s: string) => s.length * 6;
	const lanes = () => computeLayout(p, { pxPerDay: 2, showEmptyLanes: true, showJournal: true, today, measure }).lanes.map((l) => l.kind);
	assert.ok(lanes().includes("locations") && lanes().includes("journal"));
	setFeature(p, "locations", false);
	setFeature(p, "journal", false);
	assert.ok(!lanes().includes("locations") && !lanes().includes("journal"));
	assert.ok(p.items.some((i) => i.type === "location") && p.journal?.length, "data kept");
	assert.ok(!computeNudges(p, today).some((n) => n.kind === "checkin"));
	setFeature(p, "nudges", false);
	const back = normalizeProject(JSON.parse(JSON.stringify(toPlain(p))));
	assert.deepEqual(back.off, ["nudges", "locations", "journal"]);
	setFeature(back, "locations", true);
	setFeature(back, "journal", true);
	setFeature(back, "nudges", true);
	assert.equal(back.off, undefined);
});

t("features: the blank template starts with the essentials", () => {
	const blank = createFromTemplate("blank", "x", "2026-10-26");
	assert.ok(!isOn(blank, "locations") && !isOn(blank, "journal") && isOn(blank, "links") && isOn(blank, "progress"));
	assert.equal(createFromTemplate("dissertation", "x", "2026-10-26").off, undefined);
});

t("slack: how far each item can slip before its chain hits a deadline", () => {
	const p = normalizeProject({
		start: "2027-01-01", end: "2027-03-31",
		items: [
			{ id: "a", type: "task", title: "A", start: "2027-01-01", end: "2027-01-10" },
			{ id: "b", type: "task", title: "B", start: "2027-01-15", end: "2027-01-20", after: ["a"] },
			{ id: "d", type: "deadline", title: "Due", start: "2027-01-25", after: ["b"] },
			{ id: "c", type: "task", title: "Free", start: "2027-01-01", end: "2027-01-05" },
		],
	});
	const s = computeSlack(p);
	assert.equal(s.get("b")?.days, 5);
	assert.equal(s.get("a")?.days, 9);
	assert.equal(s.get("a")?.limit.id, "d");
	assert.ok(!s.has("c") && !s.has("d"), "unlinked items and the deadline itself have no slack entry");
	p.items.find((i) => i.id === "b")!.end = "2027-01-27";
	assert.equal(computeSlack(p).get("b")?.days, -2, "negative slack: the deadline is already missed");
});

t("baseline: drift from the saved plan, and it survives a round trip", () => {
	const p = cloneProject(SAMPLE);
	saveBaseline(p, "2026-10-29");
	const item = p.items.find((i) => i.id === "c1")!;
	item.start = "2027-02-18";
	item.end = "2027-04-12";
	assert.equal(driftOf(p, item)?.endShift, 3);
	assert.equal(driftOf(p, p.items.find((i) => i.id === "a1")!)?.endShift, 0);
	p.items.push({ id: "new1", type: "milestone", title: "New", start: "2027-05-01" });
	const sum = baselineSummary(p);
	assert.equal(sum.later, 1);
	assert.equal(sum.added, 1);
	assert.equal(sum.worst?.item.id, "c1");
	const back = normalizeProject(toPlain(p));
	assert.deepEqual(back.baseline?.items.c1, { start: "2027-02-15", end: "2027-04-09" });
	assert.equal(back.baseline?.saved, "2026-10-29");
	assert.equal(driftOf(back, back.items.find((i) => i.id === "c1")!)?.endShift, 3);
});

t("table export: Markdown table and CSV in phase order", () => {
	const md = toMarkdownTable(SAMPLE).split("\n");
	assert.equal(md[0], "| Phase | Item | Type | Start | End | Duration | Status | Starts after |");
	assert.ok(md[2].startsWith("| Literature review | Scoping & reading list | Task | 2026-09-01 | 2026-09-30 |"), md[2]);
	assert.ok(md.some((l) => l.includes("| Proofread | Task |") && l.endsWith("| Revisions |")));
	const csv = toCsv(SAMPLE).split("\r\n");
	assert.equal(csv[0], "Phase,Item,Type,Start,End,Duration,Status,Starts after");
	assert.equal(csv.length, SAMPLE.items.length + 2);
});

t("agenda: what's on now, coming up and overdue, for the sidebar", () => {
	const a = agenda(SAMPLE, today);
	assert.deepEqual(a.now.map((i) => i.id), ["b1", "a2"], "tasks under way, ending soonest first");
	assert.deepEqual(a.soon.map((s) => s.item.id), ["b2"], "starts within four weeks");
	assert.deepEqual(a.late.map((s) => s.item.id), ["a0"], "a milestone that passed without being ticked off");
	assert.ok(!a.now.some((i) => i.id === "a1"), "finished work never shows");
});

t("import: a table pasted from Excel or Sheets (tabs, day-first dates, row-number predecessors)", () => {
	const p = cloneProject(SAMPLE);
	const text = [
		"Task\tPhase\tStart\tEnd\tDuration\t% Complete\tPredecessors",
		"Literature review\tReading\t02/11/2026\t15/12/2026\t\t40%\t",
		"Ethics submission\tReading\t20/12/2026\t\t\t\t1",
		"Pilot study\tMethodology & ethics\t10/01/2027\t\t3 weeks\t0.5\t2",
		"Write up\t\t\t\t\t\t",
	].join("\n");
	const r = parseImport(text, p, "2026-11-04")!;
	assert.equal(r.format, "table");
	assert.equal(r.items.length, 3);
	const [lit, ethics, pilot] = r.items;
	assert.deepEqual([lit.type, lit.start, lit.end, lit.progress], ["task", "2026-11-02", "2026-12-15", 40]);
	assert.equal(ethics.type, "deadline", "a single date called a submission is a deadline");
	assert.deepEqual(ethics.after, [lit.id], "predecessor by row number");
	assert.deepEqual([pilot.start, pilot.end, pilot.progress, pilot.phase], ["2027-01-10", "2027-01-30", 50, "methodology"]);
	assert.deepEqual(r.newPhases.map((ph) => ph.name), ["Reading"], "an existing phase is reused, a new one created");
	assert.equal(r.skipped.length, 1);
	applyImport(p, r);
	assert.ok(p.phases.some((ph) => ph.name === "Reading") && p.items.some((i) => i.title === "Pilot study"));
});

t("import: CSV with quotes and month-first dates", () => {
	const text = 'Name,Start Date,Due Date,Status\n"Draft, chapter 2",01/15/2027,02/28/2027,Done\nSubmit thesis,08/27/2027,,\n';
	const r = parseImport(text, cloneProject(SAMPLE), "2026-11-04")!;
	assert.equal(r.format, "table");
	assert.deepEqual(r.items.map((i) => [i.title, i.type, i.start, i.end ?? null]), [
		["Draft, chapter 2", "task", "2027-01-15", "2027-02-28"],
		["Submit thesis", "deadline", "2027-08-27", null],
	]);
	assert.ok(r.items[0].done && r.items[0].progress === 100);
});

t("import: our own Markdown table comes back in, phases, types and links included", () => {
	const blank = { title: "x", start: "2026-09-01", end: "2027-08-31", phases: [], items: [] };
	const r = parseImport(toMarkdownTable(SAMPLE), blank, "2026-11-04")!;
	assert.equal(r.format, "markdown");
	assert.equal(r.items.length, SAMPLE.items.length);
	assert.deepEqual(r.newPhases.map((ph) => ph.name), SAMPLE.phases.map((ph) => ph.name));
	const byTitle = (t: string) => r.items.find((i) => i.title === t)!;
	assert.equal(byTitle("Proofread").after?.[0], byTitle("Revisions").id);
	assert.equal(byTitle("Submission").type, "deadline");
	assert.equal(byTitle("Fieldwork · Lisbon").type, "location");
	assert.ok(byTitle("Buffer").buffer);
	assert.ok(byTitle("Scoping & reading list").done);
	assert.equal(byTitle("Systematic literature review").progress, 40);
});

t("import: a Mermaid gantt chart from a note", () => {
	const text = [
		"```mermaid",
		"gantt",
		"    title Thesis",
		"    dateFormat YYYY-MM-DD",
		"    section Research",
		"    Literature review :done, lit, 2026-11-01, 30d",
		"    Survey design     :sd, after lit, 2w",
		"    section Writing",
		"    Draft chapters    :2027-01-04, 2027-03-26",
		"    Final draft       :milestone, fd, 2027-04-01, 0d",
		"    Submission        :milestone, 2027-05-15, 0d",
		"```",
	].join("\n");
	const r = parseImport(text, cloneProject(SAMPLE), "2026-11-04")!;
	assert.equal(r.format, "mermaid");
	const [lit, survey, draft, final, sub] = r.items;
	assert.deepEqual([lit.start, lit.end, lit.done], ["2026-11-01", "2026-11-30", true]);
	assert.deepEqual([survey.start, survey.end, survey.after], ["2026-12-01", "2026-12-14", [lit.id]]);
	assert.deepEqual([draft.start, draft.end], ["2027-01-04", "2027-03-26"]);
	assert.deepEqual([final.type, final.start], ["milestone", "2027-04-01"]);
	assert.equal(sub.type, "deadline");
	assert.deepEqual(r.newPhases.map((ph) => ph.name), ["Research"], "“Writing” already exists in the sample");
});

t("import: a list in quick-add style, headings as phases, checkboxes as done", () => {
	const text = "## Fieldwork\n- [x] Pilot interviews 3–14 May\n- Main interviews 1 Jun – 31 Jul 30%\n- !Data freeze 15 Aug\nJust a note without a date\n";
	const r = parseImport(text, cloneProject(SAMPLE), "2026-11-04")!;
	assert.equal(r.format, "list");
	assert.deepEqual(r.items.map((i) => i.title), ["Pilot interviews", "Main interviews", "Data freeze"]);
	assert.ok(r.items[0].done && r.items[1].progress === 30 && r.items[2].type === "deadline");
	assert.equal(r.items[0].start, "2027-05-03");
	assert.equal(r.skipped.length, 1);
});

t("import: dates before the project start widen its period", () => {
	const p = cloneProject(SAMPLE);
	const r = parseImport("Task,Start,End\nPreparation,2026-06-01,2026-07-15\n", p, "2026-11-04")!;
	assert.ok(applyImport(p, r).widened);
	assert.equal(p.start, "2026-06-01");
});

t("print layout: Plan B's decision date goes into its label; deadlines get their own row", () => {
	const measure = (s: string) => s.length * 6;
	const lay = computeLayout(cloneProject(SAMPLE), { pxPerDay: 2, showEmptyLanes: false, measure, print: true, today });
	assert.ok(!lay.placed.some((p) => p.kind === "decision"), "no separate decision marker on paper");
	assert.ok(lay.placed.some((p) => p.kind === "ghost" && /^Plan B, decide by 8 Jan · /.test(p.item.title)), "the decision date is in the Plan B label");
	assert.ok(lay.placed.some((p) => p.item.type === "milestone" && / · 15 Jan$/.test(p.label)), "milestone labels carry their date");
});

t("buffers sit on their task's row, joined to it, with the task's label moved past them", () => {
	const p = normalizeProject({
		start: "2026-11-01", end: "2027-04-30",
		phases: [{ id: "fw", name: "Firmware" }],
		items: [
			{ id: "r1", type: "task", title: "Firmware extraction", phase: "fw", start: "2026-12-01", end: "2027-01-18" },
			{ id: "rb", type: "task", buffer: true, title: "Christmas break", phase: "fw", start: "2026-12-21", end: "2027-01-06" },
			{ id: "s1", type: "task", title: "Write up", phase: "fw", start: "2027-02-01", end: "2027-02-20" },
			{ id: "sb", type: "task", buffer: true, title: "Buffer", phase: "fw", start: "2027-02-21", end: "2027-02-27", after: ["s1"] },
		],
	});
	const lay = computeLayout(p, { pxPerDay: 3, showEmptyLanes: false, measure: (s: string) => s.length * 6 });
	const at = (id: string) => lay.placed.find((x) => x.item.id === id)!;
	assert.equal(at("rb").cy, at("r1").cy, "a buffer inside a task shares its row");
	assert.equal(at("sb").cy, at("s1").cy, "a buffer right after a task shares its row");
	assert.equal(at("rb").attachedTo, "r1");
	assert.ok(at("sb").squareLeft && at("s1").squareRight, "the two bars join with square ends");
	assert.ok(at("s1").labelInside || at("s1").labelX >= at("sb").x1, "the task's own label doesn't sit on the buffer");
});

t("buffers chain: one after a vacation joins the same bar, overlapping ones too, captions apart", () => {
	const p = normalizeProject({
		start: "2027-01-01", end: "2027-06-30",
		phases: [{ id: "w", name: "Writing" }],
		items: [
			// Listed before its task, and starting weeks after the task ends: it still joins, via the vacation.
			{ id: "bf", type: "task", buffer: true, title: "Buffer", phase: "w", start: "2027-04-12", end: "2027-04-25" },
			{ id: "po", type: "task", title: "Poster", phase: "w", start: "2027-03-01", end: "2027-03-25" },
			{ id: "ev", type: "task", buffer: true, title: "Easter vacation", phase: "w", start: "2027-03-19", end: "2027-04-11", pattern: "dots" },
			{ id: "wu", type: "task", title: "Write up", phase: "w", start: "2027-01-10", end: "2027-02-20" },
			{ id: "v1", type: "task", buffer: true, title: "Vacation", phase: "w", start: "2027-02-01", end: "2027-02-14" },
			{ id: "v2", type: "task", buffer: true, title: "Buffer too", phase: "w", start: "2027-02-08", end: "2027-02-26" },
		],
	});
	const lay = computeLayout(p, { pxPerDay: 3, showEmptyLanes: false, measure: (s: string) => s.length * 6 });
	const at = (id: string) => lay.placed.find((x) => x.item.id === id)!;
	assert.equal(at("ev").attachedTo, "po");
	assert.equal(at("bf").attachedTo, "po", "the buffer after the vacation joins the poster's bar");
	assert.equal(at("bf").cy, at("po").cy);
	assert.ok(at("po").squareRight && at("ev").squareLeft, "task and vacation join");
	assert.ok(at("ev").squareRight && at("bf").squareLeft, "vacation and buffer join");
	assert.ok(!at("bf").squareRight, "the end of the chain is rounded");
	assert.ok(at("po").labelInside || at("po").labelX >= at("bf").x1, "the task's name stays in its bar or sits past the whole chain");
	assert.equal(at("v2").attachedTo, "wu", "a buffer overlapping another buffer joins its task");
	assert.ok(at("v1").squareRight && at("v2").squareLeft);
	const c1 = at("v1"), c2 = at("v2");
	assert.ok(c2.labelX >= c1.labelX + c1.labelW, "overlapping buffers' captions don't write over each other");
	// A gap of a few days still chains (on the same row, just not touching).
	p.items.find((i) => i.id === "bf")!.start = "2027-04-16";
	const lay2 = computeLayout(p, { pxPerDay: 3, showEmptyLanes: false, measure: (s: string) => s.length * 6 });
	const bf2 = lay2.placed.find((x) => x.item.id === "bf")!;
	assert.equal(bf2.attachedTo, "po");
	assert.ok(!bf2.squareLeft, "not touching, so its own rounded start");
	// A name too long for its bar goes past the whole chain, not onto the vacation.
	p.items.find((i) => i.id === "po")!.title = "Poster design and printing for the conference";
	const lay3 = computeLayout(p, { pxPerDay: 3, showEmptyLanes: false, measure: (s: string) => s.length * 6 });
	const po3 = lay3.placed.find((x) => x.item.id === "po")!, bf3 = lay3.placed.find((x) => x.item.id === "bf")!;
	assert.ok(!po3.labelInside && (po3.labelX >= bf3.x1 || po3.labelAnchor === "end"), "the long name sits clear of the chain");
});

t("on paper, a chain's captions never overlap: dates go first, then they shift, all on the page", () => {
	const make = (end: string) => normalizeProject({
		start: "2027-01-04", end,
		phases: [{ id: "v", name: "VEX" }],
		items: [
			{ id: "t", type: "task", title: "VEX", phase: "v", start: "2027-02-10", end: "2027-03-25" },
			{ id: "ev", type: "task", buffer: true, title: "Easter vacation", phase: "v", start: "2027-03-26", end: "2027-04-11" },
			{ id: "bf", type: "task", buffer: true, title: "Buffer", phase: "v", start: "2027-04-12", end: "2027-04-19" },
			{ id: "dl", type: "deadline", title: "Submission", start: "2027-04-20" },
		],
	});
	const caps = (end: string, ppd: number) => {
		const lay = computeLayout(make(end), { pxPerDay: ppd, showEmptyLanes: false, measure: (s: string) => s.length * 6, print: true, today });
		const at = (id: string) => lay.placed.find((x) => x.item.id === id)!;
		return { lay, ev: at("ev"), bf: at("bf") };
	};
	// Plenty of room: both keep their dates and sit over their own stretch of the bar.
	const roomy = caps("2027-06-30", 8);
	assert.ok(/·/.test(roomy.ev.label) && /·/.test(roomy.bf.label), "dates kept when there's room");
	assert.ok(roomy.ev.labelX >= roomy.ev.x0 && roomy.bf.labelX >= roomy.ev.labelX + roomy.ev.labelW + 4);
	// Tight against the end of the page (the printed case): no overlap, nothing off the page.
	for (const [end, ppd] of [["2027-04-24", 6], ["2027-04-24", 4], ["2027-04-22", 3], ["2027-04-20", 2]] as const) {
		const { lay, ev, bf } = caps(end, ppd);
		assert.ok(bf.labelX >= ev.labelX + ev.labelW + 4, `captions apart at ${ppd}px/day: "${ev.label}" / "${bf.label}"`);
		assert.ok(ev.labelX >= 0 && bf.labelX + bf.labelW <= lay.width, `captions on the page at ${ppd}px/day`);
		assert.equal(ev.labelAnchor, "start");
	}
	const mid = caps("2027-04-24", 6);
	assert.equal(mid.ev.label, "Easter vacation", "the long caption drops its dates first");
	assert.ok(mid.ev.labelX >= mid.ev.x0, "…and stays over its own stretch of the bar");
});

t("buffer patterns: saved only when not the default, read leniently, only on buffers", () => {
	const p = normalizeProject({
		start: "2027-01-01", end: "2027-06-30",
		items: [
			{ id: "a", type: "task", buffer: true, title: "Vacation", start: "2027-02-01", end: "2027-02-14", pattern: "Cross-hatch" },
			{ id: "b", type: "task", buffer: true, title: "Buffer", start: "2027-03-01", end: "2027-03-14", pattern: "diagonal" },
			{ id: "c", type: "task", title: "Task", start: "2027-03-01", end: "2027-03-14", pattern: "dots" },
			{ id: "d", type: "task", buffer: true, title: "Odd", start: "2027-03-01", end: "2027-03-14", pattern: "zigzag" },
		],
	});
	const by = (id: string) => p.items.find((i) => i.id === id)!;
	assert.equal(by("a").pattern, "crosshatch");
	assert.equal(by("b").pattern, undefined, "the default isn't stored");
	assert.equal(by("c").pattern, undefined, "only buffers have a pattern");
	assert.equal(by("d").pattern, undefined, "unknown patterns are ignored");
	by("b").pattern = "dots";
	const back = normalizeProject(toPlain(p));
	assert.equal(back.items.find((i) => i.id === "a")!.pattern, "crosshatch");
	assert.equal(back.items.find((i) => i.id === "b")!.pattern, "dots");
	const plain = toPlain(p) as { items: Record<string, unknown>[] };
	assert.ok(!("pattern" in plain.items.find((i) => i.id === "c")!));
});

t("a Plan B that carries on from its task is drawn on the task's row; a later one keeps its own", () => {
	const p = normalizeProject({
		start: "2026-11-01", end: "2027-03-31",
		phases: [{ id: "d", name: "Data" }],
		items: [
			{ id: "e1", type: "task", title: "Get an ECU", phase: "d", start: "2026-11-10", end: "2026-12-04",
				planB: { by: "2026-11-27", title: "Public image", start: "2026-11-30", end: "2026-12-11" } },
			{ id: "x1", type: "task", title: "Ethics", phase: "d", start: "2026-11-01", end: "2026-11-20",
				planB: { by: "2027-01-08", title: "Secondary data", start: "2027-01-18", end: "2027-02-20" } },
		],
	});
	const lay = computeLayout(p, { pxPerDay: 3, showEmptyLanes: false, measure: (s: string) => s.length * 6, print: true, today });
	const at = (id: string) => lay.placed.find((x) => x.item.id === id)!;
	assert.equal(at("e1~planb").attachedTo, "e1");
	assert.equal(at("e1~planb").cy, at("e1").cy);
	assert.ok(at("e1").squareRight, "the task's end joins the dashed extension");
	assert.equal(at("x1~planb").attachedTo, undefined, "a Plan B weeks later stays separate");
});

t("print settings: saved in the note, only what differs from the defaults", () => {
	const p = cloneProject(SAMPLE);
	p.print = { paper: "a3", milestoneTable: false, spacing: "roomy", textSize: "normal" };
	const plain = toPlain(p) as { print?: Record<string, unknown> };
	assert.deepEqual(plain.print, { paper: "a3", spacing: "roomy", milestoneTable: false }, "defaults aren't written");
	const back = normalizeProject({ ...plain, print: { ...plain.print, paper: "a2", today: "yes" } });
	assert.deepEqual(back.print, { spacing: "roomy", milestoneTable: false }, "unknown values are dropped");
	assert.equal(printSettingsOf(back.print).paper, DEFAULT_PRINT.paper);
	assert.deepEqual(pageSize({ ...DEFAULT_PRINT, paper: "a4", orientation: "portrait" }), { w: 794, h: 1123, wPt: 595.28, hPt: 841.89 });
});

t("labels never run off the chart: other side, then without the date, then shortened", () => {
	const measure = (s: string) => s.length * 7;
	const p = normalizeProject({
		start: "2027-01-01", end: "2027-03-31",
		phases: [{ id: "a", name: "A" }],
		items: [{ id: "t", type: "task", title: "SBOM creation with vulnerability mapping, with adviser", phase: "a", start: "2027-02-01", end: "2027-02-14" }],
	});
	for (const pxPerDay of [2, 3, 5]) {
		const lay = computeLayout(p, { pxPerDay, showEmptyLanes: false, measure, print: true });
		const t = lay.placed.find((x) => x.item.id === "t")!;
		const x0 = t.labelAnchor === "end" ? t.labelX - t.labelW : t.labelX;
		assert.ok(x0 >= 0 && x0 + t.labelW <= lay.width, `inside the chart at ${pxPerDay}px/day (${Math.round(x0)}..${Math.round(x0 + t.labelW)} of ${lay.width})`);
	}
});

console.log(failed ? `\n${failed} failed` : `\nall nudge/journal/link/feature tests passed`);
if (failed) process.exit(1);
