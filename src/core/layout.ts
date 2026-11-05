import { formatDay, formatMonthSpan, monthEnd, monthStart, toDay } from "./dates";
import { SlotState, slotStates } from "./journal";
import { Feature, isOn } from "./features";
import { ColorName, GanttItem, Mood, Phase, Project, isDone } from "./types";

/** Geometry, in CSS pixels. Comfortable is the default; Compact fits more on screen. */
export const G = {
	yearRowH: 24,
	monthRowH: 30,
	weekRowH: 22,
	rowPitch: 44,
	barH: 24,
	stripPitch: 30,
	stripH: 22,
	lanePad: 14,
	minLaneH: 62,
	labelGap: 8,
	packGap: 16,
	fontSize: 12.5,
};

export type Geometry = typeof G;
export type Density = "comfortable" | "compact" | "print";

export const COMPACT: Geometry = {
	yearRowH: 22,
	monthRowH: 26,
	weekRowH: 20,
	rowPitch: 32,
	barH: 20,
	stripPitch: 24,
	stripH: 18,
	lanePad: 10,
	minLaneH: 48,
	labelGap: 6,
	packGap: 8,
	fontSize: 12,
};

/** For A4 paper: tight rows, text around 8.5 pt. */
export const PRINT_GEOMETRY: Geometry = {
	yearRowH: 20,
	monthRowH: 24,
	weekRowH: 18,
	rowPitch: 23,
	barH: 17,
	stripPitch: 20,
	stripH: 16,
	lanePad: 6,
	minLaneH: 34,
	labelGap: 6,
	packGap: 8,
	fontSize: 11.5,
};

/** The longest start of `text` (ending in "…") that fits `max` pixels. */
function shorten(text: string, max: number, width: (t: string) => number): string {
	if (width(text) <= max) return text;
	let lo = 0, hi = text.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (width(text.slice(0, mid).trimEnd() + "…") <= max) lo = mid;
		else hi = mid - 1;
	}
	return lo ? text.slice(0, lo).trimEnd() + "…" : "";
}

/** Space between a label and its grey note. */
export const NOTE_GAP = 6;

/** "10 Nov – 18 Dec", "3–14 May": dates without the year (the date header shows it). */
export function shortRange(s: number, e: number): string {
	if (s === e) return formatDay(s, false);
	const a = formatDay(s, false), b = formatDay(e, false);
	const [ad, am] = a.split(" "), [bd, bm] = b.split(" ");
	return am === bm ? `${ad}–${bd} ${bm}` : `${a} – ${b}`;
}

/** Horizontal padding inside a milestone's label badge. */
export const MILESTONE_BADGE_PAD = 9;

export function geometry(density?: Density): Geometry {
	return density === "compact" ? COMPACT : density === "print" ? PRINT_GEOMETRY : G;
}

export type LaneKind = "locations" | "keydates" | "journal" | "phase" | "unassigned";

/**
 * What a placed mark represents:
 *  item     – a real item from the project
 *  ghost    – the dashed alternative of an item's Plan B
 *  decision – the Plan B decision date, shown among the key dates
 *  entry    – a journal entry
 *  slot     – a check-in date with no entry (due, missed or upcoming)
 *  summary  – the single bar a collapsed phase folds into
 */
export type MarkKind = "item" | "ghost" | "decision" | "entry" | "slot" | "summary";

interface Mark {
	kind: MarkKind;
	item: GanttItem;
	parentId?: string;
	state?: SlotState | "pending";
	mood?: Mood;
	progress?: number;
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
	collapsed?: boolean;
}

export interface Placed {
	kind: MarkKind;
	/** The real item, or a stand-in for derived marks. */
	item: GanttItem;
	/** For ghosts and decisions: the item that owns the Plan B. */
	parentId?: string;
	state?: SlotState | "pending";
	mood?: Mood;
	/** Summary bars: share of the phase that's done, 0–100. */
	progress?: number;
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
	/** Extra detail after the label in small grey text (on paper: a task's dates). Included in labelW. */
	note?: string;
	/** A buffer drawn on its task's row: the task's id. Its label sits above it. */
	attachedTo?: string;
	/** Ends that join another bar (a buffer and its task) are drawn square. */
	squareLeft?: boolean;
	squareRight?: boolean;
}

