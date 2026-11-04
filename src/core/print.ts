import { formatDay, toDay } from "./dates";
import { Lane, Layout, computeLayout } from "./layout";
import { NS, PaintOptions, bandBlock, buildLegend, formatPeriod, makeMeasure, nest, paintBody, paintDeadlineBand, paintHeader, paintLabels, svgEl, text } from "./render";
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
 * The timeline laid out for A4 landscape paper: a title block, the chart with compact rows and dates on
 * milestones and deadlines, a deadline band, a legend and a footer. When the rows don't fit on one sheet they
 * continue on the next, each page repeating the date header and the Key dates row.
 */
export function renderPrintPages(project: Project, opts: PrintOptions = {}): SVGSVGElement[] {
	const theme = opts.theme ?? PRINT_THEME;
	const measure = makeMeasure(theme.font);
	const { width: W, height: H } = A4_LANDSCAPE;
	const M = 28;
	const labelWidth = 190;
	const timelineW = W - 2 * M - labelWidth;
	const probe = computeLayout(project, { pxPerDay: 1, showEmptyLanes: false, measure, density: "print", hideEmptyPhases: true });
	const days = probe.viewEnd - probe.viewStart + 1;
	const layout = computeLayout(project, { pxPerDay: timelineW / days, showEmptyLanes: false, measure, density: "print", datedLabels: true, hideEmptyPhases: true });
	const paint: PaintOptions = { theme, measure, interactive: false, print: true, today: null, plan: opts.compare ? project.baseline : null };
	const band = paintDeadlineBand(layout, paint);
	const legend = () => buildLegend(project, theme, measure, W - 2 * M, !!(opts.compare && project.baseline), true);
	const legendH = legend().height;
	// The footer sits in the bottom margin, so it takes no room from the chart.
	const title1 = 50, titleN = 26, gap = 10;
	const room = (titleH: number) => H - 2 * M - titleH - layout.headerH - (band?.height ?? 0) - gap - legendH;
	// A little too tall still fits on one sheet, slightly smaller; only much longer plans continue on a second page.
	const SHRINK = 0.8;

	// Split the rows into pages: Key dates on every page, then as many lanes as fit.
	const pages: Lane[][] = [];
	const total = layout.lanes.reduce((s, l) => s + l.height, 0);
	const chrome = layout.headerH + (band?.height ?? 0);
	if (total <= room(title1) || (chrome + total) * SHRINK <= chrome + room(title1)) pages.push(layout.lanes);
	else {
		const pinned = layout.lanes.filter((l) => l.kind === "keydates");
		const pinnedH = pinned.reduce((s, l) => s + l.height, 0);
		let page: Lane[] = [...pinned];
		let used = pinnedH;
		for (const lane of layout.lanes.filter((l) => l.kind !== "keydates")) {
			const avail = room(pages.length ? titleN : title1);
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
			text(svg, W - M, M + 33, `Updated ${printed}`, { fill: theme.inkMuted, "font-size": 10.5, "text-anchor": "end" });
		} else {
			text(svg, M, M + 10, `${name} (continued)`, { fill: theme.ink, "font-size": 13, "font-weight": 600 });
		}

		// Chart
		const slice = sliceLayout(layout, lanes);
		const chartH = layout.headerH + slice.bodyH + (band?.height ?? 0);
		const avail = H - 2 * M - titleH - gap - legendH;
		const scale = Math.min(1, avail / chartH);
		const chartW = labelWidth + layout.width;
		const chart = svgEl("g", { transform: `translate(${M + (chartW * (1 - scale)) / 2}, ${M + titleH}) scale(${scale})` }, svg);
		const corner = svgEl("g", {}, chart);
		svgEl("rect", { x: 0, y: 0, width: labelWidth, height: layout.headerH, fill: theme.surface }, corner);
		text(corner, 14, layout.headerH - layout.g.monthRowH / 2 - (layout.showWeeks ? layout.g.weekRowH : 0), "PHASE", {
			fill: theme.inkMuted, "font-size": 9.5, "font-weight": 700, "letter-spacing": "0.08em",
		});
		svgEl("line", { x1: 0, x2: labelWidth, y1: layout.headerH - 0.5, y2: layout.headerH - 0.5, stroke: theme.axis }, corner);
		svgEl("line", { x1: labelWidth - 0.5, x2: labelWidth - 0.5, y1: 0, y2: layout.headerH, stroke: theme.axis }, corner);
		nest(chart, paintHeader(layout, paint), labelWidth, 0);
		nest(chart, paintLabels(slice, labelWidth, paint), 0, layout.headerH);
		nest(chart, paintBody(slice, paint), labelWidth, layout.headerH);
		if (band) bandBlock(chart, { svg: band.svg.cloneNode(true) as SVGSVGElement, height: band.height }, labelWidth, layout.headerH + slice.bodyH, theme);
		svgEl("rect", { x: 0.5, y: 0.5, width: chartW - 1, height: chartH - 1, rx: 6, fill: "none", stroke: theme.axis }, chart);

		// Legend and footer
		const lg = legend().node;
		lg.setAttribute("transform", `translate(${M}, ${M + titleH + chartH * scale + gap})`);
		svg.appendChild(lg);
		text(svg, M, H - M / 2, `${name} · ${printed}`, { fill: theme.inkMuted, "font-size": 8.5 });
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
