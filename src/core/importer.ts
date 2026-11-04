import { dayFromYmd, daysInMonth, fromDay, toDay } from "./dates";
import { parseQuickAdd } from "./parse";
import { GanttItem, ItemType, Phase, Project, addPhase, cloneProject, isCheckable, isRangeType, newId, slugify } from "./types";

/**
 * Bring a plan in from somewhere else. The format is detected from the text:
 *  - a table copied from Excel / Google Sheets / Numbers (tab separated), or a CSV / TSV file
 *  - a Markdown table (including Simple Gantt's own "Copy as Markdown table")
 *  - a Mermaid gantt chart (```mermaid gantt …```), common in Obsidian notes
 *  - one item per line, in quick-add style ("Pilot study 18 Jan for 4 weeks #methods")
 */

export type ImportFormat = "table" | "markdown" | "mermaid" | "list";

export const FORMAT_LABELS: Record<ImportFormat, string> = {
	table: "Spreadsheet / CSV",
	markdown: "Markdown table",
	mermaid: "Mermaid gantt chart",
	list: "List, one item per line",
};

export interface ImportPreview {
	format: ImportFormat;
	/** Ready to add: fresh ids, phase ids that exist in the project or in `newPhases`. */
	items: GanttItem[];
	/** Phases that will be created. */
	newPhases: Phase[];
	/** Rows that couldn't be read, with the reason. */
	skipped: string[];
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function parseImport(input: string, project: Project, today: string): ImportPreview | null {
	const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	if (!text.trim()) return null;
	const ctx = new Ctx(project, today);
	const fence = /```mermaid[^\n]*\n([\s\S]*?)```/.exec(text);
	const mermaid = fence ? fence[1] : /^\s*gantt\s*$/m.test(text) ? text : null;
	if (mermaid !== null) return ctx.finish("mermaid", readMermaid(mermaid, ctx));
	const md = markdownRows(text);
	if (md) return ctx.finish("markdown", readTable(md, ctx));
	const table = delimitedRows(text);
	if (table) return ctx.finish("table", readTable(table, ctx));
	return ctx.finish("list", readList(text, ctx));
}

/** Add the previewed items (and their new phases) to the project; widen its period if needed. */
export function applyImport(project: Project, preview: ImportPreview): { widened: boolean } {
	for (const ph of preview.newPhases) if (!project.phases.some((p) => p.id === ph.id)) project.phases.push({ ...ph });
	project.items.push(...preview.items.map((i) => cloneProject({ items: [i] } as unknown as Project).items[0]));
	let widened = false;
	for (const it of preview.items) {
		if (it.start < project.start) {
			project.start = it.start;
			widened = true;
		}
		const end = it.end ?? it.start;
		if (end > project.end) {
			project.end = end;
			widened = true;
		}
	}
	return { widened };
}

// ─── Shared state while reading ──────────────────────────────────────────────

interface Draft {
	item: GanttItem;
	/** Ids, titles or row numbers this item comes after; resolved at the end. */
	refs: string[];
	/** Its id in the source (Mermaid id, an "id" column), for references. */
	sourceId?: string;
	row: number;
}

class Ctx {
	/** A copy to create phases on, so new ids and colours match what applyImport will add. */
	private sim: Project;
	newPhases: Phase[] = [];
	skipped: string[] = [];

	constructor(public project: Project, public today: string) {
		this.sim = cloneProject(project);
	}

	/** An existing phase id for a name, or a new phase. */
	phaseFor(name: string | undefined): string | undefined {
		const n = name?.trim();
		if (!n) return undefined;
		const slug = slugify(n);
		const hit = this.sim.phases.find((p) => p.id === n || p.name.toLowerCase() === n.toLowerCase() || slugify(p.name) === slug);
		if (hit) return hit.id;
		const ph = addPhase(this.sim, n);
		this.newPhases.push(ph);
		return ph.id;
	}