export interface Layout {
	/** The geometry this layout was computed with. */
	g: Geometry;
	/** Whether an optional feature is switched on for this project. */
	on: (f: Feature) => boolean;
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
	density?: Density;
	/** Exact spacing to use instead of a density (print stretches rows to fill the page). */
	geometry?: Geometry;
	measure: (text: string, weight?: number, size?: number) => number;
	/** Add the date to milestone, deadline and key date labels (print): "Chapter 2 drafted · 15 Jan". */
	datedLabels?: boolean;
	/** Leave out phases with nothing in them (print and exports). */
	hideEmptyPhases?: boolean;
	/**
	 * Paper: dated labels, no empty phases, milestone labels without badges, and a Plan B's decision date in its
	 * dashed bar's label instead of a separate marker.
	 */
	print?: boolean;
	/** Paper: a task's dates after its name (default on). */
	taskDates?: boolean;
	/** The names of buffers and Plan Bs drawn above their task (default on). */
	captions?: boolean;
	/** Show the week row in the date header; by default it shows when there's room. */
	weeks?: boolean;
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
function pack(intervals: [number, number][], gap: number): number[] {
	const rowEnds: number[] = [];
	return intervals.map(([from, to]) => {
		let row = rowEnds.findIndex((end) => end + gap <= from);
		if (row === -1) {
			row = rowEnds.length;
			rowEnds.push(to);
		} else rowEnds[row] = to;
		return row;
	});
}

export function computeLayout(project: Project, opts: LayoutOptions): Layout {
	const g = opts.geometry ?? geometry(opts.density ?? project.density);
	const [viewStart, viewEnd] = viewRange(project);
	const ppd = opts.pxPerDay;
	const width = (viewEnd - viewStart + 1) * ppd;
	const xOf = (day: number) => (day - viewStart) * ppd;
	const dayAt = (x: number) => viewStart + Math.floor(x / ppd);
	const showWeeks = opts.weeks ?? ppd >= 4.5;
	const headerH = g.yearRowH + g.monthRowH + (showWeeks ? g.weekRowH : 0);

	const phaseIds = new Set(project.phases.map((p) => p.id));
	const today = opts.today ?? toDay(new Date().toISOString().slice(0, 10));
	const on = (f: Feature) => isOn(project, f);
	const asMarks = (items: GanttItem[]): Mark[] => items.map((item) => ({ kind: "item", item }));

	// Plan B: a pending contingency adds a decision point and, when it has dates, a ghost bar.
	const print = !!opts.print;
	const ghosts: Mark[] = [];
	const decisions: Mark[] = [];
	for (const it of project.items) {
		const pb = it.planB;
		if (!on("planb") || !pb || pb.status || isDone(it) || it.dropped) continue;
		if (!(print && pb.start)) decisions.push({
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
					id: `${it.id}~planb`, type: "task",
					title: print ? `Plan B, decide by ${formatDay(toDay(pb.by), false)} · ${pb.title || "Alternative"}` : `Plan B · ${pb.title || "Alternative"}`,
					start: pb.start, end: pb.end ?? pb.start, phase: it.phase,
				},
			});
	}

