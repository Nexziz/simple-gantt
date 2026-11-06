import { formatDay, formatDistance, formatLength, toDay } from "./dates";
import { COMPACT, Geometry, Lane, Layout, Measure, PRINT_GEOMETRY, computeLayout, shortRange } from "./layout";
import { nextDeadline } from "./nudges";
import { PrintSettings, pageSize, printSettingsOf } from "./printSettings";
import { NS, PaintOptions, bufferPattern, formatPeriod, makeMeasure, nest, paintBody, paintHeader, paintLabels, svgEl, text } from "./render";
import { PRINT_THEME, Theme } from "./theme";
import { BufferPattern, Project, isDone } from "./types";
import { phaseWorkDays } from "./durations";

/** A4 landscape in CSS pixels at 96 dpi (297 × 210 mm), so text prints at its real size. */
export const A4_LANDSCAPE = { width: 1123, height: 794, widthPt: 841.89, heightPt: 595.28 };

export interface PrintOptions {
	today?: number;
	/** Draw the saved plan as dashed outlines. */
	compare?: boolean;
	theme?: Theme;
	/** Paper, spacing and what to show; defaults to the timeline's own saved settings. */
	settings?: PrintSettings;
}

/** Text and bar sizes for each text size; the largest row spacing to aim for at each spacing. */
const TEXT = { small: { font: 11, bar: 16 }, normal: { font: 12, bar: 17 }, large: { font: 13.5, bar: 19 } } as const;
const PITCH = { tight: [34, 26], normal: [46, 30], roomy: [56, 36] } as const;

/**
 * The timeline laid out for paper, as plain as possible: a title block, the chart (dates on milestones,
 * deadlines and tasks; each deadline's line running through every phase) and a table of the milestones.
 * Rows are spaced as generously as the sheet allows. When they don't fit on one sheet they continue on the
 * next, each page repeating the date header and the deadlines row.
 */