	finish(format: ImportFormat, drafts: Draft[]): ImportPreview {
		// Links: by source id, then by row number, then by title (imported first, then what's already there).
		const bySource = new Map(drafts.filter((d) => d.sourceId).map((d) => [d.sourceId!.toLowerCase(), d.item.id]));
		const byRow = new Map(drafts.map((d) => [String(d.row), d.item.id]));
		const byTitle = new Map<string, string>();
		for (const it of this.project.items) byTitle.set(it.title.toLowerCase(), it.id);
		for (const d of drafts) byTitle.set(d.item.title.toLowerCase(), d.item.id);
		for (const d of drafts) {
			const after = d.refs
				.map((r) => r.trim().replace(/\s*(fs|ss|ff|sf)?\s*([+-]\s*\d+\s*\w*)?$/i, ""))
				.filter(Boolean)
				.map((r) => bySource.get(r.toLowerCase()) ?? (/^\d+$/.test(r) ? byRow.get(r) : undefined) ?? byTitle.get(r.toLowerCase()))
				.filter((id): id is string => !!id && id !== d.item.id);
			if (after.length) d.item.after = [...new Set(after)];
		}
		const used = new Set(drafts.map((d) => d.item.phase));
		return { format, items: drafts.map((d) => d.item), newPhases: this.newPhases.filter((p) => used.has(p.id)), skipped: this.skipped };
	}
}

// ─── Tables (spreadsheet, CSV, TSV, Markdown) ───────────────────────────────

type Field = "title" | "phase" | "type" | "start" | "end" | "duration" | "progress" | "status" | "after" | "notes" | "id";

const HEADERS: [Field, RegExp][] = [
	["id", /^(id|key|#|no\.?|nr\.?|wbs)$/],
	["title", /^(item|task|task name|name|title|activity|summary|what|description of work|deliverable)$/],
	["phase", /^(phase|section|group|category|stage|workstream|work package|epic|area|parent)$/],
	["type", /^(type|kind|item type)$/],
	["start", /^(start|start date|begin|begins|from|starts|start on|planned start|date|when)$/],
	["end", /^(end|end date|finish|finish date|due|due date|to|until|ends|end on|planned end|deadline)$/],
	["duration", /^(duration|days|length|time|effort)$/],
	["progress", /^(progress|% ?complete|percent complete|complete|%|done %|% done)$/],
	["status", /^(status|state|done|completed?)$/],
	["after", /^(starts after|after|depends on|dependencies|dependency|predecessors?|blocked by)$/],
	["notes", /^(notes?|description|details|comments?)$/],
];

function fieldOf(header: string): Field | null {
	const h = header.trim().toLowerCase().replace(/\s+/g, " ").replace(/[:*]$/, "");
	for (const [f, re] of HEADERS) if (re.test(h)) return f;
	return null;
}

/** A Markdown table: | a | b | with a |---| row. */
function markdownRows(text: string): string[][] | null {
	const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
	if (lines.length < 3 || !/^\|?\s*:?-{3,}/.test(lines[1])) return null;
	const cells = (l: string) => l.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
	return [cells(lines[0]), ...lines.slice(2).map(cells)];
}

/** Tab, semicolon or comma separated, with quoted cells (RFC 4180). Needs a header row we recognise. */
function delimitedRows(text: string): string[][] | null {
	const first = text.split("\n").find((l) => l.trim()) ?? "";
	const delim = ["\t", ";", ","].map((d) => [d, first.split(d).length - 1] as const).sort((a, b) => b[1] - a[1])[0];
	if (!delim || delim[1] < 1) return null;
	const rows = parseDelimited(text, delim[0]);
	const fields = rows[0]?.map(fieldOf) ?? [];
	return fields.includes("title") && (fields.includes("start") || fields.includes("end")) ? rows : null;
}

function parseDelimited(text: string, d: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"' && !cell.trim()) {
			quoted = true;
			cell = "";
		} else if (c === d) {
			row.push(cell.trim());
			cell = "";
		} else if (c === "\n") {
			row.push(cell.trim());
			if (row.some((x) => x)) rows.push(row);
			row = [];
			cell = "";
		} else cell += c;
	}
	row.push(cell.trim());
	if (row.some((x) => x)) rows.push(row);
	return rows;
}

function readTable(rows: string[][], ctx: Ctx): Draft[] {
	const fields = rows[0].map(fieldOf);
	const col = (f: Field) => fields.indexOf(f);
	const at = (r: string[], f: Field) => (col(f) >= 0 ? (r[col(f)] ?? "").trim() : "");
	const data = rows.slice(1).filter((r) => r.some((c) => c.trim()));
	const order = dateOrder(data.flatMap((r) => [at(r, "start"), at(r, "end")]));
	const out: Draft[] = [];
	data.forEach((r, i) => {
		const title = at(r, "title");
		const rowNo = i + 1;
		if (!title) return void ctx.skipped.push(`Row ${rowNo}: no title`);
		let start = readDate(at(r, "start"), order, ctx);
		let end = readDate(at(r, "end"), order, ctx);
		const dur = readDuration(at(r, "duration"));
		if (start === null && end !== null) start = dur ? end - dur + 1 : end;
		if (start === null) return void ctx.skipped.push(`“${title}”: no date`);
		if (end === null && dur) end = start + dur - 1;
		const typeCell = at(r, "type").toLowerCase();
		const { type, buffer } = readType(typeCell, title, start, end);
		const item: GanttItem = { id: newId(), type, title, start: fromDay(start) };
		if (isRangeType(type)) item.end = fromDay(Math.max(start, end ?? start));
		if (buffer) item.buffer = true;
		const phase = ctx.phaseFor(at(r, "phase"));
		if (phase) item.phase = phase;
		applyStatus(item, at(r, "progress"), at(r, "status"));
		const notes = at(r, "notes");
		if (notes && notes !== title) item.description = notes;
		out.push({ item, refs: splitRefs(at(r, "after")), sourceId: at(r, "id") || undefined, row: rowNo });
	});
	return out;
}

function splitRefs(cell: string): string[] {
	return cell ? cell.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];
}

