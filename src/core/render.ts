import { MONTHS_LONG, MONTHS_SHORT, dayFromYmd, formatDay, monthEnd, toDay, weekday, ymd } from "./dates";
import { Lane, Layout, MILESTONE_BADGE_PAD, Measure, NOTE_GAP, Placed, captionY, computeLayout } from "./layout";
import { PRINT_THEME, Theme, inkOnFill } from "./theme";
import { earliestAfter } from "./links";
import { BufferPattern, Mood, Project, isDone, isRangeType } from "./types";

/** Mood scale for journal dots: diverging red → neutral grey → blue. */
export const MOOD_COLORS: Record<Mood, string> = { 1: "#e34948", 2: "#ec9a8c", 3: "#a9a79f", 4: "#6da7ec", 5: "#2a78d6" };
const WARNING = "#fab219";

export const NS = "http://www.w3.org/2000/svg";
type Attrs = Record<string, string | number | undefined | null>;

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element): SVGElementTagNameMap[K] {
	const el = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
	if (parent) parent.appendChild(el);
	return el;
}

export function text(parent: Element, x: number, y: number, content: string, attrs: Attrs = {}): SVGTextElement {
	const t = svgEl("text", { x, y, "dominant-baseline": "central", ...attrs }, parent);
	t.textContent = content;
	return t;
}

/** Text width measurement backed by a canvas, shared by layout and truncation. */
export function makeMeasure(font: string): Measure {
	const ctx = createEl("canvas").getContext("2d")!;
	const cache = new Map<string, number>();
	return (s, weight = 500, size = 12) => {
		const key = `${weight}|${size}|${s}`;
		let w = cache.get(key);
		if (w === undefined) {
			ctx.font = `${weight} ${size}px ${font}`;
			w = ctx.measureText(s).width;
			cache.set(key, w);
		}
		return w;
	};
}

/** One or two lines that fit `max`, the second shortened with … if needed. */
function wrapTwo(s: string, max: number, measure: Measure, weight: number, size: number): string[] {
	if (measure(s, weight, size) <= max) return [s];
	const words = s.split(" ");
	let first = "";
	for (let i = 0; i < words.length; i++) {
		const next = first ? `${first} ${words[i]}` : words[i];
		if (measure(next, weight, size) > max && first) return [first, truncate(words.slice(i).join(" "), max, measure, weight, size)];
		first = next;
	}
	return [truncate(s, max, measure, weight, size)];
}

function truncate(s: string, max: number, measure: Measure, weight: number, size: number): string {
	if (measure(s, weight, size) <= max) return s;
	let lo = 0, hi = s.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (measure(s.slice(0, mid) + "…", weight, size) <= max) lo = mid;
		else hi = mid - 1;
	}
	return s.slice(0, lo).trimEnd() + "…";
}

let defsCounter = 0;

export interface PaintOptions {
	theme: Theme;
	measure: Measure;
	today?: number | null;
	selectedId?: string | null;
	/** Several selected items (box select / Shift-click). */
	selectedIds?: ReadonlySet<string>;
	/** The selected link, as "predId succId". It gets a detach button. */
	selectedLink?: string | null;
	/** Critical path view: these items (zero slack) stand out and everything else steps back. */
	critical?: ReadonlySet<string> | null;
	/** Compare with the saved plan: faint outlines show where items were planned. */
	plan?: Project["baseline"] | null;
	/** The board's tool, so empty rows can say what a drag will do. */
	tool?: "hand" | "select" | "draw";
	/** Print styling: stronger deadline rules for paper. */
	print?: boolean;
	/** Leave out the arrows between linked items (a print option). */
	hideLinks?: boolean;
	/** Paper: only the arrows between neighbouring phases, not the long ones through other phases. */
	shortLinksOnly?: boolean;
	flashId?: string | null;
	interactive?: boolean;
	/** Visible horizontal window [from, to] in timeline px; header labels stay inside it while scrolling. */
	visible?: [number, number];
}

/** A soft surface-coloured outline so labels stay readable over gridlines, the today line and deadline rules. */
function halo(theme: Theme): Attrs {
	return { stroke: theme.surface, "stroke-width": 4, "stroke-linejoin": "round", "paint-order": "stroke" };
}

function colorOf(p: Placed, theme: Theme): string {
	return p.color ? theme.palette[p.color] : theme.inkSecondary;
}

/** Iterate months overlapping the view. */
function* months(layout: Layout): Generator<{ start: number; end: number; y: number; m: number }> {
	let d = layout.viewStart;
	while (d <= layout.viewEnd) {
		const [y, m] = ymd(d);
		const end = monthEnd(d);
		yield { start: d, end, y, m };
		d = end + 1;
	}
}

// ─── Header: years, months, weeks ──────────────────────────────────────────

export function paintHeader(layout: Layout, o: PaintOptions): SVGSVGElement {
	const { theme } = o;
	const svg = svgEl("svg", { width: layout.width, height: layout.headerH, class: "sg-header-svg", "font-family": theme.font });
	svgEl("rect", { x: 0, y: 0, width: layout.width, height: layout.headerH, fill: theme.surface }, svg);
	const yMonthTop = layout.g.yearRowH;
	const yWeekTop = layout.g.yearRowH + layout.g.monthRowH;

	const [v0, v1] = o.visible ?? [0, layout.width];

	// Year segments; the label sticks to the left edge of the visible part of its year.
	const [y0] = ymd(layout.viewStart);
	const [y1] = ymd(layout.viewEnd);
	// Where the Today pill sits, so a year label can step aside for it.
	const todayX = o.today != null && o.today >= layout.viewStart && o.today <= layout.viewEnd ? layout.xOf(o.today) + layout.pxPerDay / 2 : null;
	const pillW = o.measure("Today", 600, 10) + 12;
	for (let year = y0; year <= y1; year++) {
		const from = Math.max(layout.viewStart, dayFromYmd(year, 0, 1));
		const to = Math.min(layout.viewEnd + 1, dayFromYmd(year + 1, 0, 1));
		const x = layout.xOf(from);
		const xEnd = layout.xOf(to);
		if (year !== y0) svgEl("line", { x1: x + 0.5, x2: x + 0.5, y1: 0, y2: layout.headerH, stroke: theme.axis }, svg);
		const tw = o.measure(String(year), 700, 11) + 4;
		let lx = Math.max(x + 8, Math.min(Math.max(x, v0) + 8, xEnd - tw - 8));
		if (todayX !== null && lx < todayX + pillW / 2 + 4 && lx + tw > todayX - pillW / 2 - 4) {
			const after = todayX + pillW / 2 + 6;
			if (after + tw < xEnd - 4) lx = after;
		}
		text(svg, lx, layout.g.yearRowH / 2 + 1, String(year), {
			fill: theme.ink, "font-size": 11, "font-weight": 700, "letter-spacing": "0.06em",
		});
	}

	for (const mo of months(layout)) {
		const x0 = layout.xOf(mo.start);
		const x1 = layout.xOf(mo.end + 1);
		const w = x1 - x0;
		if (mo.m !== 0 && mo.start !== layout.viewStart)
			svgEl("line", { x1: x0 + 0.5, x2: x0 + 0.5, y1: yMonthTop, y2: layout.headerH, stroke: theme.grid }, svg);
		const name = w >= 84 ? MONTHS_LONG[mo.m] : w >= 26 ? MONTHS_SHORT[mo.m] : MONTHS_SHORT[mo.m][0];
		// Centre the label on the visible part of the month, but never let it leave the month.
		const half = o.measure(name, 500, 12) / 2 + 6;
		const cx = Math.min(Math.max((Math.max(x0, v0) + Math.min(x1, v1)) / 2, x0 + half), x1 - half);
		text(svg, w > half * 2 ? cx : x0 + w / 2, yMonthTop + layout.g.monthRowH / 2, name, {
			fill: theme.inkSecondary, "font-size": 12, "font-weight": 500, "text-anchor": "middle",
		});
	}

	if (layout.showWeeks) {
		const daily = layout.pxPerDay >= 22;
		for (let d = layout.viewStart; d <= layout.viewEnd; d++) {
			const wd = weekday(d);
			if (!daily && wd !== 0) continue;
			const x = layout.xOf(d);
			const dom = ymd(d)[2];
			if (daily) {
				text(svg, x + layout.pxPerDay / 2, yWeekTop + layout.g.weekRowH / 2, String(dom), {
					fill: wd >= 5 ? theme.inkMuted : theme.inkSecondary, "font-size": 10, "text-anchor": "middle",
					"font-weight": wd === 0 ? 600 : 400,
				});
			} else {
				text(svg, x + 3, yWeekTop + layout.g.weekRowH / 2 - 1, String(dom), { fill: theme.inkMuted, "font-size": 10 });
			}
		}
	}

	svgEl("line", { x1: 0, x2: layout.width, y1: layout.headerH - 0.5, y2: layout.headerH - 0.5, stroke: theme.axis }, svg);

	// Milestones are marked on the date ruler too, so they're visible even when rows are folded or scrolled away.
	// (On paper the milestones speak for themselves: bold diamonds with dated labels.)
	for (const p of o.print ? [] : layout.placed) {
		if (p.kind !== "item" || p.item.type !== "milestone" || p.item.dropped) continue;
		const x = layout.xOf(p.startDay) + layout.pxPerDay / 2;
		const y = layout.headerH - 0.5;
		const r = 5;
		const fill = p.color ? theme.palette[p.color] : theme.inkSecondary;
		const m = svgEl("path", {
			d: `M${x},${y - r} L${x + r},${y} L${x},${y + r} L${x - r},${y} Z`,
			fill, stroke: theme.surface, "stroke-width": 1.5, "stroke-linejoin": "round", class: "sg-ruler-milestone",
		}, svg);
		svgEl("title", {}, m).textContent = `${p.item.title} · ${formatDay(p.startDay)}`;
	}
	// Deadlines get a red flag on the ruler, so each dashed rule below can be traced to its date.
	// (On paper the deadline band under the chart names them instead.)
	for (const p of o.print ? [] : layout.placed) {
		if (p.kind !== "item" || p.item.type !== "deadline" || p.item.dropped) continue;
		const x = layout.xOf(p.startDay) + layout.pxPerDay / 2;
		const f = flag(svg, x, layout.headerH - 13, 6, isDone(p.item) ? theme.inkMuted : theme.deadline);
		f.setAttribute("class", "sg-ruler-deadline");
		svgEl("title", {}, f).textContent = `Deadline: ${p.item.title} · ${formatDay(p.startDay)}`;
	}

	if (o.today != null && o.today >= layout.viewStart && o.today <= layout.viewEnd) {
		const x = layout.xOf(o.today) + layout.pxPerDay / 2;
		const label = "Today";
		const w = o.measure(label, 600, 10) + 12;
		const px = Math.min(Math.max(x - w / 2, 2), layout.width - w - 2);
		svgEl("line", { x1: x, x2: x, y1: 18, y2: layout.headerH, stroke: theme.accent, "stroke-width": 1.5 }, svg);
		svgEl("rect", { x: px, y: 3, width: w, height: 16, rx: 8, fill: theme.accent }, svg);
		text(svg, px + w / 2, 11.5, label, { fill: "#ffffff", "font-size": 10, "font-weight": 600, "text-anchor": "middle" });
	}
	return svg;
}