export function renderPrintPages(project: Project, opts: PrintOptions = {}): SVGSVGElement[] {
	const set = opts.settings ?? printSettingsOf(project.print);
	const theme = opts.theme ?? PRINT_THEME;
	const measure = makeMeasure(theme.font);
	const { w: W, h: H } = pageSize(set);
	const M = 28;
	const portrait = set.orientation === "portrait";
	const labelWidth = portrait ? 150 : 190;
	const timelineW = W - 2 * M - labelWidth;
	const title1 = 50, titleN = 26, gap = 14;
	const compare = !!(opts.compare && project.baseline);
	const today = set.today ? (opts.today ?? null) : null;

	// The tables under the chart (on the last page) take their share of the sheet first.
	const table = bottomTables(project, set, theme, measure, W - 2 * M, opts.today ?? null);
	const tableH = table ? table.height + gap : 0;
	const room = (titleH: number, headerH: number) => H - 2 * M - titleH - headerH - tableH;

	// Rows as roomy as the sheet allows, so the step from a bar to the next one (and its arrow) is easy to follow.
	const layoutOpts = {
		showEmptyLanes: false, measure, print: true,
		taskDates: set.taskDates, captions: set.captions, captionDates: set.captionDates, captionPlace: set.captionPlace, weeks: set.weeks ? undefined : false,
	};
	let layout = computeLayout(project, { ...layoutOpts, pxPerDay: 1, density: "print" });
	const days = layout.viewEnd - layout.viewStart + 1;
	const sized = (geometry: Geometry) => computeLayout(project, { ...layoutOpts, pxPerDay: timelineW / days, geometry });
	const t = TEXT[set.textSize];
	const base: Geometry = { ...COMPACT, fontSize: t.font, barH: t.bar, stripH: t.bar - 1, stripPitch: t.font * 2, lanePad: 6, minLaneH: 40, labelGap: 7, packGap: 10 };
	// The chart may be scaled down a little (text stays readable) to keep the rows roomy.
	const MIN_SCALE = 0.9;
	const chartRoom = H - 2 * M - title1 - tableH;
	const [most, least] = PITCH[set.spacing];
	let fits = false;
	for (let rowPitch = most; rowPitch >= least && !fits; rowPitch -= 1) {
		layout = sized({ ...base, rowPitch });
		fits = (layout.headerH + layout.bodyH) * MIN_SCALE <= chartRoom;
	}
	if (!fits) layout = sized({ ...PRINT_GEOMETRY, fontSize: Math.min(PRINT_GEOMETRY.fontSize, t.font) });
	// A plan that fits with room to spare gets more padding around each phase, so the chart fills the sheet.
	const spare = room(title1, layout.headerH) / layout.bodyH;
	if (fits && spare > 1.04) {
		const g = layout.g;
		const f = Math.min(2.5, 1 + (spare - 1) * (layout.bodyH / layout.lanes.reduce((n, l) => n + 2 * g.lanePad, 1)));
		const roomier = sized({ ...g, lanePad: g.lanePad * f, minLaneH: g.minLaneH * Math.min(f, 1.4) });
		if (roomier.bodyH <= room(title1, layout.headerH)) layout = roomier;
	}
	// Under each phase's name: how long its work takes, which stays true whenever the page is read.
	const laneNotes = new Map<string, string>();
	if (set.phaseDurations)
		for (const ph of project.phases) {
			const days = phaseWorkDays(project, ph.id);
			if (days) laneNotes.set(ph.id, `${formatLength(days, set.timeUnit)} of work`);
		}
	const paint: PaintOptions = {
		theme, measure, interactive: false, print: true, today, hideLinks: !set.arrows, shortLinksOnly: !set.longArrows,
		plan: compare ? project.baseline : null, laneNotes,
	};
	// A little too tall still fits on one sheet, slightly smaller; only much longer plans continue on a second page.
	const SHRINK = 0.85;

	// Split the rows into pages: the deadlines (Key dates) row on every page, then as many lanes as fit.
	const pages: Lane[][] = [];
	const total = layout.lanes.reduce((n, l) => n + l.height, 0);
	if ((layout.headerH + total) * SHRINK <= layout.headerH + room(title1, layout.headerH)) pages.push(layout.lanes);
	else {
		const pinned = layout.lanes.filter((l) => l.kind === "keydates");
		const pinnedH = pinned.reduce((n, l) => n + l.height, 0);
		let page: Lane[] = [...pinned];
		let used = pinnedH;
		for (const lane of layout.lanes.filter((l) => l.kind !== "keydates")) {
			const avail = room(pages.length ? titleN : title1, layout.headerH);
			if (page.length > pinned.length && used + lane.height > avail) {
				pages.push(page);
				page = [...pinned];
				used = pinnedH;
			}
			page.push(lane);
			used += lane.height;
		}
		pages.push(page);
	}

	const printed = formatDay(opts.today ?? toDay(project.start));
	return pages.map((lanes, i) => {
		const svg = svgEl("svg", { xmlns: NS, width: W, height: H, viewBox: `0 0 ${W} ${H}`, "font-family": theme.font });
		svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: theme.surface }, svg);
		const titleH = i === 0 ? title1 : titleN;
		const last = i === pages.length - 1;

		// Title block: the name and what it's about on the left; the period, the next deadline and the date on the right.
		const name = project.title || "Project timeline";
		if (i === 0) {
			text(svg, M, M + 12, name, { fill: theme.ink, "font-size": 20, "font-weight": 700 });
			const meta = set.subtitle ? [project.subtitle, project.author].filter(Boolean).join("  ·  ") : "";
			if (meta) text(svg, M, M + 33, meta, { fill: theme.inkSecondary, "font-size": 11.5 });
			text(svg, W - M, M + 12, formatPeriod(toDay(project.start), toDay(project.end)), { fill: theme.ink, "font-size": 13, "font-weight": 600, "text-anchor": "end" });
			// The next deadline and how far off it is, in red; then when this was printed.
			const next = set.countdown && opts.today != null ? nextDeadline(project, opts.today) : null;
			const rest = [compare ? `dashed outlines: the plan saved ${formatDay(toDay(project.baseline!.saved))}` : "", `updated ${printed}`].filter(Boolean).join("  ·  ");
			const line = text(svg, W - M, M + 33, next ? "" : rest[0].toUpperCase() + rest.slice(1), { fill: theme.inkMuted, "font-size": 10.5, "text-anchor": "end" });
			if (next) {
				svgEl("tspan", { fill: theme.deadline, "font-weight": 600 }, line).textContent = `${next.item.title} ${next.days === 0 ? "today" : `in ${formatDistance(next.days, set.timeUnit)}`}`;
				svgEl("tspan", {}, line).textContent = `  ·  ${rest}`;
			}
		} else {
			text(svg, M, M + 10, `${name} (continued)`, { fill: theme.ink, "font-size": 13, "font-weight": 600 });
		}

		// Chart: the header, the phases and the deadlines' lines. Nothing the picture already says twice.
		const slice = sliceLayout(layout, lanes);
		const chartH = layout.headerH + slice.bodyH;
		const roomHere = H - 2 * M - titleH - (last ? tableH : 0);
		const scale = Math.min(1, roomHere / chartH);
		const chartW = labelWidth + layout.width;
		const chart = svgEl("g", { transform: `translate(${M + (chartW * (1 - scale)) / 2}, ${M + titleH}) scale(${scale})` }, svg);
		svgEl("rect", { x: 0, y: 0, width: labelWidth, height: layout.headerH, fill: theme.surface }, chart);
		svgEl("line", { x1: 0, x2: labelWidth, y1: layout.headerH - 0.5, y2: layout.headerH - 0.5, stroke: theme.axis }, chart);
		svgEl("line", { x1: labelWidth - 0.5, x2: labelWidth - 0.5, y1: 0, y2: layout.headerH, stroke: theme.axis }, chart);
		nest(chart, paintHeader(layout, paint), labelWidth, 0);
		nest(chart, paintLabels(slice, labelWidth, paint), 0, layout.headerH);
		nest(chart, paintBody(slice, paint), labelWidth, layout.headerH);
		svgEl("rect", { x: 0.5, y: 0.5, width: chartW - 1, height: chartH - 1, rx: 6, fill: "none", stroke: theme.axis }, chart);

		// The tables, right under the chart.
		if (last && table) {
			table.node.setAttribute("transform", `translate(${M}, ${M + titleH + chartH * scale + gap})`);
			svg.appendChild(table.node);
		}
		if (pages.length > 1) text(svg, W - M, H - M / 2, `Page ${i + 1} of ${pages.length}`, { fill: theme.inkMuted, "font-size": 8.5, "text-anchor": "end" });
		return svg;
	});
}

