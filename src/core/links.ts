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