// ─── Lane labels (left column) ─────────────────────────────────────────────

export function paintLabels(layout: Layout, labelWidth: number, o: PaintOptions): SVGSVGElement {
	const { theme, measure } = o;
	const svg = svgEl("svg", { width: labelWidth, height: layout.bodyH, class: "sg-labels-svg", "font-family": theme.font });
	svgEl("rect", { x: 0, y: 0, width: labelWidth, height: layout.bodyH, fill: theme.surface }, svg);
	layout.lanes.forEach((lane, i) => {
		const g = svgEl("g", { class: `sg-lane-label${lane.collapsed ? " is-collapsed" : ""}`, "data-lane": lane.key }, svg);
		const mid = lane.y + lane.height / 2;
		const indent = o.interactive ? 10 : 0;
		const ix = 16 + indent;
		if (o.interactive) {
			svgEl("rect", {
				x: 0, y: lane.y, width: labelWidth, height: lane.height, fill: "transparent", class: "sg-lane-hitbox",
				"data-action": lane.kind === "phase" ? "toggle" : "none",
			}, g);
			if (lane.kind === "phase") {
				// Fold arrow: ▸ when collapsed, ▾ when open.
				const cx = 13, cy = mid - 7;
				svgEl("path", {
					d: lane.collapsed ? `M${cx - 2},${cy - 4} l4,4 l-4,4` : `M${cx - 4},${cy - 2} l4,4 l4,-4`,
					fill: "none", stroke: theme.inkMuted, "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round",
					class: "sg-fold", "pointer-events": "none",
				}, g);
			}
		}
		// On screen the icon sits beside the title above a subtitle; on paper (title only) it's centred.
		const im = o.print ? mid : mid - 7;
		if (lane.kind === "phase" && lane.color) {
			svgEl("rect", { x: ix, y: im - 5, width: 10, height: 10, rx: 3, fill: theme.palette[lane.color] }, g);
		} else if (lane.kind === "keydates") {
			flag(g, ix + 2, o.print ? im - 5.5 : im, 5.5, theme.deadline);
		} else if (lane.kind === "locations") {
			pin(g, ix + 5, im, theme.inkSecondary);
		} else if (lane.kind === "journal") {
			svgEl("rect", { x: ix, y: mid - 13, width: 10, height: 12, rx: 2, fill: "none", stroke: theme.inkSecondary, "stroke-width": 1.5 }, g);
			svgEl("path", { d: `M${ix + 3},${mid - 9.5}h4M${ix + 3},${mid - 6.5}h4`, stroke: theme.inkSecondary, "stroke-width": 1.2 }, g);
		} else {
			svgEl("rect", { x: ix, y: im - 5, width: 10, height: 10, rx: 3, fill: theme.inkMuted }, g);
		}
		const tx = 34 + indent;
		const max = labelWidth - tx - (o.interactive ? 40 : 12);
		if (o.print) {
			// Paper: just the name (the chart shows the rest), on two lines when it's long.
			const lines = wrapTwo(lane.title, max, measure, 600, 13);
			lines.forEach((line, k) => text(g, tx, mid + (k - (lines.length - 1) / 2) * 16, line, { fill: theme.ink, "font-size": 13, "font-weight": 600 }));
		} else {
			text(g, tx, mid - 7, truncate(lane.title, max, measure, 600, 13), {
				fill: theme.ink, "font-size": 13, "font-weight": 600, "pointer-events": "none",
			});
			text(g, tx, mid + 9, truncate(lane.subtitle, max, measure, 400, 11), { fill: theme.inkMuted, "font-size": 11, "pointer-events": "none" });
		}
		if (o.interactive && lane.kind !== "unassigned") {
			// "+" appears on hover: add something to this row.
			const add = svgEl("g", { class: "sg-lane-add", "data-action": "add" }, g);
			const ax = labelWidth - 24;
			svgEl("circle", { cx: ax, cy: mid, r: 11, fill: theme.surfaceAlt, stroke: theme.axis }, add);
			svgEl("path", { d: `M${ax - 4.5},${mid} h9 M${ax},${mid - 4.5} v9`, stroke: theme.inkSecondary, "stroke-width": 1.6, "stroke-linecap": "round" }, add);
		}
		const next = layout.lanes[i + 1];
		const strong = lane.kind !== "phase" && next && next.kind === "phase";
		svgEl("line", {
			x1: 0, x2: labelWidth, y1: lane.y + lane.height - 0.5, y2: lane.y + lane.height - 0.5,
			stroke: strong ? theme.axis : theme.grid,
		}, svg);
	});
	svgEl("line", { x1: labelWidth - 0.5, x2: labelWidth - 0.5, y1: 0, y2: layout.bodyH, stroke: theme.axis }, svg);
	return svg;
}