	const groups: { kind: LaneKind; key: string; phase?: Phase; marks: Mark[]; items: GanttItem[]; collapsed?: boolean }[] = [];
	const locations = on("locations") ? project.items.filter((i) => i.type === "location") : [];
	const keyDates = project.items.filter((i) => (i.type === "event" && on("events")) || i.type === "deadline");
	if (on("locations") && (locations.length || opts.showEmptyLanes)) groups.push({ kind: "locations", key: "locations", items: locations, marks: asMarks(locations) });
	if (keyDates.length || decisions.length || opts.showEmptyLanes)
		groups.push({ kind: "keydates", key: "keydates", items: keyDates, marks: [...asMarks(keyDates), ...decisions] });
	if (opts.showJournal && on("journal") && (project.checkin || project.journal?.length)) {
		const marks: Mark[] = [];
		let shownFuture = false;
		for (const slot of slotStates(project, today)) {
			if (slot.state === "done" || slot.state === "skipped") continue;
			// Only the next upcoming check-in is drawn, so the row stays quiet.
			if (slot.state === "future") {
				if (shownFuture) continue;
				shownFuture = true;
			}
			marks.push({ kind: "slot", state: slot.state, item: { id: `slot~${slot.day}`, type: "event", title: "Check-in", start: fromDayIso(slot.day) } });
		}
		for (const e of project.journal ?? [])
			marks.push({ kind: "entry", mood: e.mood, item: { id: `journal~${e.id}`, type: "event", title: e.text, start: e.date } });
		groups.push({ kind: "journal", key: "journal", items: [], marks });
	}
	const inPhase = (i: GanttItem) => i.type === "task" || i.type === "milestone";
	for (const phase of project.phases) {
		const items = project.items.filter((i) => inPhase(i) && i.phase === phase.id);
		if ((opts.hideEmptyPhases || print) && !items.length && !ghosts.some((g) => g.item.phase === phase.id)) continue;
		if (phase.collapsed) {
			groups.push({ kind: "phase", key: phase.id, phase, items, collapsed: true, marks: summaryMarks(phase, items, on("progress")) });
			continue;
		}
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
		const pitch = strip ? g.stripPitch : g.rowPitch;
		const markH = strip ? g.stripH : g.barH;
		const journal = group.kind === "journal";
		// The journal lane and collapsed phases are one flat row; milestones there go unlabelled (tooltips still work).
		const flat = journal || !!group.collapsed;

		const sorted = [...group.marks].sort((ma, mb) => {
			if (ma.kind === "summary" || mb.kind === "summary") return ma.kind === "summary" ? -1 : 1;
			const [as, ae] = itemDays(ma.item);
			const [bs, be] = itemDays(mb.item);
			return as - bs || be - bs - (ae - as) || ma.item.title.localeCompare(mb.item.title);
		});

		// Horizontal geometry first; rows come from packing the full footprint (mark + outside label).
		const pre = sorted.map((mark) => {
			const item = mark.item;
			const [s, e] = itemDays(item);
			const done = mark.kind === "item" && isDone(item);
			const dated = (opts.datedLabels || print) && mark.kind === "item" && (item.type === "milestone" || item.type === "deadline" || item.type === "event");
			let label = journal || (flat && mark.kind !== "summary") ? "" : (done ? "✓ " : "") + (item.title || "Untitled") + (dated ? ` · ${formatDay(s, false)}` : "");
			const badge = item.type === "milestone" && !!label && !print;
			const weight = item.type === "deadline" || item.type === "location" || badge ? 600 : 500;
			// On paper a task's dates follow its name in small grey text (there's no hovering on paper).
			let note = print && opts.taskDates !== false && label && mark.kind === "item" && item.type === "task" && !item.buffer ? shortRange(s, e) : "";
			// Milestone labels sit in a tinted badge: reserve its padding.
			const widthOf = (text: string, withNote: string) => text
				? opts.measure(text, weight, g.fontSize) + (badge ? MILESTONE_BADGE_PAD * 2 : 0) + (withNote ? NOTE_GAP + opts.measure(withNote, 400, g.fontSize - 1.5) : 0)
				: 0;
			let labelW = widthOf(label, note);
			let x0: number, x1: number, labelX: number, labelInside = false, labelAnchor: "start" | "end" = "start";
			if (item.type === "task" || item.type === "location") {
				x0 = xOf(s);
				x1 = Math.max(x0 + 3, xOf(e + 1));
				const pad = item.type === "location" ? 24 : 14;
				if (labelW + pad <= x1 - x0) {
					labelInside = true;
					labelX = x0 + (item.type === "location" ? 20 : 7);
				} else labelX = x1 + g.labelGap;
			} else {
				const cx = xOf(s) + ppd / 2;
				const r = item.type === "milestone" ? 9 : 6;
				x0 = cx - r;
				x1 = cx + r;
				labelX = x1 + g.labelGap;
			}
			if (!labelInside && label) {
				// Beside the mark, on whichever side has room. A label never runs off the chart: if it fits neither
				// side, its grey date goes first, and only then is the name shortened (on the roomier side).
				const roomRight = width - (x1 + g.labelGap) - 4;
				const roomLeft = x0 - g.labelGap - 4;
				if (labelW > roomRight && labelW > roomLeft && note) {
					note = "";
					labelW = widthOf(label, "");
				}
				const left = labelW > roomRight && (labelW <= roomLeft || roomLeft > roomRight);
				const room = left ? roomLeft : roomRight;
				if (labelW > room) {
					label = shorten(label, Math.max(0, room - (badge ? MILESTONE_BADGE_PAD * 2 : 0)), (t) => opts.measure(t, weight, g.fontSize));
					labelW = widthOf(label, "");
				}
				if (left) {
					labelAnchor = "end";
					labelX = x0 - g.labelGap;
				}
			}
			const from = labelInside ? x0 : Math.min(x0, labelAnchor === "end" ? labelX - labelW : x0);
			const to = labelInside ? x1 : Math.max(x1, labelAnchor === "start" ? labelX + labelW : x1);
			return { mark, item, s, e, label, note, labelW, x0, x1, labelX, labelInside, labelAnchor, from, to };
		});
		// Buffer time sits on the row of the task it belongs to (one it overlaps, or follows within a week),
		// joined to the bar like an extension of it, with its name above. A Plan B that runs past the end of
		// its task is drawn the same way: a dashed extension of the bar.
		const hostOf = new Map<number, number>();
		const isTask = (q: (typeof pre)[number]) => q.mark.kind === "item" && q.item.type === "task" && !q.item.dropped;
		if (!strip && !flat) {
			pre.forEach((b, i) => {
				if (b.mark.kind !== "ghost") return;
				const j = pre.findIndex((t) => isTask(t) && t.item.id === b.mark.parentId);
				// Only when it carries on from the task (overlaps it or starts within a week of its end).
				if (j >= 0 && b.e > pre[j].e && b.s - pre[j].e <= 7) hostOf.set(i, j);
			});
			pre.forEach((b, i) => {
				if (!isTask(b) || !b.item.buffer) return;
				let best = -1, bestScore = Infinity;
				pre.forEach((t, j) => {
					if (!isTask(t) || t.item.buffer) return;
					const overlaps = b.s <= t.e && b.e >= t.s;
					const follows = b.s > t.e && b.s - t.e <= 7;
					if (!overlaps && !follows) return;
					const score = (b.item.after?.includes(t.item.id) ? 0 : 1000) + (overlaps ? 0 : b.s - t.e);
					if (score < bestScore) [best, bestScore] = [j, score];
				});
				if (best >= 0) hostOf.set(i, best);
			});
			const labelSize = g.fontSize - 1.5;
			for (const [i, j] of hostOf) {
				const b = pre[i], t = pre[j];
				// On paper a buffer's caption says when it is; captions can be switched off.
				if (opts.captions === false) b.label = "";
				else if (print && b.label && b.mark.kind === "item") b.label = `${b.label} · ${shortRange(b.s, b.e)}`;
				b.labelW = b.label ? opts.measure(b.label, 500, labelSize) : 0;
				b.labelInside = false;
				// Over the part that shows: a Plan B under its task only shows past the task's end.
				const shown = b.mark.kind === "ghost" ? Math.max(b.x0, t.x1) : b.x0;
				b.labelAnchor = shown + b.labelW + 2 > width ? "end" : "start";
				b.labelX = b.labelAnchor === "end" ? b.x1 : shown + 1;
				b.from = Math.min(t.from, b.x0);
				b.to = b.x1;
				// The task's own label moves past the buffer (or out of the bar, if the buffer covers it).
				const end = Math.max(t.x1, b.x1);
				const covered = t.labelInside && t.labelX + t.labelW > b.x0 && t.labelX < b.x1;
				if (!t.labelInside || covered) {
					t.labelInside = false;
					t.labelAnchor = end + g.labelGap + t.labelW + 4 > width ? "end" : "start";
					t.labelX = t.labelAnchor === "end" ? t.x0 - g.labelGap : end + g.labelGap;
				}
				t.from = Math.min(t.from, b.x0, t.labelAnchor === "end" && !t.labelInside ? t.labelX - t.labelW : t.from);
				t.to = Math.max(t.to, b.x1, t.labelAnchor === "start" && !t.labelInside ? t.labelX + t.labelW : t.to);
			}
		}

		// The journal lane is a single row of small markers; everything else is packed (buffers ride with their task).
		const packed = pre.map((_, i) => i).filter((i) => !hostOf.has(i));
		const packedRows = flat ? packed.map(() => 0) : pack(packed.map((i) => [pre[i].from, pre[i].to]), g.packGap);
		const rows: number[] = [];
		packed.forEach((i, k) => (rows[i] = packedRows[k]));
		for (const [i, j] of hostOf) rows[i] = rows[j];
		const rowCount = Math.max(1, ...rows.map((r) => r + 1));
		// Rows with a buffer's name above them get a little headroom for it.
		const headroom = Math.round(g.fontSize + 1);
		const rowTop: number[] = [];
		for (let r = 0, extra = 0; r < rowCount; r++) {
			if ([...hostOf.keys()].some((i) => rows[i] === r && pre[i].label)) extra += headroom;
			rowTop[r] = r * pitch + extra;
		}
		const contentH = rowTop[rowCount - 1] + markH;
		const height = Math.max(strip ? 36 : group.collapsed ? g.minLaneH - 12 : g.minLaneH, contentH + g.lanePad * 2);
		const contentTop = y + (height - contentH) / 2;

		const lane: Lane = {
			kind: group.kind,
			key: group.key,
			phase: group.phase,
			title:
				group.kind === "locations" ? "Where" :
				group.kind === "keydates" ? (print && group.marks.every((m) => m.kind === "item" && m.item.type === "deadline") ? "Deadlines" : "Key dates") :
				group.kind === "journal" ? "Journal" :
				group.kind === "unassigned" ? "Other" : group.phase!.name,
			subtitle: group.collapsed ? `Folded · ${group.items.length} item${group.items.length === 1 ? "" : "s"}` : laneSubtitle(group.kind, group.items, project),
			collapsed: group.collapsed,
			color: group.phase?.color,
			y,
			height,
			rows: rowCount,
			contentTop,
			pitch,
			markH,
		};
		lanes.push(lane);

		/** How a buffer and its task join: square ends where they touch. */
		const joins = (i: number): Partial<Placed> => {
			const j = hostOf.get(i);
			if (j !== undefined) {
				const b = pre[i], t = pre[j];
				return { attachedTo: t.item.id, squareLeft: b.s <= t.e + 1, squareRight: b.e < t.e };
			}
			// The task's end is square where something continues it.
			const continued = [...hostOf].some(([bi, tj]) => tj === i && pre[bi].s <= pre[i].e + 1 && pre[bi].e > pre[i].e);
			return continued ? { squareRight: true } : {};
		};

		pre.forEach((p, i) => {
			const parent = p.mark.parentId ? project.items.find((it) => it.id === p.mark.parentId) : undefined;
			placed.push({
				kind: p.mark.kind,
				parentId: p.mark.parentId,
				state: p.mark.state,
				mood: p.mark.mood,
				progress: p.mark.progress,
				item: p.item,
				lane,
				row: rows[i],
				startDay: p.s,
				endDay: p.e,
				x0: p.x0,
				x1: p.x1,
				cy: contentTop + rowTop[rows[i]] + markH / 2,
				color: group.phase?.color ?? (p.item.type === "location" ? null : phaseColor(p.item.phase ?? parent?.phase)),
				label: p.label,
				note: p.note || undefined,
				labelW: p.labelW,
				labelX: p.labelX,
				labelInside: p.labelInside,
				labelAnchor: p.labelAnchor,
				...joins(i),
			});
		});
		y += height;
	}