function readType(cell: string, title: string, start: number, end: number | null): { type: ItemType; buffer: boolean } {
	if (/buffer|slack|float/.test(cell)) return { type: "task", buffer: true };
	if (/milestone|^ms$|◆/.test(cell)) return { type: "milestone", buffer: false };
	if (/deadline|due/.test(cell)) return { type: "deadline", buffer: false };
	if (/key ?date|event|meeting|conference/.test(cell)) return { type: "event", buffer: false };
	if (/location|place|where|trip|travel/.test(cell)) return { type: "location", buffer: false };
	if (/task|activity|work|summary/.test(cell)) return { type: "task", buffer: false };
	// No type given: a single day is a milestone (or a deadline, by its name); a span is a task.
	if (end === null || end === start) return { type: /\b(deadline|due|submission|submit|hand-?in)\b/i.test(title) ? "deadline" : "milestone", buffer: false };
	return { type: "task", buffer: false };
}

function applyStatus(item: GanttItem, progressCell: string, statusCell: string) {
	const p = /^(\d+(?:[.,]\d+)?)\s*%?$/.exec(progressCell);
	if (p && item.type === "task") {
		let n = parseFloat(p[1].replace(",", "."));
		if (n > 0 && n <= 1 && !progressCell.includes("%") && p[1].includes(".")) n *= 100;
		if (n > 0) item.progress = Math.min(100, Math.round(n));
	}
	// The status column may hold a percentage too (Simple Gantt's own table does).
	const sp = /^(\d{1,3})\s*%$/.exec(statusCell);
	if (sp && !item.progress && item.type === "task" && +sp[1] > 0) item.progress = Math.min(100, +sp[1]);
	const done = /^(done|complete|completed|finished|closed|resolved|yes|true|✓|✔|x|☑|100 ?%)(?=\s|$)/i.test(statusCell) || item.progress === 100;
	if (done && isCheckable(item)) {
		item.done = true;
		if (item.type === "task") item.progress = 100;
	}
}