// ─── Body: grid, lanes, items ──────────────────────────────────────────────

export function paintBody(layout: Layout, o: PaintOptions): SVGSVGElement {
	const { theme } = o;
	const svg = svgEl("svg", { width: layout.width, height: layout.bodyH, class: "sg-body-svg", "font-family": theme.font });
	const hatchId = `sg-hatch-${++defsCounter}`;
	const defs = svgEl("defs", {}, svg);
	const pat = svgEl("pattern", { id: hatchId, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
	svgEl("rect", { width: 6, height: 6, fill: theme.surfaceAlt }, pat);
	svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: theme.axis, "stroke-width": 1.4 }, pat);

	svgEl("rect", { x: 0, y: 0, width: layout.width, height: layout.bodyH, fill: theme.surface, class: "sg-bg" }, svg);

	// Month washes and gridlines
	let odd = false;
	for (const mo of months(layout)) {
		const x0 = layout.xOf(mo.start);
		const x1 = layout.xOf(mo.end + 1);
		if (odd) svgEl("rect", { x: x0, y: 0, width: x1 - x0, height: layout.bodyH, fill: theme.surfaceAlt, opacity: 0.55 }, svg);
		odd = !odd;
		if (mo.start !== layout.viewStart)
			svgEl("line", { x1: x0 + 0.5, x2: x0 + 0.5, y1: 0, y2: layout.bodyH, stroke: mo.m === 0 ? theme.axis : theme.grid, opacity: mo.m === 0 ? 0.9 : 0.6 }, svg);
	}
	if (layout.pxPerDay >= 10) {
		for (let d = layout.viewStart; d <= layout.viewEnd; d++) {
			if (weekday(d) === 5)
				svgEl("rect", { x: layout.xOf(d), y: 0, width: layout.pxPerDay * 2, height: layout.bodyH, fill: theme.surfaceAlt, opacity: 0.45 }, svg);
		}
	}

	// Lane separators (with interactive hit areas for drag-to-create)
	const hints = o.interactive ? laneHints(layout, o.tool) : new Map<Lane, { text: string; always: boolean }>();
	layout.lanes.forEach((lane, i) => {
		if (o.interactive)
			svgEl("rect", {
				x: 0, y: lane.y, width: layout.width, height: lane.height, fill: "transparent",
				class: "sg-lane-hit", "data-lane": lane.key,
			}, svg);
		// Must directly follow its hit rect: CSS shows it while that rect is hovered.
		const hint = hints.get(lane);
		if (hint)
			text(svg, 16, lane.y + lane.height / 2, hint.text, {
				fill: theme.inkMuted, "font-size": 12, "font-style": "italic", "pointer-events": "none",
				class: `sg-lane-hint${hint.always ? " is-always" : ""}`,
			});
		const next = layout.lanes[i + 1];
		const strong = lane.kind !== "phase" && next && next.kind === "phase";
		svgEl("line", {
			x1: 0, x2: layout.width, y1: lane.y + lane.height - 0.5, y2: lane.y + lane.height - 0.5,
			stroke: strong ? theme.axis : theme.grid, opacity: strong ? 0.9 : 0.6, "pointer-events": "none",
		}, svg);
	});

	// Deadline rules run through every lane so they read as hard stops.
	for (const p of layout.placed) {
		if (p.item.type !== "deadline" || p.kind !== "item" || isDone(p.item) || p.item.dropped) continue;
		const x = (p.x0 + p.x1) / 2;
		svgEl("line", { x1: x, x2: x, y1: p.cy + 9, y2: layout.bodyH, ...deadlineRule(theme, !!o.print), class: "sg-deadline-rule", "data-id": p.item.id }, svg);
		// On screen the rule can be hovered (name and date) and clicked (opens the deadline).
		if (o.interactive)
			svgEl("line", { x1: x, x2: x, y1: p.cy + 9, y2: layout.bodyH, stroke: "transparent", "stroke-width": 7, "pointer-events": "stroke", class: "sg-deadline-hit", "data-id": p.item.id }, svg);
	}

	if (o.today != null && o.today >= layout.viewStart && o.today <= layout.viewEnd) {
		const x = layout.xOf(o.today) + layout.pxPerDay / 2;
		svgEl("line", { x1: x, x2: x, y1: 0, y2: layout.bodyH, stroke: theme.accent, "stroke-width": 1.5, "pointer-events": "none" }, svg);
	}

	const detach = layout.on("links") && !o.hideLinks ? paintLinks(svg, layout, o) : null;

	const items = svgEl("g", { class: "sg-items" }, svg);
	const bufferIds = new Map<string, string>();
	const fills: Fills = {
		hatch: `url(#${hatchId})`,
		buffer: (color, pattern = "diagonal") => {
			const key = `${color}|${pattern}`;
			let id = bufferIds.get(key);
			if (!id) {
				id = `sg-buffer-${++defsCounter}`;
				bufferPattern(defs, id, color, pattern);
				bufferIds.set(key, id);
			}
			return `url(#${id})`;
		},
	};
	// A Plan B that continues a task goes underneath it, so only the part past the task's end shows;
	// buffers joined to a task go on top of it, earliest first, so each reads as a stretch of the bar.
	const under = (p: Placed) => p.kind === "ghost" && !!p.attachedTo;
	const over = (p: Placed) => p.kind === "item" && !!p.attachedTo;
	const order = [
		...layout.placed.filter(under),
		...layout.placed.filter((p) => !under(p) && !over(p)),
		...layout.placed.filter(over).sort((a, b) => a.x0 - b.x0),
	];
	for (const p of order) paintItem(items, p, layout, o, fills);
	// The selected link's detach button sits on top of everything.
	if (detach) {
		const [x, y] = detach;
		const b = svgEl("g", { class: "sg-unlink", "data-action": "unlink" }, svg);
		svgEl("title", {}, b).textContent = "Unlink";
		svgEl("circle", { cx: x, cy: y, r: 10, fill: theme.surface, stroke: theme.accent, "stroke-width": 1.5 }, b);
		svgEl("path", { d: `M${x - 3.5},${y - 3.5} L${x + 3.5},${y + 3.5} M${x + 3.5},${y - 3.5} L${x - 3.5},${y + 3.5}`, stroke: theme.accent, "stroke-width": 1.8, "stroke-linecap": "round" }, b);
	}
	return svg;
}

interface Fills {
	/** Neutral hatch for locations. */
	hatch: string;
	/** A pattern in a phase colour, for buffer time. */
	buffer: (color: string, pattern?: BufferPattern) => string;
}

/** The tile behind each buffer pattern: a light tint of the colour with marks in it. */
export function bufferPattern(defs: SVGElement, id: string, color: string, pattern: BufferPattern) {
	const size = pattern === "dots" ? 6 : pattern === "horizontal" ? 5 : pattern === "grid" ? 6 : 7;
	const rotate = pattern === "diagonal" || pattern === "crosshatch" ? "rotate(45)" : pattern === "reverse" ? "rotate(-45)" : undefined;
	const pt = svgEl("pattern", { id, width: size, height: size, patternUnits: "userSpaceOnUse", ...(rotate ? { patternTransform: rotate } : {}) }, defs);
	svgEl("rect", { width: size, height: size, fill: color, "fill-opacity": 0.12 }, pt);
	const line = (x1: number, y1: number, x2: number, y2: number, w: number, op = 0.5) =>
		svgEl("line", { x1, y1, x2, y2, stroke: color, "stroke-width": w, "stroke-opacity": op }, pt);
	switch (pattern) {
		case "diagonal":
		case "reverse":
			line(0, 0, 0, size, 2.4);
			break;
		case "crosshatch":
			line(0, 0, 0, size, 1.3, 0.55);
			line(0, 0, size, 0, 1.3, 0.55);
			break;
		case "dots":
			svgEl("circle", { cx: 1.5, cy: 1.5, r: 1.3, fill: color, "fill-opacity": 0.7 }, pt);
			svgEl("circle", { cx: 4.5, cy: 4.5, r: 1.3, fill: color, "fill-opacity": 0.7 }, pt);
			break;
		case "horizontal":
			line(0, 2.5, size, 2.5, 1.6, 0.55);
			break;
		case "grid":
			line(0.5, 0, 0.5, size, 1, 0.5);
			line(0, 0.5, size, 0.5, 1, 0.5);
			break;
	}
}