	return { g, on, viewStart, viewEnd, pxPerDay: ppd, width, headerH, bodyH: y, showWeeks, lanes, placed, xOf, dayAt };
}

/** A collapsed phase: one bar over its whole span (with overall progress) plus its milestones. */
function summaryMarks(phase: Phase, items: GanttItem[], showProgress: boolean): Mark[] {
	const live = items.filter((i) => !i.dropped);
	if (!live.length) return [];
	let s = Infinity, e = -Infinity, total = 0, done = 0;
	for (const it of live) {
		const [a, b] = itemDays(it);
		s = Math.min(s, a);
		e = Math.max(e, b);
		const w = it.type === "task" ? b - a + 1 : 7;
		total += w;
		done += w * (isDone(it) ? 1 : it.type === "task" ? (it.progress ?? 0) / 100 : 0);
	}
	const progress = total ? Math.round((done / total) * 100) : 0;
	const tasks = live.filter((i) => i.type === "task").length;
	const summary: Mark = {
		kind: "summary",
		progress: showProgress ? progress : 0,
		item: {
			id: `phase~${phase.id}`, type: "task", phase: phase.id, start: fromDayIso(s), end: fromDayIso(e),
			title: `${tasks} task${tasks === 1 ? "" : "s"}${showProgress ? ` · ${progress}% done` : ""}`,
		},
	};
	return [summary, ...live.filter((i) => i.type === "milestone").map((item): Mark => ({ kind: "item", item }))];
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
	if (!items.length) return "No tasks yet";
	let s = Infinity, e = -Infinity;
	for (const it of items) {
		const [a, b] = itemDays(it);
		s = Math.min(s, a);
		e = Math.max(e, b);
	}
	return `${items.length} item${items.length === 1 ? "" : "s"} · ${formatMonthSpan(s, e)}`;
}
