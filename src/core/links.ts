import { fromDay, toDay } from "./dates";
import { GanttItem, Project, isDone, isRangeType } from "./types";

/**
 * Finish-to-start links: an item can list the items it comes after (`after`).
 * When a predecessor moves later, its successors are pushed forward so the order holds.
 * Deadlines, finished and dropped items never move; a broken order there is a conflict.
 */

export interface Conflict {
	pred: GanttItem;
	succ: GanttItem;
}

function end(item: GanttItem): number {
	return toDay(item.end ?? item.start);
}

/** The first day a successor may start, given one predecessor. */
export function earliestAfter(pred: GanttItem, succ: GanttItem): number {
	// A task after a task starts the next day; a milestone can mark the day its predecessor ends.
	return end(pred) + (isRangeType(pred.type) && isRangeType(succ.type) ? 1 : 0);
}

function fixed(item: GanttItem): boolean {
	return item.type === "deadline" || isDone(item) || !!item.dropped;
}

export function predecessorsOf(project: Project, item: GanttItem): GanttItem[] {
	const ids = new Set(item.after ?? []);
	return project.items.filter((i) => ids.has(i.id));
}

export function successorsOf(project: Project, item: GanttItem): GanttItem[] {
	return project.items.filter((i) => i.after?.includes(item.id));
}

/** True if making `succId` come after `predId` would create a loop. */
export function wouldCycle(project: Project, predId: string, succId: string): boolean {
	if (predId === succId) return true;
	const byId = new Map(project.items.map((i) => [i.id, i]));
	const seen = new Set<string>();
	const stack = [predId];
	while (stack.length) {
		const id = stack.pop()!;
		if (id === succId) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		for (const p of byId.get(id)?.after ?? []) stack.push(p);
	}
	return false;
}

/** Link `succ` to start after `pred`. Returns false if it would loop or already exists. */
export function addLink(project: Project, predId: string, succId: string): boolean {
	const succ = project.items.find((i) => i.id === succId);
	if (!succ || wouldCycle(project, predId, succId) || succ.after?.includes(predId)) return false;
	succ.after = [...(succ.after ?? []), predId];
	return true;
}

export function removeLink(project: Project, predId: string, succId: string) {
	const succ = project.items.find((i) => i.id === succId);
	if (!succ?.after) return;
	succ.after = succ.after.filter((id) => id !== predId);
	if (!succ.after.length) delete succ.after;
}

/** Drop links to items that no longer exist. */
export function pruneLinks(project: Project) {
	const ids = new Set(project.items.map((i) => i.id));
	for (const it of project.items) {
		if (!it.after) continue;
		it.after = it.after.filter((id) => ids.has(id) && id !== it.id);
		if (!it.after.length) delete it.after;
	}
}

/** Push successors forward until every link holds. Returns the ids that moved. */
export function enforceLinks(project: Project): string[] {
	const moved = new Set<string>();
	const byId = new Map(project.items.map((i) => [i.id, i]));
	for (let pass = 0; pass < project.items.length + 1; pass++) {
		let changed = false;
		for (const succ of project.items) {
			if (!succ.after?.length || fixed(succ)) continue;
			let earliest = -Infinity;
			for (const id of succ.after) {
				const pred = byId.get(id);
				if (pred && !pred.dropped) earliest = Math.max(earliest, earliestAfter(pred, succ));
			}
			const start = toDay(succ.start);
			if (earliest > start) {
				const delta = earliest - start;
				succ.start = fromDay(start + delta);
				if (succ.end) succ.end = fromDay(toDay(succ.end) + delta);
				moved.add(succ.id);
				changed = true;
			}
		}
		if (!changed) break;
	}
	return [...moved];
}

/** Links whose order is broken and can't be fixed by moving (deadlines, finished items). */
export function linkConflicts(project: Project): Conflict[] {
	const byId = new Map(project.items.map((i) => [i.id, i]));
	const out: Conflict[] = [];
	for (const succ of project.items) {
		for (const id of succ.after ?? []) {
			const pred = byId.get(id);
			if (pred && !pred.dropped && !succ.dropped && toDay(succ.start) < earliestAfter(pred, succ)) out.push({ pred, succ });
		}
	}
	return out;
}

export interface Slack {
	/** Days this item can finish later before a fixed item (a deadline or something finished) is hit. */
	days: number;
	/** The fixed item that limits it. */
	limit: GanttItem;
}

/**
 * How far each open item can slip before its chain of links runs into a deadline or a finished item.
 * Items whose links never reach one are free and get no entry. Zero (or less) means the item is on the
 * critical path: any delay pushes, or already misses, that deadline.
 */
export function computeSlack(project: Project): Map<string, Slack> {
	const live = project.items.filter((i) => !i.dropped);
	const succs = new Map<string, GanttItem[]>();
	for (const s of live) for (const id of s.after ?? []) succs.set(id, [...(succs.get(id) ?? []), s]);
	const memo = new Map<string, Slack | null>();
	const visit = (item: GanttItem): Slack | null => {
		if (memo.has(item.id)) return memo.get(item.id)!;
		memo.set(item.id, null); // links never loop, but be safe
		let best: Slack | null = null;
		for (const s of succs.get(item.id) ?? []) {
			const gap = toDay(s.start) - earliestAfter(item, s);
			const down = fixed(s) ? { days: 0, limit: s } : visit(s);
			if (!down) continue;
			const days = gap + down.days;
			if (!best || days < best.days) best = { days, limit: down.limit };
		}
		memo.set(item.id, best);
		return best;
	};
	const out = new Map<string, Slack>();
	for (const it of live) {
		if (fixed(it)) continue;
		const s = visit(it);
		if (s) out.set(it.id, s);
	}
	return out;
}