/**
 * How-to hints for empty rows. They only appear while the row is hovered, so the chart stays calm;
 * a brand-new project shows a single hint in its first phase row until something is added.
 */
function laneHints(layout: Layout, tool: PaintOptions["tool"]): Map<Lane, { text: string; always: boolean }> {
	const used = new Set(layout.placed.map((p) => p.lane));
	const phases = layout.lanes.filter((l) => l.kind === "phase");
	const fresh = phases.length > 0 && phases.every((l) => !used.has(l));
	const out = new Map<Lane, { text: string; always: boolean }>();
	for (const lane of layout.lanes) {
		if (used.has(lane)) continue;
		const draw = tool === "draw";
		const text =
			lane.kind === "phase" ? (draw ? "Drag to add a task · double-click for a milestone" : "Double-click to add a milestone · right-click for more") :
			lane.kind === "keydates" ? "Double-click to add a key date" :
			lane.kind === "locations" ? (draw ? "Drag to add a place you'll be" : "Double-click to add a place you'll be") : null;
		if (text) out.set(lane, { text, always: fresh && lane === phases[0] });
	}
	return out;
}

function paintItem(parent: Element, p: Placed, layout: Layout, o: PaintOptions, fills: Fills) {
	const { theme } = o;
	const it = p.item;
	const cls = ["sg-item", p.kind === "item" ? `sg-${it.type}` : `sg-${p.kind}`];
	const selected = o.selectedId === it.id || !!o.selectedIds?.has(it.id);
	if (selected) cls.push("is-selected");
	if (o.critical) cls.push(p.kind === "item" && o.critical.has(it.id) ? "is-critical" : "is-dimmed");
	if (o.flashId === it.id) cls.push("sg-pop");
	if (it.dropped) cls.push("is-dropped");
	if (p.state) cls.push(`is-${p.state}`);
	const g = svgEl("g", { class: cls.join(" "), "data-id": it.id, "data-kind": p.kind }, parent);
	if (p.parentId) g.setAttribute("data-parent", p.parentId);
	if (it.dropped) g.setAttribute("opacity", "0.42");
	if (p.kind !== "item") return paintDerived(g, p, layout, o);
	const color = colorOf(p, theme);
	const top = p.cy - p.lane.markH / 2;
	const labelAttrs: Attrs = {
		"font-size": layout.g.fontSize, "font-weight": it.type === "deadline" ? 600 : 500,
		"text-anchor": p.labelAnchor, "pointer-events": "none",
		"text-decoration": it.dropped ? "line-through" : null,
	};

	if (selected) {
		const outside = !p.labelInside;
		const sx0 = outside && p.labelAnchor === "end" ? p.labelX - p.labelW : p.x0;
		const sx1 = outside && p.labelAnchor === "start" ? p.labelX + p.labelW : p.x1;
		svgEl("rect", {
			x: sx0 - 4, y: top - 4, width: sx1 - sx0 + 8, height: p.lane.markH + 8, rx: 7,
			fill: "none", stroke: theme.accent, "stroke-width": 2, class: "sg-selection",
		}, g);
	}
	if (o.plan) paintPlanned(g, p, layout, o);

	if (it.type === "task" && it.buffer) {
		const w = p.x1 - p.x0;
		const h = layout.g.barH;
		const d = barPath(p.x0 + (p.squareLeft ? 0 : 0.5), top + 0.5, Math.max(2, w - (p.squareLeft ? 0 : 0.5) - (p.squareRight ? 0 : 0.5)), h - 1, 6, !p.squareLeft, !p.squareRight);
		// An opaque base, so a buffer inside its task's bar reads as a hatched stretch of it.
		if (p.attachedTo) svgEl("path", { d, fill: theme.surface, "pointer-events": "none" }, g);
		svgEl("path", { d, fill: fills.buffer(color, it.pattern), stroke: color, "stroke-opacity": 0.7, class: "sg-mark", "data-part": "body" }, g);
		if (p.attachedTo) {
			// Its name sits just above it, like a caption (or under it, when names would collide).
			text(g, p.labelX, captionY(p, layout.g), p.label, {
				...labelAttrs, ...halo(theme), "text-anchor": p.labelAnchor, "font-size": layout.g.fontSize - 1.5,
				fill: theme.inkSecondary, "font-style": "italic",
			});
		} else text(g, p.labelX, p.cy, p.label, { ...labelAttrs, ...halo(theme), fill: theme.inkSecondary, "font-style": "italic" });
		if (o.interactive && w >= 14) {
			const hw = Math.min(8, w / 3);
			svgEl("rect", { x: p.x0 - 2, y: top, width: hw + 2, height: layout.g.barH, fill: "transparent", class: "sg-handle", "data-part": "start" }, g);
			svgEl("rect", { x: p.x1 - hw, y: top, width: hw + 2, height: layout.g.barH, fill: "transparent", class: "sg-handle", "data-part": "end" }, g);
		}
		if (o.interactive && layout.on("links")) connector(g, connectorX(p), p.cy, color, theme);
	} else if (it.type === "task") {
		const w = p.x1 - p.x0;
		svgEl("path", { d: barPath(p.x0, top, w, layout.g.barH, Math.min(6, w / 2), !p.squareLeft, !p.squareRight), fill: color, class: "sg-mark", "data-part": "body" }, g);
		const prog = Math.max(0, Math.min(100, it.progress ?? 0));
		// Progress sits as a slim track just under the bar so it never fights the label.
		if (layout.on("progress") && prog > 0 && prog < 100 && w > 12) {
			const ty = top + layout.g.barH + 2;
			svgEl("rect", { x: p.x0, y: ty, width: w, height: 2.5, rx: 1.25, fill: color, opacity: 0.22, "pointer-events": "none" }, g);
			svgEl("rect", { x: p.x0, y: ty, width: (w * prog) / 100, height: 2.5, rx: 1.25, fill: color, "pointer-events": "none" }, g);
		}
		const t = text(g, p.labelX, p.cy, p.label, {
			...labelAttrs, ...(p.labelInside ? {} : halo(theme)), fill: p.labelInside ? (p.color ? inkOnFill(p.color) : "#ffffff") : theme.ink,
		});
		if (p.note && p.noteInside) {
			// The dates didn't fit beside the name: they sit inside the bar instead.
			text(g, p.x0 + 7, p.cy, p.note, {
				...labelAttrs, "text-anchor": "start", "font-size": layout.g.fontSize - 1.5, "font-weight": 400,
				fill: p.color ? inkOnFill(p.color) : "#ffffff", "fill-opacity": 0.85, "pointer-events": "none",
			});
		} else if (p.note) {
			const n = svgEl("tspan", {
				dx: NOTE_GAP, "font-size": layout.g.fontSize - 1.5, "font-weight": 400,
				fill: p.labelInside ? (p.color ? inkOnFill(p.color) : "#ffffff") : theme.inkMuted, "fill-opacity": p.labelInside ? 0.8 : 1,
			}, t);
			n.textContent = p.note;
		}
		if (o.interactive && w >= 14) {
			const hw = Math.min(8, w / 3);
			svgEl("rect", { x: p.x0 - 2, y: top, width: hw + 2, height: layout.g.barH, fill: "transparent", class: "sg-handle", "data-part": "start" }, g);
			svgEl("rect", { x: p.x1 - hw, y: top, width: hw + 2, height: layout.g.barH, fill: "transparent", class: "sg-handle", "data-part": "end" }, g);
		}
		if (o.interactive && !it.dropped && layout.on("links")) connector(g, connectorX(p), p.cy, color, theme);
	} else if (it.type === "location") {
		const w = p.x1 - p.x0;
		svgEl("rect", {
			x: p.x0 + 0.5, y: top + 0.5, width: w - 1, height: layout.g.stripH - 1, rx: layout.g.stripH / 2,
			fill: fills.hatch, stroke: theme.axis, class: "sg-mark", "data-part": "body",
		}, g);
		if (w >= 22) pin(g, p.x0 + 10, p.cy - 1, theme.inkSecondary);
		text(g, p.labelX, p.cy, p.label, { ...labelAttrs, ...(p.labelInside ? {} : halo(theme)), fill: theme.inkSecondary, "font-weight": 600 });
		if (o.interactive && w >= 14) {
			const hw = Math.min(8, w / 3);
			svgEl("rect", { x: p.x0 - 2, y: top, width: hw + 2, height: layout.g.stripH, fill: "transparent", class: "sg-handle", "data-part": "start" }, g);
			svgEl("rect", { x: p.x1 - hw, y: top, width: hw + 2, height: layout.g.stripH, fill: "transparent", class: "sg-handle", "data-part": "end" }, g);
		}
	} else {
		const cx = (p.x0 + p.x1) / 2;
		if (it.type === "milestone") {
			const r = o.print ? 9.5 : 8.5;
			// A soft glow ring makes milestones stand out from bars and key dates (on screen; paper stays crisp).
			if (!p.lane.collapsed && !o.print) svgEl("circle", { cx, cy: p.cy, r: 14, fill: color, opacity: theme.dark ? 0.2 : 0.14, "pointer-events": "none", class: "sg-glow" }, g);
			svgEl("path", {
				d: `M${cx},${p.cy - r} L${cx + r},${p.cy} L${cx},${p.cy + r} L${cx - r},${p.cy} Z`,
				fill: p.lane.collapsed ? theme.surface : color,
				// On paper a dark outline makes every milestone easy to spot, even in light phase colours.
				stroke: p.lane.collapsed ? color : o.print ? theme.ink : theme.surface,
				"stroke-width": o.print ? 1.4 : 2, "stroke-linejoin": "round", class: "sg-mark", "data-part": "body",
			}, g);
			if (isDone(it) && !p.lane.collapsed) check(g, cx, p.cy, 3.2, p.color === "yellow" ? "#0b0b0b" : "#ffffff");
			if (o.interactive && !it.dropped && layout.on("links")) connector(g, connectorX(p), p.cy, color, theme);
		} else if (it.type === "deadline") {
			flag(g, cx, p.cy - 8, 8, theme.deadline).setAttribute("data-part", "body");
		} else {
			svgEl("circle", {
				cx, cy: p.cy, r: 5.5, fill: p.color ? color : theme.inkSecondary,
				stroke: theme.surface, "stroke-width": 2, class: "sg-mark", "data-part": "body",
			}, g);
		}
		svgEl("rect", { x: cx - 10, y: p.cy - 11, width: 20, height: 22, fill: "transparent", "data-part": "body", class: "sg-hit" }, g);
		if (it.type === "milestone" && p.label && !o.print) milestoneBadge(g, p, color, theme, labelAttrs);
		else text(g, p.labelX, p.cy, p.label, {
			...labelAttrs, ...halo(theme),
			...(o.print && it.type === "milestone" ? { "font-weight": 700 } : {}),
			...(o.print && it.type === "deadline" ? { fill: theme.deadline, "font-weight": 700 } : { fill: theme.ink }),
		});
	}
}

