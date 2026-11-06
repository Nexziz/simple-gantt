import { toDay } from "./dates";
import { Project } from "./types";

/**
 * How long a phase takes to do: every day one of its tasks runs, not counting the days its vacations and
 * buffers cover (time off and slack aren't work). Dropped items don't count. 0 when it has no tasks.
 */
export function phaseWorkDays(project: Project, phaseId: string): number {
	const work = new Set<number>();
	const off = new Set<number>();
	for (const it of project.items) {
		if (it.phase !== phaseId || it.type !== "task" || it.dropped) continue;
		const s = toDay(it.start);
		const e = it.end ? toDay(it.end) : s;
		for (let d = s; d <= e; d++) (it.buffer ? off : work).add(d);
	}
	let days = 0;
	for (const d of work) if (!off.has(d)) days++;
	return days;
}
