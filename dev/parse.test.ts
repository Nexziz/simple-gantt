import assert from "node:assert/strict";
import { parseQuickAdd } from "../src/core/parse";
import { SAMPLE } from "./sample";

const ctx = { project: SAMPLE, defaultType: "task" as const, today: "2026-10-26" };
const p = (s: string, extra: Partial<typeof ctx> = {}) => parseQuickAdd(s, { ...ctx, ...extra });

const cases: [string, Record<string, unknown>][] = [
	["Literature review Jan–Mar #lit", { type: "task", title: "Literature review", start: "2027-01-01", end: "2027-03-31", phase: "literature" }],
	["Literature review Jan-Mar 2027", { start: "2027-01-01", end: "2027-03-31" }],
	["Pilot Nov – Feb 2027", { start: "2026-11-01", end: "2027-02-28" }],
	["!Ethics committee 15 Feb", { type: "deadline", title: "Ethics committee", start: "2027-02-15", end: undefined }],
	["Ethics form deadline 10 Jan", { type: "deadline", title: "Ethics form deadline", start: "2027-01-10" }],
	["*Chapter 2 drafted Jan 20", { type: "milestone", title: "Chapter 2 drafted", start: "2027-01-20" }],
	["+Supervisor meeting 3 Dec", { type: "event", title: "Supervisor meeting", start: "2026-12-03" }],
	["Supervisor meeting 3 Dec", { type: "event" }],
	["@Fieldwork Lisbon 22 Feb – 9 Apr", { type: "location", title: "Fieldwork Lisbon", start: "2027-02-22", end: "2027-04-09" }],
	["Pilot study 18 Jan for 4 weeks 30%", { title: "Pilot study", start: "2027-01-18", end: "2027-02-14", progress: 30 }],
	["Coding from 1 March for 2 months", { title: "Coding", start: "2027-03-01", end: "2027-04-30" }],
	["Interviews 15–20 May", { title: "Interviews", start: "2027-05-15", end: "2027-05-20" }],
	["Write abstract 2027-06-01 to 2027-06-14", { title: "Write abstract", start: "2027-06-01", end: "2027-06-14" }],
	["Revise 3/7/2027 - 10/7/2027", { start: "2027-07-03", end: "2027-07-10" }],
	["Reading in October", { title: "Reading", start: "2026-10-01", end: "2026-10-31" }],
	["Teaching #teaching Sep–Dec", { newPhase: "Teaching", phase: undefined, start: "2026-09-01", end: "2026-12-31" }],
	["Write blog post", { title: "Write blog post", start: "2026-10-26", end: "2026-11-08", dateGuessed: true }],
	["Prepare slides tomorrow", { title: "Prepare slides", start: "2026-10-27", end: "2026-10-27" }],
	["Data analysis #anal May–Jun", { phase: "analysis" }],
	["Dec – Jan holidays", { title: "holidays", start: "2026-12-01", end: "2027-01-31" }],
];

let failed = 0;
for (const [input, expected] of cases) {
	const r = p(input) as unknown as Record<string, unknown>;
	try {
		assert.ok(r, "no result");
		for (const [k, v] of Object.entries(expected)) assert.deepEqual(r[k], v, `${k}: got ${JSON.stringify(r[k])}, want ${JSON.stringify(v)}`);
		console.log(`  ✓ ${input}`);
	} catch (e) {
		failed++;
		console.log(`  ✗ ${input}\n      ${(e as Error).message}\n      ${JSON.stringify(r)}`);
	}
}
console.log(failed ? `\n${failed} failed` : `\nall ${cases.length} passed`);
if (failed) process.exit(1);
