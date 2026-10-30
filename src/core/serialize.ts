import { fromDay, isIsoDate, toDay } from "./dates";
import { pruneLinks } from "./links";
import { ALL_FEATURES } from "./features";
import { formatInterval, parseInterval } from "./baseline";
import {
	CHECKIN_LABELS, COLOR_ORDER, CheckIn, ColorName, GanttItem, ITEM_TYPES, ItemType, JournalEntry, Mood, Phase, Project,
	isCheckable, isRangeType, newId, slugify,
} from "./types";

/**
 * A project lives in a normal Markdown note:
 *
 *   ---
 *   simple-gantt: true
 *   ---
 *   ```simple-gantt
 *   title: …
 *   items: …
 *   ```
 *
 * The YAML inside the fenced block is the source of truth; anything else in the note is yours.
 */

export const BLOCK_LANG = "simple-gantt";
export const FRONTMATTER_KEY = "simple-gantt";
const BLOCK_RE = /^```simple-gantt[^\n]*\n([\s\S]*?)^```[ \t]*$/m;

export function extractBlock(markdown: string): string | null {
	const m = BLOCK_RE.exec(markdown);
	return m ? m[1] : null;
}

/** Replace the data block (or append one) and return the new note text. */
export function replaceBlock(markdown: string, yaml: string): string {
	const block = "```" + BLOCK_LANG + "\n" + yaml.replace(/\n*$/, "\n") + "```";
	if (BLOCK_RE.test(markdown)) return markdown.replace(BLOCK_RE, () => block);
	return markdown.replace(/\n*$/, "\n\n") + block + "\n";
}

export function noteTemplate(yaml: string): string {
	return [
		"---",
		`${FRONTMATTER_KEY}: true`,
		"---",
		"",
		"Open this timeline with the **Simple Gantt** button in the left ribbon. The block below stores its data and shows a preview in reading view.",
		"",
		"```" + BLOCK_LANG,
		yaml.replace(/\n*$/, ""),
		"```",
		"",
	].join("\n");
}

function asDate(v: unknown): string | null {
	if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
	if (typeof v === "string") {
		const s = v.trim();
		if (isIsoDate(s)) return s;
		const loose = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
		if (loose) return fromDay(Math.round(Date.UTC(+loose[1], +loose[2] - 1, +loose[3]) / 86400000));
	}
	return null;
}

function asText(v: unknown): string | undefined {
	const s = typeof v === "string" ? v.trim()
		: typeof v === "number" || typeof v === "boolean" ? String(v)
			: v instanceof Date && !isNaN(v.getTime()) ? v.toISOString().slice(0, 10)
				: "";
	return s || undefined;
}