/** The milestone table and the vacations-and-buffers table, side by side when there are both. */
function bottomTables(project: Project, set: PrintSettings, theme: Theme, measure: Measure, width: number, today: number | null): { node: SVGGElement; height: number } | null {
	const breaks = set.bufferTable ? bufferRows(project, theme) : [];
	const hasMilestones = set.milestoneTable && project.items.some((i) => !i.dropped && (i.type === "milestone" || (set.tableDeadlines && i.type === "deadline")));
	const sideW = breaks.length && hasMilestones ? Math.round(Math.min(400, Math.max(320, width * 0.36))) : width;
	const gapX = 28;
	const left = hasMilestones ? milestoneTable(project, set, theme, measure, breaks.length ? width - sideW - gapX : width, today) : null;
	const right = breaks.length ? bufferTable(breaks, set, theme, measure, left ? sideW : width) : null;
	if (!left && !right) return null;
	const g = svgEl("g", {});
	if (left) g.appendChild(left.node);
	if (right) {
		if (left) right.node.setAttribute("transform", `translate(${width - sideW}, 0)`);
		g.appendChild(right.node);
	}
	return { node: g, height: Math.max(left?.height ?? 0, right?.height ?? 0) };
}

interface BreakRow {
	title: string;
	s: number;
	e: number;
	color: string;
	pattern: BufferPattern;
}

/** Each vacation and buffer once (the same break on several rows is listed once), earliest first. */
function bufferRows(project: Project, theme: Theme): BreakRow[] {
	const rows = new Map<string, BreakRow & { colors: Set<string> }>();
	for (const it of project.items) {
		if (it.type !== "task" || !it.buffer || it.dropped) continue;
		const s = toDay(it.start), e = it.end ? toDay(it.end) : s;
		const key = `${it.title.trim().toLowerCase()}|${s}|${e}`;
		const color = theme.palette[project.phases.find((p) => p.id === it.phase)?.color ?? "blue"];
		const row = rows.get(key);
		if (row) row.colors.add(color);
		else rows.set(key, { title: it.title, s, e, color, pattern: it.pattern ?? "diagonal", colors: new Set([color]) });
	}
	// One that runs through several phases is shown in a neutral colour.
	return [...rows.values()]
		.map(({ colors, ...r }) => ({ ...r, color: colors.size > 1 ? theme.inkSecondary : r.color }))
		.sort((a, b) => a.s - b.s || a.title.localeCompare(b.title));
}

