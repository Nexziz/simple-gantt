import { toDay } from "./dates";
import { GanttItem, Project, isRangeType } from "./types";

/**
 * A saved copy of the plan's dates, to compare the plan with what really happened.
 * Stored in the note as `baseline: { saved, items: { id: "start/end" } }` (ISO interval notation).
 */
export interface Baseline {
	/** ISO date the plan was saved. */
	saved: string;
	/** Item id → planned dates. */
	items: Record<string, { start: string; end?: string }>;
}

export function saveBaseline(project: Project, today: string) {
	const items: Baseline["items"] = {};
	for (const it of project.items) {
		if (it.dropped) continue;
		items[it.id] = isRangeType(it.type) && it.end ? { start: it.start, end: it.end } : { start: it.start };
	}
	project.baseline = { saved: today, items };
}

export interface Drift {
	/** Planned start / end (day numbers). */
	start: number;
	end: number;
	/** Days the end moved: positive = later than planned. */
	endShift: number;
	startShift: number;
}

/** How an item moved since the plan was saved, or null if it wasn't in the plan. */
export function driftOf(project: Project, item: GanttItem): Drift | null {
	const b = project.baseline?.items[item.id];
	if (!b) return null;
	const start = toDay(b.start);
	const end = toDay(b.end ?? b.start);
	return { start, end, startShift: toDay(item.start) - start, endShift: toDay(item.end ?? item.start) - end };
}

/** Plan-vs-now totals for the project panel. */
export function baselineSummary(project: Project): { later: number; earlier: number; added: number; worst: { item: GanttItem; days: number } | null } {
	let later = 0, earlier = 0, added = 0;
	let worst: { item: GanttItem; days: number } | null = null;
	for (const it of project.items) {
		if (it.dropped) continue;
		const d = driftOf(project, it);
		if (!d) {
			added++;
			continue;
		}
		if (d.endShift > 0) later++;
		else if (d.endShift < 0) earlier++;
		if (d.endShift > 0 && (!worst || d.endShift > worst.days)) worst = { item: it, days: d.endShift };
	}
	return { later, earlier, added, worst };
}

/** "2026-11-01/2026-11-30" ↔ { start, end }. */
export function formatInterval(v: { start: string; end?: string }): string {
	return v.end && v.end !== v.start ? `${v.start}/${v.end}` : v.start;
}

export function parseInterval(v: unknown): { start: string; end?: string } | null {
	const s = v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v.trim() : "";
	const m = /^(\d{4}-\d{2}-\d{2})(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(s);
	if (!m) return null;
	return m[2] && m[2] > m[1] ? { start: m[1], end: m[2] } : { start: m[1] };
}