// ─── Dates and durations ─────────────────────────────────────────────────────

/** Day-first unless the column shows month-first (a "middle" number above 12). */
function dateOrder(cells: string[]): "dmy" | "mdy" {
	let dmy = false, mdy = false;
	for (const c of cells) {
		const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(c.trim());
		if (!m) continue;
		if (+m[1] > 12) dmy = true;
		if (+m[2] > 12) mdy = true;
	}
	return mdy && !dmy ? "mdy" : "dmy";
}

function validDay(y: number, m: number, d: number): number | null {
	if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m - 1)) return null;
	return dayFromYmd(y, m - 1, d);
}

function readDate(cell: string, order: "dmy" | "mdy", ctx: Ctx): number | null {
	const s = cell.trim();
	if (!s || /^(-|–|n\/a|tbd|tba)$/i.test(s)) return null;
	let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
	if (m) return validDay(+m[1], +m[2], +m[3]);
	m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(s);
	if (m) {
		const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
		return order === "mdy" ? validDay(y, +m[1], +m[2]) : validDay(y, +m[2], +m[1]);
	}
	// Excel / Sheets date serials (days since 1899-12-30).
	if (/^\d{5}(\.\d+)?$/.test(s) && +s > 20000 && +s < 80000) return Math.floor(+s) - 25569;
	const r = parseQuickAdd(`x ${s}`, { project: ctx.project, defaultType: "task", today: ctx.today });
	return r && !r.dateGuessed ? toDay(r.start) : null;
}

/** "5", "5d", "3 weeks", "2 months" → days. */
function readDuration(cell: string): number | null {
	const m = /^(\d+(?:[.,]\d+)?)\s*(d|days?|w|wks?|weeks?|mo|mos?|months?|h|hrs?|hours?)?$/i.exec(cell.trim());
	if (!m) return null;
	const n = parseFloat(m[1].replace(",", "."));
	const u = (m[2] ?? "d").toLowerCase();
	const days = u.startsWith("w") ? n * 7 : u.startsWith("mo") ? n * 30 : u.startsWith("h") ? n / 8 : n;
	return Math.max(1, Math.round(days));
}

// ─── Mermaid gantt ───────────────────────────────────────────────────────────

function readMermaid(src: string, ctx: Ctx): Draft[] {
	const out: Draft[] = [];
	let phase: string | undefined;
	let format = "YYYY-MM-DD";
	let prevEnd: number | null = null;
	const ends = new Map<string, { start: number; end: number; id: string }>();
	let row = 0;
	for (const raw of src.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("%%") || /^gantt\b/.test(line)) continue;
		const kw = /^(title|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|displayMode|inclusiveEndDates|topAxis)\b\s*(.*)$/.exec(line);
		if (kw) {
			if (kw[1] === "dateFormat") format = kw[2].trim();
			continue;
		}
		const sec = /^section\s+(.+)$/.exec(line);
		if (sec) {
			phase = ctx.phaseFor(sec[1]);
			continue;
		}
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		row++;
		const title = line.slice(0, colon).trim();
		const tokens = line.slice(colon + 1).split(",").map((t) => t.trim()).filter(Boolean);
		const tags = new Set<string>();
		while (tokens.length && /^(done|active|crit|milestone|vert)$/.test(tokens[0])) tags.add(tokens.shift()!);
		const [id, startTok, endTok] = tokens.length >= 3 ? tokens : tokens.length === 2 ? [undefined, tokens[0], tokens[1]] : [undefined, undefined, tokens[0]];
		const refs: string[] = [];
		let start: number | null = null;
		const after = startTok ? /^after\s+(.+)$/.exec(startTok) : null;
		if (after) {
			for (const r of after[1].split(/\s+/)) {
				refs.push(r);
				const e = ends.get(r);
				if (e) start = Math.max(start ?? -Infinity, e.end + 1);
			}
		} else if (startTok) start = mermaidDate(startTok, format);
		if (start === null && prevEnd !== null) start = prevEnd + 1;
		if (start === null || !title) {
			ctx.skipped.push(`“${title || line}”: no start date`);
			continue;
		}
		let end: number | null = null;
		const until = endTok ? /^until\s+(\S+)/.exec(endTok) : null;
		if (until) end = (ends.get(until[1])?.start ?? start + 1) - 1;
		else if (endTok) {
			const dur = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i.exec(endTok);
			if (dur) {
				const n = +dur[1];
				const u = dur[2].toLowerCase();
				const days = u === "w" ? n * 7 : u === "d" ? n : u === "h" ? n / 24 : 0;
				end = start + Math.max(0, Math.ceil(days) - 1);
			} else end = mermaidDate(endTok, format);
		}
		const milestone = tags.has("milestone") || tags.has("vert");
		if (end === null || end < start) end = start;
		const type: ItemType = milestone ? (/\b(deadline|due|submission|hand-?in)\b/i.test(title) ? "deadline" : "milestone") : "task";
		const item: GanttItem = { id: newId(), type, title, start: fromDay(start) };
		if (type === "task") item.end = fromDay(end);
		if (phase && (type === "task" || type === "milestone")) item.phase = phase;
		if (tags.has("done")) {
			item.done = true;
			if (type === "task") item.progress = 100;
		}
		out.push({ item, refs, sourceId: id, row });
		if (id) ends.set(id, { start, end, id: item.id });
		prevEnd = end;
	}
	return out;
}

