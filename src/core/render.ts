import { MONTHS_LONG, MONTHS_SHORT, dayFromYmd, formatDay, monthEnd, toDay, weekday, ymd } from "./dates";
import { Lane, Layout, MILESTONE_BADGE_PAD, Measure, Placed, computeLayout } from "./layout";
import { PRINT_THEME, Theme, inkOnFill } from "./theme";
import { earliestAfter } from "./links";
import { isOn } from "./features";
import { ITEM_TYPE_LABELS, Mood, Project, isDone, isRangeType } from "./types";

/** Mood scale for journal dots: diverging red → neutral grey → blue. */
export const MOOD_COLORS: Record<Mood, string> = { 1: "#e34948", 2: "#ec9a8c", 3: "#a9a79f", 4: "#6da7ec", 5: "#2a78d6" };
const WARNING = "#fab219";

const NS = "http://www.w3.org/2000/svg";
type Attrs = Record<string, string | number | undefined | null>;

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element): SVGElementTagNameMap[K] {
	const el = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
	if (parent) parent.appendChild(el);
	return el;
}

function text(parent: Element, x: number, y: number, content: string, attrs: Attrs = {}): SVGTextElement {
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
	for (let year = y0; year <= y1; year++) {
		const from = Math.max(layout.viewStart, dayFromYmd(year, 0, 1));
		const to = Math.min(layout.viewEnd + 1, dayFromYmd(year + 1, 0, 1));
		const x = layout.xOf(from);
		const xEnd = layout.xOf(to);
		if (year !== y0) svgEl("line", { x1: x + 0.5, x2: x + 0.5, y1: 0, y2: layout.headerH, stroke: theme.axis }, svg);
		const tw = o.measure(String(year), 700, 11) + 4;
		const lx = Math.min(Math.max(x, v0) + 8, xEnd - tw - 8);
		text(svg, Math.max(x + 8, lx), layout.g.yearRowH / 2 + 1, String(year), {
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
	for (const p of layout.placed) {
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
		if (lane.kind === "phase" && lane.color) {
			svgEl("rect", { x: ix, y: mid - 12, width: 10, height: 10, rx: 3, fill: theme.palette[lane.color] }, g);
		} else if (lane.kind === "keydates") {
			flag(g, ix + 2, mid - 7, 5.5, theme.deadline);
		} else if (lane.kind === "locations") {
			pin(g, ix + 5, mid - 7, theme.inkSecondary);
		} else if (lane.kind === "journal") {
			svgEl("rect", { x: ix, y: mid - 13, width: 10, height: 12, rx: 2, fill: "none", stroke: theme.inkSecondary, "stroke-width": 1.5 }, g);
			svgEl("path", { d: `M${ix + 3},${mid - 9.5}h4M${ix + 3},${mid - 6.5}h4`, stroke: theme.inkSecondary, "stroke-width": 1.2 }, g);
		} else {
			svgEl("rect", { x: ix, y: mid - 12, width: 10, height: 10, rx: 3, fill: theme.inkMuted }, g);
		}
		const tx = 34 + indent;
		const max = labelWidth - tx - (o.interactive ? 40 : 12);
		text(g, tx, mid - 7, truncate(lane.title, max, measure, 600, 13), {
			fill: theme.ink, "font-size": 13, "font-weight": 600, "pointer-events": "none",
		});
		text(g, tx, mid + 9, truncate(lane.subtitle, max, measure, 400, 11), { fill: theme.inkMuted, "font-size": 11, "pointer-events": "none" });
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
		if (p.item.type !== "deadline" || p.kind !== "item" || isDone(p.item)) continue;
		const x = (p.x0 + p.x1) / 2;
		svgEl("line", {
			x1: x, x2: x, y1: p.cy + 9, y2: layout.bodyH, stroke: theme.deadline,
			"stroke-width": 1, "stroke-dasharray": "2 4", "stroke-linecap": "round", opacity: 0.45, "pointer-events": "none",
		}, svg);
	}

	if (o.today != null && o.today >= layout.viewStart && o.today <= layout.viewEnd) {
		const x = layout.xOf(o.today) + layout.pxPerDay / 2;
		svgEl("line", { x1: x, x2: x, y1: 0, y2: layout.bodyH, stroke: theme.accent, "stroke-width": 1.5, "pointer-events": "none" }, svg);
	}

	const detach = layout.on("links") ? paintLinks(svg, layout, o) : null;

	const items = svgEl("g", { class: "sg-items" }, svg);
	const bufferIds = new Map<string, string>();
	const fills: Fills = {
		hatch: `url(#${hatchId})`,
		buffer: (color) => {
			let id = bufferIds.get(color);
			if (!id) {
				id = `sg-buffer-${++defsCounter}`;
				const pt = svgEl("pattern", { id, width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
				svgEl("rect", { width: 7, height: 7, fill: color, "fill-opacity": 0.12 }, pt);
				svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 7, stroke: color, "stroke-width": 2.4, "stroke-opacity": 0.5 }, pt);
				bufferIds.set(color, id);
			}
			return `url(#${id})`;
		},
	};
	for (const p of layout.placed) paintItem(items, p, layout, o, fills);
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
	/** Hatch in a phase colour, for buffer time. */
	buffer: (color: string) => string;
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
		svgEl("rect", {
			x: p.x0 + 0.5, y: top + 0.5, width: Math.max(2, w - 1), height: layout.g.barH - 1, rx: 6,
			fill: fills.buffer(color), stroke: color, "stroke-opacity": 0.55, class: "sg-mark", "data-part": "body",
		}, g);
		text(g, p.labelX, p.cy, p.label, { ...labelAttrs, ...halo(theme), fill: theme.inkSecondary, "font-style": "italic" });
		if (o.interactive && w >= 14) {
			const hw = Math.min(8, w / 3);
			svgEl("rect", { x: p.x0 - 2, y: top, width: hw + 2, height: layout.g.barH, fill: "transparent", class: "sg-handle", "data-part": "start" }, g);
			svgEl("rect", { x: p.x1 - hw, y: top, width: hw + 2, height: layout.g.barH, fill: "transparent", class: "sg-handle", "data-part": "end" }, g);
		}
		if (o.interactive && layout.on("links")) connector(g, connectorX(p), p.cy, color, theme);
	} else if (it.type === "task") {
		const w = p.x1 - p.x0;
		svgEl("rect", { x: p.x0, y: top, width: w, height: layout.g.barH, rx: Math.min(6, w / 2), fill: color, class: "sg-mark", "data-part": "body" }, g);
		const prog = Math.max(0, Math.min(100, it.progress ?? 0));
		// Progress sits as a slim track just under the bar so it never fights the label.
		if (layout.on("progress") && prog > 0 && prog < 100 && w > 12) {
			const ty = top + layout.g.barH + 2;
			svgEl("rect", { x: p.x0, y: ty, width: w, height: 2.5, rx: 1.25, fill: color, opacity: 0.22, "pointer-events": "none" }, g);
			svgEl("rect", { x: p.x0, y: ty, width: (w * prog) / 100, height: 2.5, rx: 1.25, fill: color, "pointer-events": "none" }, g);
		}
		text(g, p.labelX, p.cy, p.label, {
			...labelAttrs, ...(p.labelInside ? {} : halo(theme)), fill: p.labelInside ? (p.color ? inkOnFill(p.color) : "#ffffff") : theme.ink,
		});
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
			const r = 8.5;
			// A soft glow ring makes milestones stand out from bars and key dates.
			if (!p.lane.collapsed) svgEl("circle", { cx, cy: p.cy, r: 14, fill: color, opacity: theme.dark ? 0.2 : 0.14, "pointer-events": "none", class: "sg-glow" }, g);
			svgEl("path", {
				d: `M${cx},${p.cy - r} L${cx + r},${p.cy} L${cx},${p.cy + r} L${cx - r},${p.cy} Z`,
				fill: p.lane.collapsed ? theme.surface : color, stroke: p.lane.collapsed ? color : theme.surface,
				"stroke-width": 2, "stroke-linejoin": "round", class: "sg-mark", "data-part": "body",
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
		if (it.type === "milestone" && p.label) milestoneBadge(g, p, color, theme, labelAttrs);
		else text(g, p.labelX, p.cy, p.label, { ...labelAttrs, ...halo(theme), fill: theme.ink });
	}
}

/** Elbow arrows from each predecessor's end to its successor's start; red when the order is broken. */
function paintLinks(svg: SVGSVGElement, layout: Layout, o: PaintOptions): Pt | null {
	const { theme } = o;
	const byId = new Map(layout.placed.filter((p) => p.kind === "item").map((p) => [p.item.id, p]));
	const g = svgEl("g", { class: "sg-links", fill: "none", "pointer-events": "none" }, svg);
	let detach: Pt | null = null;
	for (const succ of byId.values()) {
		for (const id of succ.item.after ?? []) {
			const pred = byId.get(id);
			if (!pred || pred.item.dropped || succ.item.dropped) continue;
			const pts = routeLink(pred, succ, layout);
			if (!pts) continue;
			const bad = succ.startDay < earliestAfter(pred.item, succ.item);
			const color = bad ? theme.deadline : theme.inkMuted;
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
			const attrs = { stroke: color, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: bad ? 0.9 : 0.6 };
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

/**
 * Orthogonal route for a finish-to-start link. It leaves from just under (or over) the end of the
 * predecessor, so it never crosses that item's label. Into a bar it runs straight into the start
 * (or drops onto the top edge when the bar starts right away). Milestones, deadlines and key dates
 * are always entered through their top (or bottom) point, which keeps a chain of steps compact.
 */
function routeLink(pred: Placed, succ: Placed, layout: Layout): Pt[] | null {
	const down = succ.cy > pred.cy;
	const sign = down ? 1 : -1;
	const point = (p: Placed) => p.item.type !== "task" && p.item.type !== "location";
	const predHalf = point(pred) ? 9 : pred.lane.markH / 2;
	const succHalf = point(succ) ? 10 : succ.lane.markH / 2;
	const sx = point(pred) ? (pred.x0 + pred.x1) / 2 : pred.x1 - Math.min(7, (pred.x1 - pred.x0) / 2);
	const sy = pred.cy + sign * predHalf;
	const tx = succ.x0 - 2;
	const ty = succ.cy;

	if (Math.abs(pred.cy - succ.cy) < 1) {
		// Same row: a short straight line from the end of the predecessor's footprint (bar or label).
		const from = pred.labelInside || !pred.labelW || pred.labelAnchor === "end" ? pred.x1 + 2 : pred.labelX + pred.labelW + 6;
		return tx - from >= 10 ? [[from, ty], [tx, ty]] : null;
	}
	const edge = succ.cy - sign * (succHalf + 2);
	const gap = succ.cy - sign * (succHalf + (layout.g.rowPitch - layout.g.barH) / 2 + 2);
	if (point(succ)) {
		const cx = (succ.x0 + succ.x1) / 2;
		// Right under the predecessor: a straight drop.
		if (point(pred) ? Math.abs(cx - sx) < 1 : cx >= pred.x0 + 3 && cx <= pred.x1 - 1) return [[cx, sy], [cx, edge]];
		// Nothing to the right of the predecessor: leave from its end, across, then down onto the point.
		const clear = !pred.labelW || pred.labelAnchor === "end" || (!point(pred) && pred.labelInside);
		const ex = pred.x1 + 1;
		if (clear && cx - ex >= 4) return [[ex, pred.cy], [cx, pred.cy], [cx, edge]];
		return [[sx, sy], [sx, gap], [cx, gap], [cx, edge]];
	}
	if (tx - sx >= 12) return [[sx, sy], [sx, ty], [tx, ty]];

	// The successor starts at or before our end: arrive on its near edge instead.
	const cx = Math.max(sx, succ.x0 + 9);
	if (cx === sx && cx <= succ.x1 - 6) return [[sx, sy], [sx, edge]];
	if (cx <= succ.x1 - 6) return [[sx, sy], [sx, gap], [cx, gap], [cx, edge]];
	// Fully backwards: come round through the gap and enter from the left.
	return [[sx, sy], [sx, gap], [tx - 10, gap], [tx - 10, ty], [tx, ty]];
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
	const bx = x - ux * 6, by = y - uy * 6;
	return `M${x},${y} L${bx - uy * 3.5},${by + ux * 3.5} L${bx + uy * 3.5},${by - ux * 3.5} Z`;
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
		svgEl("rect", {
			x: p.x0 + 0.75, y: top + 0.75, width: Math.max(2, p.x1 - p.x0 - 1.5), height: layout.g.barH - 1.5, rx: 6,
			fill: color, "fill-opacity": 0.1, stroke: color, "stroke-width": 1.5, "stroke-dasharray": "5 3",
			class: "sg-mark", "data-part": "body",
		}, g);
		text(g, p.labelX, p.cy, p.label, { ...labelAttrs, ...(p.labelInside ? {} : halo(theme)), fill: p.labelInside ? color : theme.inkSecondary, "font-style": "italic", "font-weight": 600 });
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
	const probe = computeLayout(project, { pxPerDay: 1, showEmptyLanes: false, measure });
	const days = probe.viewEnd - probe.viewStart + 1;
	const layout = computeLayout(project, { pxPerDay: timelineW / days, showEmptyLanes: false, measure });
	const paint: PaintOptions = {
		theme, measure, interactive: false,
		today: opts.includeToday ? (opts.today ?? null) : null,
		plan: opts.compare ? project.baseline : null,
	};

	// Title block
	const titleH = 112;
	const legend = buildLegend(project, theme, measure, totalW - margin * 2, !!(opts.compare && project.baseline));
	const chartTop = titleH;
	const chartH = layout.headerH + layout.bodyH;
	const totalH = chartTop + chartH + 28 + legend.height + margin;

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
	text(svg, totalW - margin, 80, `Updated ${formatDay(opts.today ?? toDay(project.start))}`, {
		fill: theme.inkMuted, "font-size": 12, "text-anchor": "end",
	});

	const chart = svgEl("g", { transform: `translate(${margin}, ${chartTop})` }, svg);
	const corner = svgEl("g", {}, chart);
	svgEl("rect", { x: 0, y: 0, width: labelWidth, height: layout.headerH, fill: theme.surface }, corner);
	text(corner, 16, layout.headerH - layout.g.monthRowH / 2 - (layout.showWeeks ? layout.g.weekRowH : 0), "PHASE", {
		fill: theme.inkMuted, "font-size": 10, "font-weight": 700, "letter-spacing": "0.08em",
	});
	svgEl("line", { x1: 0, x2: labelWidth, y1: layout.headerH - 0.5, y2: layout.headerH - 0.5, stroke: theme.axis }, corner);
	svgEl("line", { x1: labelWidth - 0.5, x2: labelWidth - 0.5, y1: 0, y2: layout.headerH, stroke: theme.axis }, corner);
	nest(chart, paintHeader(layout, paint), labelWidth, 0);
	nest(chart, paintLabels(layout, labelWidth, paint), 0, layout.headerH);
	nest(chart, paintBody(layout, paint), labelWidth, layout.headerH);
	svgEl("rect", {
		x: 0.5, y: 0.5, width: labelWidth + layout.width - 1, height: chartH - 1, rx: 6,
		fill: "none", stroke: theme.axis,
	}, chart);

	const lg = legend.node;
	lg.setAttribute("transform", `translate(${margin}, ${chartTop + chartH + 28})`);
	svg.appendChild(lg);
	return svg;
}

/** "Sep – Dec 2026" or "Sep 2026 – Aug 2027". */
function formatPeriod(start: number, end: number): string {
	const [sy, sm] = ymd(start);
	const [ey, em] = ymd(end);
	if (sy === ey) return sm === em ? `${MONTHS_LONG[sm]} ${sy}` : `${MONTHS_SHORT[sm]} – ${MONTHS_SHORT[em]} ${sy}`;
	return `${MONTHS_SHORT[sm]} ${sy} – ${MONTHS_SHORT[em]} ${ey}`;
}

function nest(parent: Element, child: SVGSVGElement, x: number, y: number) {
	child.setAttribute("x", String(x));
	child.setAttribute("y", String(y));
	child.removeAttribute("class");
	parent.appendChild(child);
}

function buildLegend(project: Project, theme: Theme, measure: Measure, maxW: number, compare = false): { node: SVGGElement; height: number } {
	const g = svgEl("g", {});
	const entries: { draw: (g: SVGGElement, x: number, y: number) => void; label: string }[] = [];
	for (const ph of project.phases)
		entries.push({ label: ph.name, draw: (g, x, y) => svgEl("rect", { x, y: y - 6, width: 18, height: 12, rx: 3, fill: theme.palette[ph.color] }, g) });
	const present = new Set(project.items.filter((i) => (i.type !== "location" || isOn(project, "locations")) && (i.type !== "event" || isOn(project, "events"))).map((i) => i.type));
	const symbols: [keyof typeof ITEM_TYPE_LABELS, (g: SVGGElement, x: number, y: number) => void][] = [
		["task", (g, x, y) => svgEl("rect", { x, y: y - 6, width: 18, height: 12, rx: 3, fill: theme.inkMuted }, g)],
		["milestone", (g, x, y) => svgEl("path", { d: `M${x + 9},${y - 7} L${x + 16},${y} L${x + 9},${y + 7} L${x + 2},${y} Z`, fill: theme.inkSecondary }, g)],
		["deadline", (g, x, y) => flag(g, x + 6, y - 7, 7, theme.deadline)],
		["event", (g, x, y) => svgEl("circle", { cx: x + 9, cy: y, r: 5, fill: theme.inkSecondary }, g)],
		["location", (g, x, y) => {
			svgEl("rect", { x: x + 0.5, y: y - 6.5, width: 17, height: 13, rx: 6.5, fill: theme.surfaceAlt, stroke: theme.axis }, g);
			for (let i = 0; i < 3; i++) svgEl("line", { x1: x + 4 + i * 4, y1: y + 5, x2: x + 8 + i * 4, y2: y - 5, stroke: theme.axis }, g);
		}],
	];
	const symbolEntries = symbols.filter(([t]) => present.has(t)).map(([t, draw]) => ({ label: ITEM_TYPE_LABELS[t], draw }));
	const pending = isOn(project, "planb") ? project.items.filter((i) => i.planB && !i.planB.status && !isDone(i) && !i.dropped) : [];
	if (pending.some((i) => i.planB!.start))
		symbolEntries.push({ label: "Plan B (contingency)", draw: (g, x, y) => svgEl("rect", { x: x + 0.75, y: y - 5.5, width: 16.5, height: 11, rx: 3, fill: theme.inkMuted, "fill-opacity": 0.12, stroke: theme.inkSecondary, "stroke-width": 1.25, "stroke-dasharray": "3 2" }, g) });
	if (pending.length)
		symbolEntries.push({ label: "Decision point", draw: (g, x, y) => svgEl("path", { d: `M${x + 9},${y - 6.5} L${x + 15.5},${y} L${x + 9},${y + 6.5} L${x + 2.5},${y} Z`, fill: "none", stroke: theme.inkSecondary, "stroke-width": 1.5 }, g) });
	if (project.items.some((i) => i.buffer))
		symbolEntries.push({ label: "Buffer time", draw: (g, x, y) => {
			svgEl("rect", { x: x + 0.5, y: y - 5.5, width: 17, height: 11, rx: 3, fill: theme.surfaceAlt, stroke: theme.inkMuted }, g);
			for (let i = 0; i < 3; i++) svgEl("line", { x1: x + 3 + i * 5, y1: y + 5, x2: x + 8 + i * 5, y2: y - 5, stroke: theme.inkMuted, "stroke-width": 1.4 }, g);
		} });
	if (isOn(project, "links") && project.items.some((i) => i.after?.length))
		symbolEntries.push({ label: "Comes after", draw: (g, x, y) => {
			svgEl("path", { d: `M${x},${y - 4} h5 V${y + 3} H${x + 17}`, fill: "none", stroke: theme.inkMuted, "stroke-width": 1.25 }, g);
			svgEl("path", { d: `M${x + 12},${y - 0.5} L${x + 18},${y + 3} L${x + 12},${y + 6.5} Z`, fill: theme.inkMuted }, g);
		} });
	if (compare && project.baseline)
		symbolEntries.push({ label: `Saved plan (${formatDay(toDay(project.baseline.saved))})`, draw: (g, x, y) => svgEl("rect", { x: x + 0.75, y: y - 5.5, width: 16.5, height: 11, rx: 3, fill: "none", stroke: theme.inkMuted, "stroke-width": 1.25, "stroke-dasharray": "3 3" }, g) });
	if (project.items.some((i) => i.dropped))
		symbolEntries.push({ label: "Dropped", draw: (g, x, y) => svgEl("rect", { x, y: y - 6, width: 18, height: 12, rx: 3, fill: theme.inkMuted, opacity: 0.42 }, g) });

	let y = 0;
	const rowH = 26;
	const place = (list: typeof entries, heading: string) => {
		if (!list.length) return;
		text(g, 0, y + 9, heading, { fill: theme.inkMuted, "font-size": 10, "font-weight": 700, "letter-spacing": "0.08em" });
		let x = 92;
		for (const e of list) {
			const w = 26 + measure(e.label, 500, 12) + 22;
			if (x + w > maxW && x > 92) {
				x = 92;
				y += rowH;
			}
			e.draw(g, x, y + 9);
			text(g, x + 26, y + 9, e.label, { fill: theme.inkSecondary, "font-size": 12, "font-weight": 500 });
			x += w;
		}
		y += rowH;
	};
	place(entries, "PHASES");
	place(symbolEntries, "KEY");
	return { node: g, height: y };
}

export function svgToString(svg: SVGSVGElement): string {
	return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
}

/** Rasterise an export SVG to a PNG blob at the given scale. */
export async function svgToPng(svg: SVGSVGElement, scale = 2): Promise<Blob> {
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
	return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"));
}