/** Turn whatever the YAML contained into a valid project, repairing what it can. */
export function normalizeProject(raw: unknown, fallbackTitle = "Untitled project"): Project {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const today = new Date().toISOString().slice(0, 10);
	let start = asDate(r.start) ?? today;
	let end = asDate(r.end) ?? fromDay(toDay(start) + 364);
	if (end < start) [start, end] = [end, start];

	const project: Project = {
		title: asText(r.title) ?? fallbackTitle,
		start,
		end,
		phases: [],
		items: [],
	};
	const subtitle = asText(r.subtitle);
	const author = asText(r.author);
	if (subtitle) project.subtitle = subtitle;
	if (author) project.author = author;

	const usedIds = new Set<string>();
	for (const ph of Array.isArray(r.phases) ? r.phases : []) {
		const o = (ph && typeof ph === "object" ? ph : { name: ph }) as Record<string, unknown>;
		const name = asText(o.name) ?? asText(o.id) ?? "Phase";
		let id = asText(o.id) ?? slugify(name);
		while (usedIds.has(id)) id += "-2";
		usedIds.add(id);
		const color = (COLOR_ORDER as string[]).includes(String(o.color))
			? (o.color as ColorName)
			: COLOR_ORDER[project.phases.length % COLOR_ORDER.length];
		const phase: Phase = { id, name, color };
		if (o.collapsed === true || String(o.collapsed) === "true") phase.collapsed = true;
		project.phases.push(phase);
	}

	const itemIds = new Set<string>();
	for (const it of Array.isArray(r.items) ? r.items : []) {
		if (!it || typeof it !== "object") continue;
		const o = it as Record<string, unknown>;
		const type: ItemType = (ITEM_TYPES as string[]).includes(String(o.type)) ? (o.type as ItemType) : "task";
		const s = asDate(o.start) ?? asDate(o.date) ?? start;
		let id = asText(o.id) ?? newId();
		while (itemIds.has(id)) id = newId();
		itemIds.add(id);
		const item: GanttItem = { id, type, title: asText(o.title) ?? "Untitled", start: s };
		if (isRangeType(type)) {
			const e = asDate(o.end) ?? s;
			item.end = e < s ? s : e;
		}
		const phase = asText(o.phase);
		if (phase) {
			const match = project.phases.find((p) => p.id === phase) ?? project.phases.find((p) => p.name.toLowerCase() === phase.toLowerCase());
			item.phase = match ? match.id : phase;
		}
		if (type === "task" && o.progress !== undefined && o.progress !== null) {
			const n = Math.round(typeof o.progress === "number" ? o.progress : typeof o.progress === "string" ? Number(o.progress.replace("%", "")) : NaN);
			if (!isNaN(n) && n > 0) item.progress = Math.min(100, n);
		}
		const note = asText(o.note);
		const description = asText(o.description);
		if (note) item.note = note;
		if (description) item.description = description;
		if (isCheckable(item)) {
			if (o.done === true || String(o.done) === "true") item.done = true;
			if (item.type === "task" && item.progress === 100) item.done = true;
			const doneOn = asDate(o.doneOn);
			if (item.done && doneOn) item.doneOn = doneOn;
			const rv = o.review && typeof o.review === "object" ? (o.review as Record<string, unknown>) : null;
			if (rv) {
				const mood = asMood(rv.mood);
				const text = asText(rv.text);
				if (mood || text) item.review = { ...(mood ? { mood } : {}), ...(text ? { text } : {}) };
			}
			const pb = o.planB && typeof o.planB === "object" ? (o.planB as Record<string, unknown>) : null;
			const by = pb && asDate(pb.by);
			if (pb && by) {
				item.planB = { by, title: asText(pb.title) ?? "Alternative" };
				const ps = asDate(pb.start);
				const pe = asDate(pb.end);
				if (ps) {
					item.planB.start = ps;
					item.planB.end = pe && pe >= ps ? pe : ps;
				}
				const pn = asText(pb.note);
				if (pn) item.planB.note = pn;
				if (pb.status === "active" || pb.status === "dismissed") item.planB.status = pb.status;
			}
		}
		if (o.dropped === true || String(o.dropped) === "true") item.dropped = true;
		if (Array.isArray(o.after)) {
			const after = o.after.map((x) => asText(x)).filter((x): x is string => !!x);
			if (after.length) item.after = after;
		}
		if (type === "task" && (o.buffer === true || String(o.buffer) === "true")) item.buffer = true;
		project.items.push(item);
	}

	if (typeof r.checkin === "string" && r.checkin in CHECKIN_LABELS) project.checkin = r.checkin as CheckIn;
	const journal: JournalEntry[] = [];
	for (const e of Array.isArray(r.journal) ? r.journal : []) {
		if (!e || typeof e !== "object") continue;
		const o = e as Record<string, unknown>;
		const date = asDate(o.date);
		const text = asText(o.text) ?? "";
		if (!date || (!text && !o.mood)) continue;
		const entry: JournalEntry = { id: asText(o.id) ?? newId(), date, text };
		const mood = asMood(o.mood);
		if (mood) entry.mood = mood;
		journal.push(entry);
	}
	if (journal.length) project.journal = journal;
	if (Array.isArray(r.skippedCheckins)) {
		const skipped = r.skippedCheckins.map((d) => asDate(d)).filter((d): d is string => !!d);
		if (skipped.length) project.skippedCheckins = [...new Set(skipped)].sort();
	}
	if (r.density === "compact") project.density = "compact";
	if (Array.isArray(r.off)) {
		const off = ALL_FEATURES.filter((f) => (r.off as unknown[]).includes(f));
		if (off.length) project.off = off;
	}
	const bl = r.baseline && typeof r.baseline === "object" ? (r.baseline as Record<string, unknown>) : null;
	const blItems = bl?.items && typeof bl.items === "object" ? (bl.items as Record<string, unknown>) : null;
	if (bl && blItems) {
		const items: Record<string, { start: string; end?: string }> = {};
		for (const [id, v] of Object.entries(blItems)) {
			const iv = parseInterval(v);
			if (iv) items[id] = iv;
		}
		project.baseline = { saved: asDate(bl.saved) ?? today, items };
	}
	pruneLinks(project);
	return project;
}

