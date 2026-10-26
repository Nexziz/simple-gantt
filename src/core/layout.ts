import { formatMonthSpan, monthEnd, monthStart, toDay } from "./dates";
import { SlotState, slotStates } from "./journal";
import { ColorName, GanttItem, Mood, Phase, Project, isDone } from "./types";

/** Geometry constants, in CSS pixels. */
export const G = {
	yearRowH: 22,
	monthRowH: 26,
	weekRowH: 20,
	rowPitch: 28,
	barH: 20,
	stripPitch: 24,
	stripH: 18,
	lanePad: 10,
	minLaneH: 48,
	labelGap: 6,
	packGap: 8,
	fontSize: 12,
};

export type LaneKind = "locations" | "keydates" | "journal" | "phase" | "unassigned";

/**
 * What a placed mark represents:
 *  item     – a real item from the project
 *  ghost    – the dashed alternative of an item's Plan B
 *  decision – the Plan B decision date, shown among the key dates
 *  entry    – a journal entry
 *  slot     – a check-in date with no entry (due, missed or upcoming)
 */
export type MarkKind = "item" | "ghost" | "decision" | "entry" | "slot";

interface Mark {
	kind: MarkKind;
	item: GanttItem;
	parentId?: string;
	state?: SlotState | "pending";
	mood?: Mood;
}

export interface Lane {
	kind: LaneKind;
	/** Phase id for phase lanes, otherwise the lane kind. */
	key: string;
	phase?: Phase;
	title: string;
	subtitle: string;
	color?: ColorName;
	y: number;
	height: number;
	rows: number;
	/** Y of the top of the first row's mark. */
	contentTop: number;
	pitch: number;
	markH: number;
}

export interface Placed {
	kind: MarkKind;
	/** The real item, or a stand-in for derived marks. */
	item: GanttItem;
	/** For ghosts and decisions: the item that owns the Plan B. */
	parentId?: string;
	state?: SlotState | "pending";
	mood?: Mood;
	lane: Lane;
	row: number;
	startDay: number;
	endDay: number;
	/** Mark extent (for bars/pills: the bar; for point marks: the marker centre ± size). */
	x0: number;
	x1: number;
	/** Vertical centre of the mark. */
	cy: number;
	color: ColorName | null;
	label: string;
	labelW: number;
	labelX: number;
	labelInside: boolean;
	labelAnchor: "start" | "end";
}

export interface Layout {
	viewStart: number;
	viewEnd: number;
	pxPerDay: number;
	width: number;
	headerH: number;
	bodyH: number;
	showWeeks: boolean;
	lanes: Lane[];
	placed: Placed[];
	xOf(day: number): number;
	dayAt(x: number): number;
}

export interface LayoutOptions {
	pxPerDay: number;
	/** Show the Key dates / Locations lanes even when empty (interactive mode). */
	showEmptyLanes: boolean;
	/** Include the journal / check-in lane (off for exports). */
	showJournal?: boolean;
	/** Today as a day number, for check-in and decision states. */
	today?: number;
	measure: (text: string, weight?: number, size?: number) => number;
}

export type Measure = LayoutOptions["measure"];

/** The visible date range: whole months covering the project and everything in it. */
export function viewRange(project: Project): [number, number] {
	let s = toDay(project.start);
	let e = toDay(project.end);
	for (const it of project.items) {
		s = Math.min(s, toDay(it.start));
		e = Math.max(e, toDay(it.end ?? it.start));
		if (it.planB?.start) {
			s = Math.min(s, toDay(it.planB.start));
			e = Math.max(e, toDay(it.planB.end ?? it.planB.start));
		}
	}
	return [monthStart(s), monthEnd(e)];
}

export function itemDays(item: GanttItem): [number, number] {
	const s = toDay(item.start);
	const e = item.end ? Math.max(s, toDay(item.end)) : s;
	return [s, e];
}

/** Greedy interval packing: returns the row index for each [from, to] in input order. */
function pack(intervals: [number, number][]): number[] {
	const rowEnds: number[] = [];
	return intervals.map(([from, to]) => {
		let row = rowEnds.findIndex((end) => end + G.packGap <= from);
		if (row === -1) {
			row = rowEnds.length;
			rowEnds.push(to);
		} else rowEnds[row] = to;
		return row;
	});
}

