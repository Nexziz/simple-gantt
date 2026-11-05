import { formatDay, toDay } from "./dates";
import { COMPACT, Geometry, Lane, Layout, PRINT_GEOMETRY, computeLayout } from "./layout";
import { NS, PaintOptions, formatPeriod, makeMeasure, nest, paintBody, paintHeader, paintLabels, svgEl, text } from "./render";
import { PRINT_THEME, Theme } from "./theme";
import type { Project } from "./types";

/** A4 landscape in CSS pixels at 96 dpi (297 × 210 mm), so text prints at its real size. */
export const A4_LANDSCAPE = { width: 1123, height: 794, widthPt: 841.89, heightPt: 595.28 };

export interface PrintOptions {
	today?: number;
	/** Draw the saved plan as dashed outlines. */
	compare?: boolean;
	theme?: Theme;
}

/**
 * The timeline laid out for A4 landscape paper, as plain as possible: a title block and the chart, with dates on
 * milestones and deadlines and each deadline's line running through every phase. No legend or summaries: the
 * picture explains itself. When the rows don't fit on one sheet they continue on the next, each page repeating
 * the date header and the deadlines row.
 */
export function renderPrintPages(project: Project, opts: PrintOptions = {}): SVGSVGElement[] {
	const theme = opts.theme ?? PRINT_THEME;
	const measure = makeMeasure(theme.font);
	const { width: W, height: H } = A4_LANDSCAPE;
	const M = 28;
	const labelWidth = 190;
	const timelineW = W - 2 * M - labelWidth;
	const title1 = 50, titleN = 26;
	const compare = !!(opts.compare && project.baseline);
	const room = (titleH: number, headerH: number) => H - 2 * M - titleH - headerH;
	// Rows as roomy as the sheet allows, so the step from a bar to the next one (and its arrow) is easy to follow.
	let layout = computeLayout(project, { pxPerDay: 1, showEmptyLanes: false, measure, density: "print", print: true });
	const days = layout.viewEnd - layout.viewStart + 1;
	const sized = (geometry: Geometry) => computeLayout(project, { pxPerDay: timelineW / days, showEmptyLanes: false, measure, geometry, print: true });
	const base: Geometry = { ...COMPACT, barH: 17, stripH: 16, stripPitch: 24, lanePad: 6, minLaneH: 40, labelGap: 7, packGap: 10 };
	// The chart may be scaled down a little (text stays readable) to keep the rows roomy.
	const MIN_SCALE = 0.9;
	const chartRoom = H - 2 * M - title1;
	let fits = false;
	for (let rowPitch = 48; rowPitch >= 30 && !fits; rowPitch -= 1) {
		layout = sized({ ...base, rowPitch });
		fits = (layout.headerH + layout.bodyH) * MIN_SCALE <= chartRoom;
	}
	if (!fits) layout = sized(PRINT_GEOMETRY);
	// A plan that fits with room to spare gets more padding around each phase, so the chart fills the sheet.
	const spare = room(title1, layout.headerH) / layout.bodyH;
	if (fits && spare > 1.04) {
		const g = layout.g;
		const f = Math.min(2.5, 1 + (spare - 1) * (layout.bodyH / layout.lanes.reduce((n, l) => n + 2 * g.lanePad, 1)));
		const roomier = sized({ ...g, lanePad: g.lanePad * f, minLaneH: g.minLaneH * Math.min(f, 1.4) });
		if (roomier.bodyH <= room(title1, layout.headerH)) layout = roomier;
	}
	// The Today line shows where the plan stands on the day it's printed.
	const paint: PaintOptions = { theme, measure, interactive: false, print: true, today: opts.today ?? null, plan: compare ? project.baseline : null };
	// A little too tall still fits on one sheet, slightly smaller; only much longer plans continue on a second page.
	const SHRINK = 0.85;

	// Split the rows into pages: the deadlines (Key dates) row on every page, then as many lanes as fit.
	const pages: Lane[][] = [];
	const total = layout.lanes.reduce((s, l) => s + l.height, 0);
	if ((layout.headerH + total) * SHRINK <= layout.headerH + room(title1, layout.headerH)) pages.push(layout.lanes);
	else {
		const pinned = layout.lanes.filter((l) => l.kind === "keydates");
		const pinnedH = pinned.reduce((s, l) => s + l.height, 0);
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

		// Title block
		const name = project.title || "Project timeline";
		if (i === 0) {
			text(svg, M, M + 12, name, { fill: theme.ink, "font-size": 20, "font-weight": 700 });
			const meta = [project.subtitle, project.author].filter(Boolean).join("  ·  ");
			if (meta) text(svg, M, M + 33, meta, { fill: theme.inkSecondary, "font-size": 11.5 });
			text(svg, W - M, M + 12, formatPeriod(toDay(project.start), toDay(project.end)), { fill: theme.ink, "font-size": 13, "font-weight": 600, "text-anchor": "end" });
			const note = compare ? `Dashed outlines: the plan saved ${formatDay(toDay(project.baseline!.saved))} · updated ${printed}` : `Updated ${printed}`;
			text(svg, W - M, M + 33, note, { fill: theme.inkMuted, "font-size": 10.5, "text-anchor": "end" });
		} else {
			text(svg, M, M + 10, `${name} (continued)`, { fill: theme.ink, "font-size": 13, "font-weight": 600 });
		}

		// Chart: the header, the phases and the deadlines' lines. Nothing the picture already says twice.
		const slice = sliceLayout(layout, lanes);
		const chartH = layout.headerH + slice.bodyH;
		const scale = Math.min(1, room(titleH, 0) / chartH);
		const chartW = labelWidth + layout.width;
		const chart = svgEl("g", { transform: `translate(${M + (chartW * (1 - scale)) / 2}, ${M + titleH}) scale(${scale})` }, svg);
		svgEl("rect", { x: 0, y: 0, width: labelWidth, height: layout.headerH, fill: theme.surface }, chart);
		svgEl("line", { x1: 0, x2: labelWidth, y1: layout.headerH - 0.5, y2: layout.headerH - 0.5, stroke: theme.axis }, chart);
		svgEl("line", { x1: labelWidth - 0.5, x2: labelWidth - 0.5, y1: 0, y2: layout.headerH, stroke: theme.axis }, chart);
		nest(chart, paintHeader(layout, paint), labelWidth, 0);
		nest(chart, paintLabels(slice, labelWidth, paint), 0, layout.headerH);
		nest(chart, paintBody(slice, paint), labelWidth, layout.headerH);
		svgEl("rect", { x: 0.5, y: 0.5, width: chartW - 1, height: chartH - 1, rx: 6, fill: "none", stroke: theme.axis }, chart);

		if (pages.length > 1) text(svg, W - M, H - M / 2, `Page ${i + 1} of ${pages.length}`, { fill: theme.inkMuted, "font-size": 8.5, "text-anchor": "end" });
		return svg;
	});
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