/** Elbow arrows from each predecessor's end to its successor's start; red when the order is broken. */
function paintLinks(svg: SVGSVGElement, layout: Layout, o: PaintOptions): Pt | null {
	const { theme } = o;
	const byId = new Map(layout.placed.filter((p) => p.kind === "item").map((p) => [p.item.id, p]));
	const g = svgEl("g", { class: "sg-links", fill: "none", "pointer-events": "none" }, svg);
	let detach: Pt | null = null;
	const obstacles = obstaclesOf(layout, !!o.print);
	for (const succ of byId.values()) {
		for (const id of succ.item.after ?? []) {
			const pred = byId.get(id);
			if (!pred || pred.item.dropped || succ.item.dropped) continue;
			// On paper, the long arrows that run down through other phases can be left out (a print option).
			if (o.print && o.shortLinksOnly && Math.abs(layout.lanes.indexOf(pred.lane) - layout.lanes.indexOf(succ.lane)) > 1) continue;
			// …and so is one into a buffer that's drawn as part of its task's bar.
			if (o.print && succ.attachedTo) continue;
			const pts = routeLink(pred, succ, layout, obstacles, !!o.print);
			if (!pts) continue;
			const bad = succ.startDay < earliestAfter(pred.item, succ.item);
			const color = bad ? theme.deadline : o.print ? theme.inkSecondary : theme.inkMuted;
			// Links to or from a deadline duplicate its dashed rule: on screen they show on hover, on paper not at all.
			const touchesDeadline = pred.item.type === "deadline" || succ.item.type === "deadline";
			if (touchesDeadline && !bad && !o.interactive) continue;
			const quiet = touchesDeadline && !bad;
			const key = `${pred.item.id} ${succ.item.id}`;
			const selected = o.selectedLink === key;
			const crit = o.critical ? (o.critical.has(pred.item.id) && (o.critical.has(succ.item.id) || succ.item.type === "deadline") ? " is-critical" : " is-dimmed") : "";
			const cls = `sg-link${bad ? " is-bad" : ""}${quiet ? " is-quiet" : ""}${selected ? " is-selected" : ""}${crit}`;
			const link = svgEl("g", { class: cls, "data-link": key }, g);
			const d = roundedPath(pts, 5);
			const attrs = { stroke: color, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: bad ? 0.9 : o.print ? 0.7 : 0.6 };
			svgEl("path", { d, ...attrs, "stroke-width": bad ? 1.6 : 1.35, class: "sg-link-line" }, link);
			svgEl("path", { d: arrowHead(pts), ...attrs, fill: color, "stroke-width": 1, class: "sg-link-head" }, link);
			// A wide invisible stroke makes the thin line easy to hover and click.
			if (o.interactive) svgEl("path", { d, stroke: "transparent", "stroke-width": 11, "pointer-events": "stroke", class: "sg-link-hit" }, link);
			if (selected) detach = midpoint(pts);
		}
	}
	return detach;
}

/** The point halfway along a polyline, where a selected link shows its detach button. */
function midpoint(pts: Pt[]): Pt {
	const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
	let left = lens.reduce((a, b) => a + b, 0) / 2;
	for (let i = 0; i < lens.length; i++) {
		if (left <= lens[i] || i === lens.length - 1) {
			const t = lens[i] ? Math.min(1, left / lens[i]) : 0;
			return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
		}
		left -= lens[i];
	}
	return pts[0];
}

type Pt = [number, number];

interface Box { x0: number; y0: number; x1: number; y1: number }
/** Something an arrow should avoid: a mark itself, or its label. */
interface Obstacle { box: Box; owner: Placed; mark: boolean }

/** Everything an arrow should avoid running through: marks, their labels and buffer captions. */
function obstaclesOf(layout: Layout, print: boolean): Obstacle[] {
	const out: Obstacle[] = [];
	const fs = layout.g.fontSize;
	for (const p of layout.placed) {
		const h = halfHeight(p, print);
		out.push({ owner: p, mark: true, box: { x0: p.x0, y0: p.cy - h, x1: p.x1, y1: p.cy + h } });
		if (!p.label || p.labelInside) continue;
		const lx0 = p.labelAnchor === "end" ? p.labelX - p.labelW : p.labelX;
		const ly = p.attachedTo ? captionY(p, layout.g) : p.cy;
		out.push({ owner: p, mark: false, box: { x0: lx0, y0: ly - fs * 0.55, x1: lx0 + p.labelW, y1: ly + fs * 0.55 } });
	}
	return out;
}

/** Half the height of a mark, from its centre to the edge an arrow touches. */
function halfHeight(p: Placed, print: boolean): number {
	const t = p.item.type;
	if (p.kind !== "item" || t === "task" || t === "location") return p.lane.markH / 2;
	if (t === "milestone") return (print ? 9.5 : 8.5) + 0.8;
	if (t === "deadline") return 8.5;
	return 6.5;
}