let tableIds = 0;

/** The vacations and buffers, in columns like the milestones: pattern, dates, name and how long. */
function bufferTable(rows: BreakRow[], set: PrintSettings, theme: Theme, measure: Measure, width: number): { node: SVGGElement; height: number } {
	const fs = TEXT[set.textSize].font - 1;
	const rowH = Math.round(fs * 1.75);
	const cols = Math.max(1, Math.min(rows.length, Math.floor(width / 320), 3));
	const perCol = Math.ceil(rows.length / cols);
	const colW = width / cols;
	const headH = 22;
	const g = svgEl("g", {});
	const defs = svgEl("defs", {}, g);
	text(g, 0, 8, "VACATIONS AND BUFFERS", { fill: theme.inkMuted, "font-size": 9.5, "font-weight": 700, "letter-spacing": "0.08em" });
	// Says what the number on the right is: how long the break lasts.
	for (let c = 0; c < cols; c++) text(g, c * colW + colW - 16, 8, "LENGTH", columnHead(theme));
	svgEl("line", { x1: 0, x2: width, y1: 17.5, y2: 17.5, stroke: theme.axis }, g);
	const swatchW = 24;
	const dateW = Math.max(...rows.map((r) => measure(shortRange(r.s, r.e), 600, fs))) + 12;
	rows.forEach((r, k) => {
		const col = Math.floor(k / perCol), row = k % perCol;
		const x = col * colW, y = headH + row * rowH + rowH / 2;
		const id = `sg-break-${++tableIds}`;
		bufferPattern(defs, id, r.color, r.pattern);
		svgEl("rect", { x: x + 0.5, y: y - 5.5, width: swatchW, height: 11, rx: 3, fill: theme.surface }, g);
		svgEl("rect", { x: x + 0.5, y: y - 5.5, width: swatchW, height: 11, rx: 3, fill: `url(#${id})`, stroke: r.color, "stroke-opacity": 0.8 }, g);
		const dx = x + swatchW + 10;
		text(g, dx, y, shortRange(r.s, r.e), { fill: theme.ink, "font-size": fs, "font-weight": 600 });
		const length = formatLength(r.e - r.s + 1, set.timeUnit);
		const lengthW = measure(length, 400, fs - 0.5);
		const nameX = dx + dateW;
		text(g, nameX, y, fit(r.title, colW - (nameX - x) - lengthW - 22, measure, 500, fs), { fill: theme.ink, "font-size": fs, "font-weight": 500 });
		text(g, x + colW - 16, y, length, { fill: theme.inkMuted, "font-size": fs - 0.5, "text-anchor": "end" });
		if (row < perCol - 1 && k < rows.length - 1)
			svgEl("line", { x1: x, x2: x + colW - 16, y1: y + rowH / 2, y2: y + rowH / 2, stroke: theme.grid }, g);
	});
	return { node: g, height: headH + perCol * rowH };
}

/**
 * The milestones (and, if chosen, the deadlines) earliest first, in columns that read down then across:
 * each with its marker in the phase colour, its date, its name and how far off it is.
 */
