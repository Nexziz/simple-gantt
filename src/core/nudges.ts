import { toDay } from "./dates";
import { Slot, dueCheckIn } from "./journal";
import { linkConflicts } from "./links";
import { GanttItem, Project, isCheckable, isDone } from "./types";

/**
 * Gentle prompts shown above the chart, most important first:
 *  decision  – a Plan B decision date has arrived and the item isn't done
 *  checkin   – the journal check-in for this period hasn't been written
 *  reached   – a milestone/deadline/task end has passed without being ticked off
 *  upcoming  – a deadline is coming up within two weeks
 */
export type Nudge =
	| { kind: "decision"; key: string; item: GanttItem }
	| { kind: "conflict"; key: string; item: GanttItem; pred: GanttItem }
	| { kind: "checkin"; key: string; slot: Slot }
	| { kind: "reached"; key: string; item: GanttItem; daysAgo: number }
	| { kind: "upcoming"; key: string; item: GanttItem; days: number };

export function computeNudges(project: Project, today: number): Nudge[] {
	const out: Nudge[] = [];
	const live = project.items.filter((i) => !i.dropped);

	for (const item of live) {
		const pb = item.planB;
		if (pb && !pb.status && !isDone(item) && toDay(pb.by) <= today)
			out.push({ kind: "decision", key: `decision:${item.id}:${pb.by}`, item });
	}

	// A linked item that can't move (a deadline, or something finished) now comes before its predecessor ends.
	for (const c of linkConflicts(project))
		out.push({ kind: "conflict", key: `conflict:${c.pred.id}:${c.succ.id}:${c.pred.end ?? c.pred.start}`, item: c.succ, pred: c.pred });

	const slot = dueCheckIn(project, today);
	if (slot) out.push({ kind: "checkin", key: `checkin:${slot.day}`, slot });

	const reached = live
		.filter((i) => isCheckable(i) && !isDone(i))
		.map((item) => ({ item, daysAgo: today - toDay(item.end ?? item.start) }))
		.filter(({ daysAgo }) => daysAgo > 0 && daysAgo <= 60)
		.sort((a, b) => a.daysAgo - b.daysAgo);
	for (const r of reached) out.push({ kind: "reached", key: `reached:${r.item.id}:${r.item.end ?? r.item.start}`, ...r });

	const upcoming = live
		.filter((i) => i.type === "deadline" && !isDone(i))
		.map((item) => ({ item, days: toDay(item.start) - today }))
		.filter(({ days }) => days >= 0 && days <= 14)
		.sort((a, b) => a.days - b.days);
	for (const u of upcoming) out.push({ kind: "upcoming", key: `upcoming:${u.item.id}:${u.item.start}`, ...u });

	return out;
}

/** The next deadline that isn't done yet, for the toolbar countdown. */
export function nextDeadline(project: Project, today: number): { item: GanttItem; days: number } | null {
	let best: { item: GanttItem; days: number } | null = null;
	for (const item of project.items) {
		if (item.type !== "deadline" || isDone(item) || item.dropped) continue;
		const days = toDay(item.start) - today;
		if (days >= 0 && (!best || days < best.days)) best = { item, days };
	}
	return best;
}

/** Overall progress, weighting each task by its length; milestones and deadlines count as one week each. */
export function overallProgress(project: Project): number {
	let total = 0;
	let done = 0;
	for (const it of project.items) {
		if (it.dropped || !isCheckable(it)) continue;
		const weight = it.type === "task" && it.end ? toDay(it.end) - toDay(it.start) + 1 : 7;
		total += weight;
		done += weight * (isDone(it) ? 1 : it.type === "task" ? (it.progress ?? 0) / 100 : 0);
	}
	return total ? Math.round((done / total) * 100) : 0;
}

/** Shift an item and everything that starts on or after it (not yet done) by `days`. Returns how many moved. */
export function rippleShift(project: Project, from: GanttItem, days: number, samePhaseOnly = false): number {
	if (!days) return 0;
	const pivot = toDay(from.start);
	let moved = 0;
	const shift = (iso: string) => new Date((toDay(iso) + days) * 86400000).toISOString().slice(0, 10);
	for (const it of project.items) {
		const isPivot = it.id === from.id;
		if (!isPivot && (isDone(it) || it.dropped || toDay(it.start) < pivot)) continue;
		if (!isPivot && samePhaseOnly && it.phase !== from.phase) continue;
		it.start = shift(it.start);
		if (it.end) it.end = shift(it.end);
		if (it.planB && !it.planB.status) {
			it.planB.by = shift(it.planB.by);
			if (it.planB.start) it.planB.start = shift(it.planB.start);
			if (it.planB.end) it.planB.end = shift(it.planB.end);
		}
		moved++;
	}
	return moved;
}