/**
 * The route for a finish-to-start link. A few clean shapes are tried and the one that runs through the
 * fewest other bars and labels wins, with fewer bends breaking ties:
 *  - straight down (or up) when the next step starts under the previous one,
 *  - out of the side of the previous step, then down onto the top of the next one (┐),
 *  - down from the previous step, then into the side of the next one (└→),
 *  - a staircase through the gap above the next step, only when nothing simpler is clear.
 * Arrows always end on the edge of the mark they point at.
 */
function routeLink(pred: Placed, succ: Placed, layout: Layout, obstacles: Obstacle[], print: boolean): Pt[] | null {
	const sign = succ.cy > pred.cy ? 1 : -1;
	const point = (p: Placed) => p.item.type !== "task" && p.item.type !== "location";
	const pc = (pred.x0 + pred.x1) / 2, sc = (succ.x0 + succ.x1) / 2;
	const ph = halfHeight(pred, print), sh = halfHeight(succ, print);
	const pEdge = pred.cy + sign * ph;
	const sEdge = succ.cy - sign * sh;

	if (Math.abs(pred.cy - succ.cy) < 1) {
		// Same row: a short straight line from the end of the predecessor's footprint (bar or label).
		const from = pred.labelInside || !pred.labelW || pred.labelAnchor === "end" ? pred.x1 + 2 : pred.labelX + pred.labelW + 6;
		const to = succ.x0 - 1;
		return to - from >= 10 ? [[from, succ.cy], [to, succ.cy]] : null;
	}

	// Where the arrow may leave the predecessor and land on the successor.
	// (A bar may be left from just past its end: where one step ends and the next begins, a straight drop.)
	const pRange: [number, number] = point(pred) ? [pc, pc] : [pred.x0 + 2, pred.x1 + 3];
	const sRange: [number, number] = point(succ) ? [sc, sc] : [succ.x0 + Math.min(1, (succ.x1 - succ.x0) / 2), succ.x1 - 2];
	const want = point(succ) ? sc : succ.x0 + Math.min(8, (succ.x1 - succ.x0) / 2);
	const pSide = point(pred) ? pc + ph + 1 : pred.x1 + 1;
	const pEnd = point(pred) ? pc : pred.x1 - Math.min(6, (pred.x1 - pred.x0) / 2);
	const sSide = point(succ) ? sc - sh - 1 : succ.x0 - 1;
	const gapY = sEdge - sign * Math.max(4, Math.min(10, (layout.g.rowPitch - layout.g.barH) / 2));

	const options: { pts: Pt[]; bends: number }[] = [];
	// Straight drop.
	const lo = Math.max(pRange[0], sRange[0]), hi = Math.min(pRange[1], sRange[1]);
	if (lo <= hi + 0.01) {
		const x = Math.min(hi, Math.max(lo, want));
		options.push({ pts: [[x, pEdge], [x, sEdge]], bends: 0 });
	}
	// Out of the side, then down onto the top.
	const tx = point(succ) ? sc : Math.min(sRange[1], Math.max(want, pSide + 6));
	if (tx - pSide >= 4) options.push({ pts: [[pSide, pred.cy], [tx, pred.cy], [tx, sEdge]], bends: 1 });
	// Down, then into the side.
	if (sSide - pEnd >= 8) options.push({ pts: [[pEnd, pEdge], [pEnd, succ.cy], [sSide, succ.cy]], bends: 1.5 });
	// Staircase through the gap next to the successor.
	if (Math.abs(want - pEnd) >= 2) options.push({ pts: [[pEnd, pEdge], [pEnd, gapY], [want, gapY], [want, sEdge]], bends: 2.5 });
	// Fully backwards: round through the gap and in from the left.
	options.push({ pts: [[pEnd, pEdge], [pEnd, gapY], [sSide - 10, gapY], [sSide - 10, succ.cy], [sSide, succ.cy]], bends: 4 });

	let best: Pt[] | null = null, bestCost = Infinity;
	for (const o of options) {
		const cost = crossings(o.pts, obstacles, pred, succ) * 100 + o.bends * 3 + pathLength(o.pts) / 400;
		if (cost < bestCost) [best, bestCost] = [o.pts, cost];
	}
	return best;
}

/** How many marks or labels a route runs through (its own two ends don't count). */
function crossings(pts: Pt[], obstacles: Obstacle[], pred: Placed, succ: Placed): number {
	let n = 0;
	for (const { box, owner, mark } of obstacles) {
		// The two marks the route connects are its endpoints; their labels still count.
		if (mark && (owner === pred || owner === succ)) continue;
		const b = { x0: box.x0 + 1, y0: box.y0 + 1, x1: box.x1 - 1, y1: box.y1 - 1 };
		for (let i = 1; i < pts.length; i++) {
			const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
			const sx0 = Math.min(ax, bx), sx1 = Math.max(ax, bx), sy0 = Math.min(ay, by), sy1 = Math.max(ay, by);
			if (sx1 >= b.x0 && sx0 <= b.x1 && sy1 >= b.y0 && sy0 <= b.y1) {
				n++;
				break;
			}
		}
	}
	return n;
}

function pathLength(pts: Pt[]): number {
	let l = 0;
	for (let i = 1; i < pts.length; i++) l += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
	return l;
}

/** A polyline with softly rounded corners (radius r, never more than half of either segment). */
function roundedPath(pts: Pt[], r: number): string {
	let d = `M${pts[0][0]},${pts[0][1]}`;
	for (let i = 1; i < pts.length - 1; i++) {
		const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
		const inLen = Math.hypot(x - px, y - py), outLen = Math.hypot(nx - x, ny - y);
		const k = Math.min(r, inLen / 2, outLen / 2);
		const ax = x - ((x - px) / (inLen || 1)) * k, ay = y - ((y - py) / (inLen || 1)) * k;
		const bx = x + ((nx - x) / (outLen || 1)) * k, by = y + ((ny - y) / (outLen || 1)) * k;
		d += ` L${ax},${ay} Q${x},${y} ${bx},${by}`;
	}
	const [lx, ly] = pts[pts.length - 1];
	return d + ` L${lx},${ly}`;
}

/** A small arrowhead at the end of the route, pointing along its last segment. */
function arrowHead(pts: Pt[]): string {
	const [x, y] = pts[pts.length - 1];
	const [px, py] = pts[pts.length - 2];
	const len = Math.hypot(x - px, y - py) || 1;
	const ux = (x - px) / len, uy = (y - py) / len;
	const bx = x - ux * 7, by = y - uy * 7;
	return `M${x},${y} L${bx - uy * 4},${by + ux * 4} L${bx + uy * 4},${by - ux * 4} Z`;
}

/** Where an item sat in the saved plan, drawn as a faint dashed outline when it has moved since. */
function paintPlanned(g: SVGGElement, p: Placed, layout: Layout, o: PaintOptions) {
	const b = o.plan?.items[p.item.id];
	if (!b || p.kind !== "item" || p.item.dropped) return;
	const it = p.item;
	const s = toDay(b.start), e = toDay(b.end ?? b.start);
	const ie = toDay(it.end ?? it.start);
	if (s === toDay(it.start) && e === ie) return;
	const attrs: Attrs = {
		fill: "none", stroke: o.theme.inkMuted, "stroke-width": 1.25, "stroke-dasharray": "3 3", opacity: 0.85,
		"pointer-events": "none", class: "sg-planned",
	};
	const top = p.cy - p.lane.markH / 2;
	if (isRangeType(it.type)) {
		const x0 = layout.xOf(s);
		const h = it.type === "location" ? layout.g.stripH : layout.g.barH;
		svgEl("rect", { x: x0 + 0.5, y: top + 0.5, width: Math.max(3, layout.xOf(e + 1) - x0 - 1), height: h - 1, rx: 6, ...attrs }, g);
	} else {
		const cx = layout.xOf(s) + layout.pxPerDay / 2;
		const r = 7;
		svgEl("path", { d: `M${cx},${p.cy - r} L${cx + r},${p.cy} L${cx},${p.cy + r} L${cx - r},${p.cy} Z`, ...attrs }, g);
	}
	// A thin thread from the planned end to the real one shows the drift at a glance.
	const px = isRangeType(it.type) ? layout.xOf(e + 1) : layout.xOf(e) + layout.pxPerDay / 2;
	const nx = isRangeType(it.type) ? p.x1 : (p.x0 + p.x1) / 2;
	if (Math.abs(nx - px) > 6) {
		const y = isRangeType(it.type) ? top + (it.type === "location" ? layout.g.stripH : layout.g.barH) + 5 : p.cy + 12;
		const late = nx > px;
		svgEl("path", {
			d: `M${px},${y - 3} V${y} H${nx} V${y - 3}`, fill: "none", stroke: late ? o.theme.deadline : o.theme.inkMuted,
			"stroke-width": 1.25, opacity: 0.7, "pointer-events": "none", class: `sg-drift${late ? " is-late" : ""}`,
		}, g);
	}
}