function milestoneTable(project: Project, set: PrintSettings, theme: Theme, measure: Measure, width: number, today: number | null): { node: SVGGElement; height: number } | null {
	const items = project.items
		.filter((i) => !i.dropped && (i.type === "milestone" || (set.tableDeadlines && i.type === "deadline")))
		.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
	if (!items.length) return null;
	const fs = TEXT[set.textSize].font - 1;
	const rowH = Math.round(fs * 1.75);
	const cols = Math.max(1, Math.min(items.length, Math.floor(width / 300), 3));
	const perCol = Math.ceil(items.length / cols);
	const colW = width / cols;
	const headH = 22;
	const g = svgEl("g", {});
	const heading = set.tableDeadlines ? "MILESTONES AND DEADLINES" : "MILESTONES";
	text(g, 0, 8, heading, { fill: theme.inkMuted, "font-size": 9.5, "font-weight": 700, "letter-spacing": "0.08em" });
	// Says what the number on the right is: how far off it is from the day this was printed (not how long anything takes).
	if (today != null && set.milestoneCountdown) for (let c = 0; c < cols; c++) text(g, c * colW + colW - 16, 8, `FROM ${formatDay(today, false).toUpperCase()}`, columnHead(theme));
	svgEl("line", { x1: 0, x2: width, y1: 17.5, y2: 17.5, stroke: theme.axis }, g);
	const dateW = measure("30 Sep", 600, fs) + 10;
	items.forEach((it, k) => {
		const col = Math.floor(k / perCol), row = k % perCol;
		const x = col * colW, y = headH + row * rowH + rowH / 2;
		const day = toDay(it.start);
		const color = it.type === "deadline" ? theme.deadline : theme.palette[project.phases.find((p) => p.id === it.phase)?.color ?? "blue"];
		if (it.type === "deadline") {
			svgEl("line", { x1: x + 4, x2: x + 4, y1: y - 6, y2: y + 6, stroke: color, "stroke-width": 1.6, "stroke-linecap": "round" }, g);
			svgEl("path", { d: `M${x + 4.5},${y - 6} L${x + 12},${y - 3} L${x + 4.5},${y} Z`, fill: color }, g);
		} else {
			const r = 5.5;
			svgEl("path", { d: `M${x + 6},${y - r} L${x + 6 + r},${y} L${x + 6},${y + r} L${x + 6 - r},${y} Z`, fill: color, stroke: theme.ink, "stroke-width": 1, "stroke-linejoin": "round" }, g);
		}
		text(g, x + 18, y, formatDay(day, false), { fill: theme.ink, "font-size": fs, "font-weight": 600 });
		// How far off it is, only when chosen (it goes out of date); that it's done is always worth saying.
		let status = "", statusColor = theme.inkMuted;
		if (isDone(it)) [status, statusColor] = ["✓ done", "#1baf7a"];
		else if (today != null && set.milestoneCountdown) {
			const d = day - today;
			status = d === 0 ? "today" : d > 0 ? `in ${formatDistance(d, set.timeUnit)}` : `${formatDistance(-d, set.timeUnit)} ago`;
			if (d < 0) statusColor = theme.deadline;
		}
		const statusW = status ? measure(status, 400, fs - 0.5) : 0;
		const nameX = x + 18 + dateW;
		const nameMax = colW - (nameX - x) - statusW - 22;
		text(g, nameX, y, fit(it.title, nameMax, measure, it.type === "deadline" ? 600 : 500, fs), {
			fill: it.type === "deadline" ? theme.deadline : theme.ink, "font-size": fs, "font-weight": it.type === "deadline" ? 600 : 500,
		});
		if (status) text(g, x + colW - 16, y, status, { fill: statusColor, "font-size": fs - 0.5, "text-anchor": "end" });
		if (row < perCol - 1 && k < items.length - 1)
			svgEl("line", { x1: x, x2: x + colW - 16, y1: y + rowH / 2, y2: y + rowH / 2, stroke: theme.grid }, g);
	});
	return { node: g, height: headH + perCol * rowH };
}

/** A small heading over a table's right-hand column. */
function columnHead(theme: Theme) {
	return { fill: theme.inkMuted, "font-size": 8.5, "font-weight": 700, "letter-spacing": "0.06em", "text-anchor": "end" } as const;
}

function fit(s: string, max: number, measure: Measure, weight: number, size: number): string {
	if (measure(s, weight, size) <= max) return s;
	let lo = 0, hi = s.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (measure(s.slice(0, mid).trimEnd() + "…", weight, size) <= max) lo = mid;
		else hi = mid - 1;
	}
	return s.slice(0, lo).trimEnd() + "…";
}

/** The same layout with only some lanes, stacked from the top. */
function sliceLayout(layout: Layout, lanes: Lane[]): Layout {
	if (lanes.length === layout.lanes.length && lanes.every((l, i) => l === layout.lanes[i])) return layout;
	const map = new Map<Lane, Lane>();
	let y = 0;
	for (const l of lanes) {
		map.set(l, { ...l, y, contentTop: l.contentTop - l.y + y });
		y += l.height;
	}
	const placed = layout.placed
		.filter((p) => map.has(p.lane))
		.map((p) => {
			const lane = map.get(p.lane)!;
			return { ...p, lane, cy: p.cy - p.lane.y + lane.y };
		});
	return { ...layout, lanes: lanes.map((l) => map.get(l)!), placed, bodyH: y };
}