/** Mermaid dates in its dateFormat (the common ones), falling back to the flexible reader. */
function mermaidDate(s: string, format: string): number | null {
	const f = format.toUpperCase().replace(/[^YMD]/g, "");
	const parts = s.split(/[^0-9]/).filter(Boolean).map(Number);
	if (parts.length >= 3) {
		const idx = (c: string) => ["Y", "M", "D"].indexOf(c);
		const order = [...new Set(f.split(""))];
		if (order.length === 3 && order.every((c) => idx(c) >= 0)) {
			const v: Record<string, number> = {};
			order.forEach((c, i) => (v[c] = parts[i]));
			const y = v.Y < 100 ? 2000 + v.Y : v.Y;
			return validDay(y, v.M, v.D);
		}
	}
	const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
	return iso ? validDay(+iso[1], +iso[2], +iso[3]) : null;
}

// ─── Lists in quick-add style ────────────────────────────────────────────────

function readList(text: string, ctx: Ctx): Draft[] {
	const out: Draft[] = [];
	let row = 0;
	let heading: string | undefined;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		// A Markdown heading becomes the phase for the lines under it.
		const h = /^#{1,6}\s+(.+)$/.exec(line);
		if (h) {
			heading = h[1].trim();
			continue;
		}
		row++;
		const check = /^(?:[-*+]|\d+[.)])?\s*\[([ xX✓])\]\s*/.exec(line);
		const body = line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^\[[ xX✓]\]\s*/, "");
		const r = parseQuickAdd(body, { project: ctx.project, defaultType: "task", today: ctx.today });
		if (!r || r.dateGuessed) {
			ctx.skipped.push(`“${body.slice(0, 60)}”: no date`);
			continue;
		}
		const item: GanttItem = { id: newId(), type: r.type, title: r.title || "Untitled", start: r.start };
		if (r.end && isRangeType(r.type)) item.end = r.end;
		const phase = r.phase ?? ctx.phaseFor(r.newPhase ?? heading);
		if (phase) item.phase = phase;
		if (r.progress !== undefined && r.type === "task") item.progress = r.progress;
		if (r.buffer) item.buffer = true;
		if (check && /[xX✓]/.test(check[1]) && isCheckable(item)) {
			item.done = true;
			if (item.type === "task") item.progress = 100;
		}
		out.push({ item, refs: [], row });
	}
	return out;
}