/** Plan B ghosts, decision points, journal entries and check-in slots. */
function paintDerived(g: SVGGElement, p: Placed, layout: Layout, o: PaintOptions) {
	const { theme } = o;
	const color = colorOf(p, theme);
	const cx = (p.x0 + p.x1) / 2;
	const labelAttrs: Attrs = { "font-size": layout.g.fontSize, "font-weight": 500, "text-anchor": p.labelAnchor, "pointer-events": "none" };
	if (p.kind === "summary") {
		const top = p.cy - layout.g.barH / 2;
		const w = Math.max(3, p.x1 - p.x0);
		const r = Math.min(layout.g.barH / 2, 8);
		svgEl("rect", { x: p.x0, y: top, width: w, height: layout.g.barH, rx: r, fill: color, "fill-opacity": 0.16, stroke: color, "stroke-width": 1.5, class: "sg-mark", "data-part": "body" }, g);
		const pw = (w * (p.progress ?? 0)) / 100;
		if (pw > 0) svgEl("rect", { x: p.x0, y: top, width: pw, height: layout.g.barH, rx: r, fill: color, opacity: 0.85, "pointer-events": "none" }, g);
		text(g, p.labelX, p.cy, p.label, { ...labelAttrs, ...(p.labelInside ? {} : halo(theme)), fill: theme.ink, "font-weight": 600 });
		return;
	}
	if (p.kind === "ghost") {
		const top = p.cy - layout.g.barH / 2;
		const w = Math.max(2, p.x1 - p.x0 - 1.5);
		svgEl("path", {
			d: barPath(p.x0 + 0.75, top + 0.75, w, layout.g.barH - 1.5, 6, !p.squareLeft, !p.squareRight),
			fill: color, "fill-opacity": 0.1, stroke: color, "stroke-width": 1.5, "stroke-dasharray": "5 3",
			class: "sg-mark", "data-part": "body",
		}, g);
		if (p.attachedTo) {
			// A dashed extension of its task (drawn under the bar), named just above.
			text(g, p.labelX, captionY(p, layout.g), p.label, {
				...labelAttrs, ...halo(theme), "text-anchor": p.labelAnchor, "font-size": layout.g.fontSize - 1.5,
				fill: theme.inkSecondary, "font-style": "italic",
			});
		} else text(g, p.labelX, p.cy, p.label, { ...labelAttrs, ...(p.labelInside ? {} : halo(theme)), fill: p.labelInside ? color : theme.inkSecondary, "font-style": "italic", "font-weight": 600 });
	} else if (p.kind === "decision") {
		const r = 7;
		const due = p.state === "due";
		if (due) svgEl("circle", { cx, cy: p.cy, r: 11, fill: WARNING, opacity: 0.25, class: "sg-pulse", "pointer-events": "none" }, g);
		svgEl("path", {
			d: `M${cx},${p.cy - r} L${cx + r},${p.cy} L${cx},${p.cy + r} L${cx - r},${p.cy} Z`,
			fill: due ? WARNING : theme.surface, stroke: due ? WARNING : theme.inkSecondary, "stroke-width": 1.75,
			"stroke-linejoin": "round", class: "sg-mark",
		}, g);
		text(g, cx, p.cy + 0.5, due ? "!" : "?", {
			fill: due ? "#0b0b0b" : theme.inkSecondary, "font-size": 9.5, "font-weight": 800, "text-anchor": "middle", "pointer-events": "none",
		});
		svgEl("rect", { x: cx - 10, y: p.cy - 11, width: 20, height: 22, fill: "transparent", "data-part": "body", class: "sg-hit" }, g);
		text(g, p.labelX, p.cy, p.label, { ...labelAttrs, ...halo(theme), fill: due ? theme.ink : theme.inkSecondary, "font-weight": due ? 600 : 500 });
	} else if (p.kind === "entry") {
		svgEl("circle", {
			cx, cy: p.cy, r: 6, fill: p.mood ? MOOD_COLORS[p.mood] : theme.inkSecondary,
			stroke: theme.surface, "stroke-width": 2, class: "sg-mark",
		}, g);
		svgEl("rect", { x: cx - 9, y: p.cy - 10, width: 18, height: 20, fill: "transparent", "data-part": "body", class: "sg-hit" }, g);
	} else if (p.kind === "slot") {
		const due = p.state === "due";
		if (due) svgEl("circle", { cx, cy: p.cy, r: 10, fill: theme.accent, opacity: 0.2, class: "sg-pulse", "pointer-events": "none" }, g);
		svgEl("circle", {
			cx, cy: p.cy, r: p.state === "future" ? 3.5 : 4.5, fill: theme.surface,
			stroke: due ? theme.accent : theme.inkMuted, "stroke-width": due ? 2 : 1.25,
			"stroke-dasharray": p.state === "future" ? "2 2" : null, opacity: p.state === "future" ? 0.45 : p.state === "missed" ? 0.75 : 1, class: "sg-mark",
		}, g);
		svgEl("rect", { x: cx - 9, y: p.cy - 10, width: 18, height: 20, fill: "transparent", "data-part": "body", class: "sg-hit" }, g);
	}
}

/** A milestone's name in a rounded badge tinted with its phase colour. */
function milestoneBadge(g: SVGGElement, p: Placed, color: string, theme: Theme, labelAttrs: Attrs) {
	const h = 22;
	const x = p.labelAnchor === "end" ? p.labelX - p.labelW : p.labelX;
	svgEl("rect", {
		x, y: p.cy - h / 2, width: p.labelW, height: h, rx: h / 2,
		fill: color, "fill-opacity": theme.dark ? 0.22 : 0.12, stroke: color, "stroke-opacity": theme.dark ? 0.5 : 0.35,
		"pointer-events": "none", class: "sg-badge",
	}, g);
	text(g, p.labelAnchor === "end" ? p.labelX - MILESTONE_BADGE_PAD : p.labelX + MILESTONE_BADGE_PAD, p.cy, p.label, {
		...labelAttrs, fill: theme.ink, "font-weight": 600,
	});
}

/** Where the link dot sits: just past the bar, or past its label when the label is beside it. */
export function connectorX(p: Placed): number {
	return !p.labelInside && p.labelAnchor === "start" && p.labelW ? p.labelX + p.labelW + 10 : p.x1 + 8;
}

/** The "drag me onto another item to link" dot, shown on hover. */
function connector(parent: Element, x: number, y: number, color: string, theme: Theme) {
	const c = svgEl("g", { class: "sg-connector", "data-part": "link" }, parent);
	svgEl("circle", { cx: x, cy: y, r: 10, fill: "transparent" }, c);
	svgEl("circle", { cx: x, cy: y, r: 4.5, fill: theme.surface, stroke: color, "stroke-width": 2 }, c);
}

function check(parent: Element, cx: number, cy: number, s: number, stroke: string) {
	svgEl("path", {
		d: `M${cx - s},${cy} L${cx - s * 0.3},${cy + s * 0.75} L${cx + s},${cy - s * 0.7}`,
		fill: "none", stroke, "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round", "pointer-events": "none",
	}, parent);
}

