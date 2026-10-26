/** The five kinds of things a timeline can hold. */
export type ItemType = "task" | "milestone" | "deadline" | "event" | "location";

export const ITEM_TYPES: ItemType[] = ["task", "milestone", "deadline", "event", "location"];

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
	task: "Task",
	milestone: "Milestone",
	deadline: "Deadline",
	event: "Key date",
	location: "Location",
};

/** Types that span a date range; the others sit on a single day. */
export function isRangeType(type: ItemType): boolean {
	return type === "task" || type === "location";
}

/** Named palette colours. Stored by name so the file stays readable and themes can restep them. */
export type ColorName = "blue" | "orange" | "aqua" | "yellow" | "magenta" | "green" | "violet" | "red";

/** Fixed order in which new phases receive colours (never cycled randomly). */
export const COLOR_ORDER: ColorName[] = ["blue", "orange", "aqua", "yellow", "magenta", "green", "violet", "red"];

export interface Phase {
	id: string;
	name: string;
	color: ColorName;
	/** Folded into one summary row. */
	collapsed?: boolean;
}

export interface GanttItem {
	id: string;
	type: ItemType;
	title: string;
	/** ISO date, YYYY-MM-DD. */
	start: string;
	/** ISO date, inclusive. Only for range types. */
	end?: string;
	/** Phase id. Tasks and milestones live in a phase lane; others may carry one for colour. */
	phase?: string;
	/** 0–100. Tasks only. */
	progress?: number;
	/** Path or link text of an Obsidian note. */
	note?: string;
	/** Free-form description shown in the tooltip. */
	description?: string;
	/** Reached / finished. For tasks this goes together with progress 100. */
	done?: boolean;
	/** ISO date the item was actually finished. */
	doneOn?: string;
	/** "How did it go?" — written when the item is ticked off. */
	review?: Review;
	/** A contingency: if this isn't done by `by`, switch to the alternative. */
	planB?: PlanB;
	/** Set when Plan B replaced this item; it stays on the chart, faded and struck through. */
	dropped?: boolean;
	/** Ids of items this one starts after (finish-to-start links). */
	after?: string[];
	/** Tasks only: slack kept free to absorb delays, drawn hatched. */
	buffer?: boolean;
}

/** 1 = rough … 5 = great. */
export type Mood = 1 | 2 | 3 | 4 | 5;

export const MOODS: { value: Mood; face: string; label: string }[] = [
	{ value: 1, face: "😣", label: "Rough" },
	{ value: 2, face: "😕", label: "Meh" },
	{ value: 3, face: "😐", label: "Okay" },
	{ value: 4, face: "🙂", label: "Good" },
	{ value: 5, face: "🤩", label: "Great" },
];

export interface Review {
	mood?: Mood;
	text?: string;
}

export interface PlanB {
	/** Decision date (ISO). */
	by: string;
	/** What happens instead. */
	title: string;
	/** Optional dates for the alternative; shown as a dashed "ghost" bar. */
	start?: string;
	end?: string;
	note?: string;
	/** Unset = waiting for the decision date. */
	status?: "active" | "dismissed";
}

export type CheckIn = "weekly" | "fortnightly" | "monthly";

export const CHECKIN_LABELS: Record<CheckIn, string> = {
	weekly: "Every week",
	fortnightly: "Every 2 weeks",
	monthly: "Every month",
};

export interface JournalEntry {
	id: string;
	/** ISO date. */
	date: string;
	mood?: Mood;
	text: string;
}

/** Items that can be ticked off. */
export function isCheckable(item: GanttItem): boolean {
	return item.type === "task" || item.type === "milestone" || item.type === "deadline";
}

export function isDone(item: GanttItem): boolean {
	return !!item.done || (item.type === "task" && (item.progress ?? 0) >= 100);
}

export interface Project {
	title: string;
	subtitle?: string;
	author?: string;
	/** ISO date: the first day of the planned period. */
	start: string;
	/** ISO date: the last day of the planned period. */
	end: string;
	phases: Phase[];
	items: GanttItem[];
	/** How often the journal asks for a check-in. */
	checkin?: CheckIn;
	journal?: JournalEntry[];
	/** Check-in dates (ISO) the user chose to skip. */
	skippedCheckins?: string[];
	/** Row spacing; comfortable when unset. */
	density?: "compact";
	/** Optional features switched off for this project (see core/features). */
	off?: import("./features").Feature[];
}

export function newId(): string {
	return Math.random().toString(36).slice(2, 8);
}

export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "phase";
}

/** Unique phase id derived from a name. */
export function phaseIdFor(project: Project, name: string): string {
	const base = slugify(name);
	let id = base;
	let n = 2;
	while (project.phases.some((p) => p.id === id)) id = `${base}-${n++}`;
	return id;
}

/** The next unused colour in the fixed order (falls back to the order again once all are used). */
export function nextPhaseColor(project: Project): ColorName {
	const used = new Set(project.phases.map((p) => p.color));
	return COLOR_ORDER.find((c) => !used.has(c)) ?? COLOR_ORDER[project.phases.length % COLOR_ORDER.length];
}

export function addPhase(project: Project, name: string): Phase {
	const phase: Phase = { id: phaseIdFor(project, name), name: name.trim(), color: nextPhaseColor(project) };
	project.phases.push(phase);
	return phase;
}

export function cloneProject(project: Project): Project {
	return structuredClone(project);
}