export function computeLayout(project: Project, opts: LayoutOptions): Layout {
	const [viewStart, viewEnd] = viewRange(project);
	const ppd = opts.pxPerDay;
	const width = (viewEnd - viewStart + 1) * ppd;
	const xOf = (day: number) => (day - viewStart) * ppd;
	const dayAt = (x: number) => viewStart + Math.floor(x / ppd);
	const showWeeks = ppd >= 4.5;
	const headerH = G.yearRowH + G.monthRowH + (showWeeks ? G.weekRowH : 0);

	const phaseIds = new Set(project.phases.map((p) => p.id));
	const today = opts.today ?? toDay(new Date().toISOString().slice(0, 10));
	const asMarks = (items: GanttItem[]): Mark[] => items.map((item) => ({ kind: "item", item }));

	// Plan B: a pending contingency adds a decision point and, when it has dates, a ghost bar.
	const ghosts: Mark[] = [];
	const decisions: Mark[] = [];
	for (const it of project.items) {
		const pb = it.planB;
		if (!pb || pb.status || isDone(it) || it.dropped) continue;
		decisions.push({
			kind: "decision",
			parentId: it.id,
			state: toDay(pb.by) <= today ? "due" : "pending",
			item: { id: `${it.id}~decide`, type: "milestone", title: `Decide · ${it.title}`, start: pb.by },
		});
		if (pb.start)
			ghosts.push({
				kind: "ghost",
				parentId: it.id,
				item: {
					id: `${it.id}~planb`, type: "task", title: `Plan B · ${pb.title || "Alternative"}`,
					start: pb.start, end: pb.end ?? pb.start, phase: it.phase,
				},
			});
	}

	const groups: { kind: LaneKind; key: string; phase?: Phase; marks: Mark[]; items: GanttItem[] }[] = [];
	const locations = project.items.filter((i) => i.type === "location");
	const keyDates = project.items.filter((i) => i.type === "event" || i.type === "deadline");
	if (locations.length || opts.showEmptyLanes) groups.push({ kind: "locations", key: "locations", items: locations, marks: asMarks(locations) });
	if (keyDates.length || decisions.length || opts.showEmptyLanes)
		groups.push({ kind: "keydates", key: "keydates", items: keyDates, marks: [...asMarks(keyDates), ...decisions] });
	if (opts.showJournal && (project.checkin || project.journal?.length)) {
		const marks: Mark[] = [];
		for (const slot of slotStates(project, today)) {
			if (slot.state === "done") continue;
			marks.push({ kind: "slot", state: slot.state, item: { id: `slot~${slot.day}`, type: "event", title: "Check-in", start: fromDayIso(slot.day) } });
		}
		for (const e of project.journal ?? [])
			marks.push({ kind: "entry", mood: e.mood, item: { id: `journal~${e.id}`, type: "event", title: e.text, start: e.date } });
		groups.push({ kind: "journal", key: "journal", items: [], marks });
	}
	const inPhase = (i: GanttItem) => i.type === "task" || i.type === "milestone";
	for (const phase of project.phases) {
		const items = project.items.filter((i) => inPhase(i) && i.phase === phase.id);
		groups.push({
			kind: "phase", key: phase.id, phase, items,
			marks: [...asMarks(items), ...ghosts.filter((g) => g.item.phase === phase.id)],
		});
	}
	const orphans = project.items.filter((i) => inPhase(i) && !(i.phase && phaseIds.has(i.phase)));
	const orphanGhosts = ghosts.filter((g) => !(g.item.phase && phaseIds.has(g.item.phase)));
	if (orphans.length || orphanGhosts.length)
		groups.push({ kind: "unassigned", key: "unassigned", items: orphans, marks: [...asMarks(orphans), ...orphanGhosts] });

	const phaseColor = (id?: string): ColorName | null => project.phases.find((p) => p.id === id)?.color ?? null;

	const lanes: Lane[] = [];
	const placed: Placed[] = [];
	let y = 0;

	for (const group of groups) {
		const strip = group.kind === "locations" || group.kind === "keydates" || group.kind === "journal";
		const pitch = strip ? G.stripPitch : G.rowPitch;
		const markH = strip ? G.stripH : G.barH;
		const journal = group.kind === "journal";

		const sorted = [...group.marks].sort((ma, mb) => {
			const [as, ae] = itemDays(ma.item);
			const [bs, be] = itemDays(mb.item);
			return as - bs || be - bs - (ae - as) || ma.item.title.localeCompare(mb.item.title);
		});

		// Horizontal geometry first; rows come from packing the full footprint (mark + outside label).
		const pre = sorted.map((mark) => {
			const item = mark.item;
			const [s, e] = itemDays(item);
			const done = mark.kind === "item" && isDone(item);
			const label = journal ? "" : (done ? "✓ " : "") + (item.title || "Untitled");
			const weight = item.type === "deadline" || item.type === "location" ? 600 : 500;
			const labelW = label ? opts.measure(label, weight) : 0;
			let x0: number, x1: number, labelX: number, labelInside = false, labelAnchor: "start" | "end" = "start";
			if (item.type === "task" || item.type === "location") {
				x0 = xOf(s);
				x1 = Math.max(x0 + 3, xOf(e + 1));
				const pad = item.type === "location" ? 24 : 14;
				if (labelW + pad <= x1 - x0) {
					labelInside = true;
					labelX = x0 + (item.type === "location" ? 20 : 7);
				} else labelX = x1 + G.labelGap;
			} else {
				const cx = xOf(s) + ppd / 2;
				const r = item.type === "milestone" ? 7 : 6;
				x0 = cx - r;
				x1 = cx + r;
				labelX = x1 + G.labelGap;
			}
			if (!labelInside && labelX + labelW + 4 > width) {
				labelAnchor = "end";
				labelX = x0 - G.labelGap;
			}
			const from = labelInside ? x0 : Math.min(x0, labelAnchor === "end" ? labelX - labelW : x0);
			const to = labelInside ? x1 : Math.max(x1, labelAnchor === "start" ? labelX + labelW : x1);
			return { mark, item, s, e, label, labelW, x0, x1, labelX, labelInside, labelAnchor, from, to };
		});
		// The journal lane is a single row of small markers; everything else is packed.
		const rows = journal ? pre.map(() => 0) : pack(pre.map((p) => [p.from, p.to]));
		const rowCount = Math.max(1, ...rows.map((r) => r + 1));
		const contentH = rowCount * pitch - (pitch - markH);
		const height = Math.max(strip ? 36 : G.minLaneH, contentH + G.lanePad * 2);
		const contentTop = y + (height - contentH) / 2;

		const lane: Lane = {
			kind: group.kind,
			key: group.key,
			phase: group.phase,
			title:
				group.kind === "locations" ? "Where" :
				group.kind === "keydates" ? "Key dates" :
				group.kind === "journal" ? "Journal" :
				group.kind === "unassigned" ? "Other" : group.phase!.name,
			subtitle: laneSubtitle(group.kind, group.items, project),
			color: group.phase?.color,
			y,
			height,
			rows: rowCount,
			contentTop,
			pitch,
			markH,
		};
		lanes.push(lane);

		pre.forEach((p, i) => {
			const parent = p.mark.parentId ? project.items.find((it) => it.id === p.mark.parentId) : undefined;
			placed.push({
				kind: p.mark.kind,
				parentId: p.mark.parentId,
				state: p.mark.state,
				mood: p.mark.mood,
				item: p.item,
				lane,
				row: rows[i],
				startDay: p.s,
				endDay: p.e,
				x0: p.x0,
				x1: p.x1,
				cy: contentTop + rows[i] * pitch + markH / 2,
				color: group.phase?.color ?? (p.item.type === "location" ? null : phaseColor(p.item.phase ?? parent?.phase)),
				label: p.label,
				labelW: p.labelW,
				labelX: p.labelX,
				labelInside: p.labelInside,
				labelAnchor: p.labelAnchor,
			});
		});
		y += height;
	}

	return { viewStart, viewEnd, pxPerDay: ppd, width, headerH, bodyH: y, showWeeks, lanes, placed, xOf, dayAt };
}

function fromDayIso(day: number): string {
	return new Date(day * 86400000).toISOString().slice(0, 10);
}

function laneSubtitle(kind: LaneKind, items: GanttItem[], project: Project): string {
	if (kind === "journal") {
		const n = project.journal?.length ?? 0;
		return n ? `${n} entr${n === 1 ? "y" : "ies"}` : "Check-ins";
	}
	if (kind === "locations") return items.length ? `${items.length} ${items.length === 1 ? "place" : "places"}` : "Fieldwork, trips";
	if (kind === "keydates") {
		const d = items.filter((i) => i.type === "deadline").length;
		const e = items.length - d;
		if (!items.length) return "Deadlines & events";
		return [d && `${d} deadline${d === 1 ? "" : "s"}`, e && `${e} event${e === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
	}
	if (!items.length) return "Drag to add a task";
	let s = Infinity, e = -Infinity;
	for (const it of items) {
		const [a, b] = itemDays(it);
		s = Math.min(s, a);
		e = Math.max(e, b);
	}
	return `${items.length} item${items.length === 1 ? "" : "s"} · ${formatMonthSpan(s, e)}`;
}