/** A bar outline with rounded corners only on the ends that don't join another bar. */
function barPath(x: number, y: number, w: number, h: number, r: number, roundLeft: boolean, roundRight: boolean): string {
	const rl = roundLeft ? Math.min(r, w / 2, h / 2) : 0;
	const rr = roundRight ? Math.min(r, w / 2, h / 2) : 0;
	const x1 = x + w, y1 = y + h;
	return `M${x + rl},${y} H${x1 - rr} Q${x1},${y} ${x1},${y + rr} V${y1 - rr} Q${x1},${y1} ${x1 - rr},${y1} H${x + rl} Q${x},${y1} ${x},${y1 - rl} V${y + rl} Q${x},${y} ${x + rl},${y} Z`;
}

/** How a deadline's rule is drawn: a quiet dashed line on screen, a clear one on paper. */
function deadlineRule(theme: Theme, print: boolean): Attrs {
	return print
		? { stroke: theme.deadline, "stroke-width": 1.3, "stroke-dasharray": "5 3", opacity: 0.85, "pointer-events": "none" }
		: { stroke: theme.deadline, "stroke-width": 1.25, "stroke-dasharray": "3 3", "stroke-linecap": "round", opacity: 0.6, "pointer-events": "none" };
}

/** A small pennant: pole at x from y to y+2s, flag to the right. */
function flag(parent: Element, x: number, y: number, s: number, fill: string): SVGGElement {
	const g = svgEl("g", { class: "sg-mark" }, parent);
	svgEl("line", { x1: x, x2: x, y1: y, y2: y + 2 * s, stroke: fill, "stroke-width": 1.75, "stroke-linecap": "round" }, g);
	svgEl("path", { d: `M${x + 0.5},${y} L${x + s * 1.25},${y + s * 0.45} L${x + 0.5},${y + s * 0.9} Z`, fill, "stroke-linejoin": "round", stroke: fill, "stroke-width": 1 }, g);
	return g;
}

/** A map pin centred at (x, y). */
function pin(parent: Element, x: number, y: number, fill: string) {
	svgEl("path", {
		d: `M${x},${y + 5.5} C${x - 3.5},${y + 1.5} ${x - 4},${y - 0.5} ${x - 4},${y - 1.5} A4,4 0 1 1 ${x + 4},${y - 1.5} C${x + 4},${y - 0.5} ${x + 3.5},${y + 1.5} ${x},${y + 5.5} Z`,
		fill, "pointer-events": "none",
	}, parent);
	svgEl("circle", { cx: x, cy: y - 1.5, r: 1.5, fill: "#ffffff", "pointer-events": "none" }, parent);
}

// ─── Export: one self-contained SVG with title block and legend ───────────

export interface ExportOptions {
	width?: number;
	labelWidth?: number;
	theme?: Theme;
	includeToday?: boolean;
	today?: number;
	/** Draw the saved plan as dashed outlines (and add it to the legend). */
	compare?: boolean;
}

export function renderExportSvg(project: Project, opts: ExportOptions = {}): SVGSVGElement {
	const theme = opts.theme ?? PRINT_THEME;
	const measure = makeMeasure(theme.font);
	const totalW = opts.width ?? 1900;
	const labelWidth = opts.labelWidth ?? 230;
	const margin = 40;
	const timelineW = totalW - margin * 2 - labelWidth;
	const probe = computeLayout(project, { pxPerDay: 1, showEmptyLanes: false, measure, print: true });
	const days = probe.viewEnd - probe.viewStart + 1;
	const layout = computeLayout(project, { pxPerDay: timelineW / days, showEmptyLanes: false, measure, print: true });
	const compare = !!(opts.compare && project.baseline);
	const paint: PaintOptions = {
		theme, measure, interactive: false, print: true,
		today: opts.includeToday ? (opts.today ?? null) : null,
		plan: compare ? project.baseline : null,
	};

	// Title block, then the chart. No legend: the picture explains itself (see print.ts).
	const titleH = 112;
	const chartTop = titleH;
	const chartH = layout.headerH + layout.bodyH;
	const totalH = chartTop + chartH + margin;

	const svg = svgEl("svg", {
		xmlns: NS, width: totalW, height: totalH, viewBox: `0 0 ${totalW} ${totalH}`, "font-family": theme.font,
	});
	svgEl("rect", { x: 0, y: 0, width: totalW, height: totalH, fill: theme.surface }, svg);

	text(svg, margin, 50, project.title || "Project timeline", { fill: theme.ink, "font-size": 26, "font-weight": 700 });
	const meta = [project.subtitle, project.author].filter(Boolean).join("  ·  ");
	if (meta) text(svg, margin, 80, meta, { fill: theme.inkSecondary, "font-size": 15 });
	text(svg, totalW - margin, 50, formatPeriod(toDay(project.start), toDay(project.end)), {
		fill: theme.ink, "font-size": 15, "font-weight": 600, "text-anchor": "end",
	});
	const updated = formatDay(opts.today ?? toDay(project.start));
	text(svg, totalW - margin, 80, compare ? `Dashed outlines: the plan saved ${formatDay(toDay(project.baseline!.saved))} · updated ${updated}` : `Updated ${updated}`, {
		fill: theme.inkMuted, "font-size": 12, "text-anchor": "end",
	});

	const chart = svgEl("g", { transform: `translate(${margin}, ${chartTop})` }, svg);
	svgEl("rect", { x: 0, y: 0, width: labelWidth, height: layout.headerH, fill: theme.surface }, chart);
	svgEl("line", { x1: 0, x2: labelWidth, y1: layout.headerH - 0.5, y2: layout.headerH - 0.5, stroke: theme.axis }, chart);
	svgEl("line", { x1: labelWidth - 0.5, x2: labelWidth - 0.5, y1: 0, y2: layout.headerH, stroke: theme.axis }, chart);
	nest(chart, paintHeader(layout, paint), labelWidth, 0);
	nest(chart, paintLabels(layout, labelWidth, paint), 0, layout.headerH);
	nest(chart, paintBody(layout, paint), labelWidth, layout.headerH);
	svgEl("rect", {
		x: 0.5, y: 0.5, width: labelWidth + layout.width - 1, height: chartH - 1, rx: 6,
		fill: "none", stroke: theme.axis,
	}, chart);
	return svg;
}

/** "Sep – Dec 2026" or "Sep 2026 – Aug 2027". */
export function formatPeriod(start: number, end: number): string {
	const [sy, sm] = ymd(start);
	const [ey, em] = ymd(end);
	if (sy === ey) return sm === em ? `${MONTHS_LONG[sm]} ${sy}` : `${MONTHS_SHORT[sm]} – ${MONTHS_SHORT[em]} ${sy}`;
	return `${MONTHS_SHORT[sm]} ${sy} – ${MONTHS_SHORT[em]} ${ey}`;
}

export function nest(parent: Element, child: SVGSVGElement, x: number, y: number) {
	child.setAttribute("x", String(x));
	child.setAttribute("y", String(y));
	child.removeAttribute("class");
	parent.appendChild(child);
}

export function svgToString(svg: SVGSVGElement): string {
	return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
}

/** Rasterise an export SVG to a PNG blob at the given scale. */
export function svgToPng(svg: SVGSVGElement, scale = 2): Promise<Blob> {
	return svgToImage(svg, scale, "image/png");
}

/** Rasterise an SVG to PNG or JPEG (for PDF pages). */
export async function svgToImage(svg: SVGSVGElement, scale: number, type: "image/png" | "image/jpeg", quality?: number): Promise<Blob> {
	const w = Number(svg.getAttribute("width"));
	const h = Number(svg.getAttribute("height"));
	const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgToString(svg));
	const img = new Image();
	await new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () => reject(new Error("Could not render image"));
		img.src = src;
	});
	const canvas = createEl("canvas");
	canvas.width = Math.round(w * scale);
	canvas.height = Math.round(h * scale);
	const ctx = canvas.getContext("2d")!;
	ctx.scale(scale, scale);
	ctx.drawImage(img, 0, 0, w, h);
	return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Image encoding failed"))), type, quality));
}