function asMood(v: unknown): Mood | undefined {
	const n = Math.round(Number(v));
	return n >= 1 && n <= 5 ? (n as Mood) : undefined;
}

/** A plain object with keys in a friendly, stable order for YAML output. */
export function toPlain(project: Project): Record<string, unknown> {
	const out: Record<string, unknown> = { title: project.title };
	if (project.subtitle) out.subtitle = project.subtitle;
	if (project.author) out.author = project.author;
	out.start = project.start;
	out.end = project.end;
	out.phases = project.phases.map((p) => ({ id: p.id, name: p.name, color: p.color, ...(p.collapsed ? { collapsed: true } : {}) }));
	const sorted = [...project.items].sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
	out.items = sorted.map((i) => {
		const o: Record<string, unknown> = { title: i.title, type: i.type };
		if (i.phase) o.phase = i.phase;
		o.start = i.start;
		if (i.end && isRangeType(i.type)) o.end = i.end;
		if (i.progress) o.progress = i.progress;
		if (i.note) o.note = i.note;
		if (i.description) o.description = i.description;
		if (i.done) o.done = true;
		if (i.done && i.doneOn) o.doneOn = i.doneOn;
		if (i.review && (i.review.mood || i.review.text)) o.review = { ...i.review };
		if (i.planB) {
			const pb: Record<string, unknown> = { by: i.planB.by, title: i.planB.title };
			if (i.planB.start) pb.start = i.planB.start;
			if (i.planB.start && i.planB.end) pb.end = i.planB.end;
			if (i.planB.note) pb.note = i.planB.note;
			if (i.planB.status) pb.status = i.planB.status;
			o.planB = pb;
		}
		if (i.dropped) o.dropped = true;
		if (i.buffer) o.buffer = true;
		if (i.after?.length) o.after = [...i.after];
		o.id = i.id;
		return o;
	});
	if (project.checkin) out.checkin = project.checkin;
	if (project.skippedCheckins?.length) out.skippedCheckins = [...project.skippedCheckins];
	if (project.density) out.density = project.density;
	if (project.off?.length) out.off = [...project.off];
	if (project.baseline) {
		const ids = new Set(project.items.map((i) => i.id));
		const items: Record<string, string> = {};
		for (const [id, v] of Object.entries(project.baseline.items)) if (ids.has(id)) items[id] = formatInterval(v);
		out.baseline = { saved: project.baseline.saved, items };
	}
	if (project.journal?.length)
		out.journal = [...project.journal]
			.sort((a, b) => a.date.localeCompare(b.date))
			.map((e) => ({ date: e.date, ...(e.mood ? { mood: e.mood } : {}), text: e.text, id: e.id }));
	return out;
}
