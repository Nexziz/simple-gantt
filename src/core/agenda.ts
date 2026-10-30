import { toDay } from "./dates";
import { isOn } from "./features";
import { GanttItem, Project, isCheckable, isDone } from "./types";

/** What matters right now, for the sidebar overview. */
export interface Agenda {
	/** Tasks under way today (and places you are at). */
	now: GanttItem[];
	/** What starts or falls due within the horizon. */
	soon: { item: GanttItem; day: number }[];
	/** Milestones, deadlines and tasks whose date passed without being ticked off (last 60 days). */
	late: { item: GanttItem; day: number }[];
}

export function agenda(project: Project, today: number, horizon = 28): Agenda {
	const live = project.items.filter((i) =>
		!i.dropped && !isDone(i) &&
		(i.type !== "event" || isOn(project, "events")) &&
		(i.type !== "location" || isOn(project, "locations")));
	const end = (i: GanttItem) => toDay(i.end ?? i.start);
	const now = live
		.filter((i) => (i.type === "task" || i.type === "location") && !i.buffer && toDay(i.start) <= today && today <= end(i))
		.sort((a, b) => end(a) - end(b));
	const soon = live
		.map((item) => ({ item, day: toDay(item.start) }))
		.filter(({ day }) => day > today && day <= today + horizon)
		.sort((a, b) => a.day - b.day);
	const late = live
		.filter((i) => isCheckable(i))
		.map((item) => ({ item, day: end(item) }))
		.filter(({ day }) => day < today && today - day <= 60)
		.sort((a, b) => b.day - a.day);
	return { now, soon, late };
}
