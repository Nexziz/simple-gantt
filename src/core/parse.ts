import { addMonths, dayFromYmd, daysInMonth, fromDay, toDay } from "./dates";
import { ItemType, Project, isRangeType, slugify } from "./types";

/**
 * Quick-add: turn one line of text into a timeline item.
 *
 *   Literature review Jan–Mar #reading       → task, 1 Jan – 31 Mar, phase "reading"
 *   !Ethics deadline 15 Feb                    → deadline on 15 Feb
 *   *Chapter 2 drafted 20 Jan                  → milestone
 *   +Supervisor meeting 3 Dec                  → key date (event)
 *   @Fieldwork Lisbon 22 Feb – 9 Apr           → location
 *   Pilot study 18 Jan for 4 weeks 30%         → task with duration and progress
 */

export interface ParseContext {
	project: Project;
	defaultType: ItemType;
	/** ISO date used when no date is given. */
	today: string;
}

export interface ParseResult {
	type: ItemType;
	title: string;
	start: string;
	end?: string;
	/** Existing phase id, if a #tag matched one. */
	phase?: string;
	/** A #tag that matched no phase: the caller may create it. */
	newPhase?: string;
	progress?: number;
	/** "~" prefix: buffer time (a task kept free to absorb delays). */
	buffer?: boolean;
	/** True when no date was found and defaults were used. */
	dateGuessed: boolean;
}

const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const SEP_RE = "\\s*(?:-|–|—|→|->|to|until|till)\\s*";

function monthIndex(word: string): number {
	return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(word.slice(0, 3).toLowerCase());
}

/** A date as written: day may be missing (month granularity), year may be missing (inferred). */
interface Partial {
	d?: number;
	m: number;
	y?: number;
}

type Matcher = { re: RegExp; read: (m: RegExpExecArray) => Partial[] | null };

const D = "(\\d{1,2})(?:st|nd|rd|th)?";
const Y = "(?:,?\\s*'?(\\d{4}|\\d{2}))?";

const single: Matcher[] = [
	{ re: /(\d{4})-(\d{1,2})-(\d{1,2})/, read: (m) => [{ y: +m[1], m: +m[2] - 1, d: +m[3] }] },
	{ re: /(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})\b/, read: (m) => [{ d: +m[1], m: +m[2] - 1, y: year(m[3]) }] },
	{ re: new RegExp(`\\b${D}\\s+${MONTH_RE}\\b${Y}`, "i"), read: (m) => [{ d: +m[1], m: monthIndex(m[2]), y: year(m[3]) }] },
	{ re: new RegExp(`\\b${MONTH_RE}\\s+${D}\\b${Y}`, "i"), read: (m) => [{ d: +m[2], m: monthIndex(m[1]), y: year(m[3]) }] },
	{ re: new RegExp(`\\b${MONTH_RE}\\b${Y}`, "i"), read: (m) => [{ m: monthIndex(m[1]), y: year(m[2]) }] },
];

function year(s: string | undefined): number | undefined {
	if (!s) return undefined;
	const n = +s;
	return n < 100 ? 2000 + n : n;
}

/** Build range matchers from the single-date patterns, plus "15–20 Feb" style. */
function rangeMatchers(): Matcher[] {
	const src = single.map((s) => s.re.source.replace(/^\\b/, ""));
	const list: Matcher[] = [
		{
			re: new RegExp(`\\b${D}${SEP_RE}${D}\\s+${MONTH_RE}\\b${Y}`, "i"),
			read: (m) => {
				const mo = monthIndex(m[3]);
				const y = year(m[4]);
				return [{ d: +m[1], m: mo, y }, { d: +m[2], m: mo, y }];
			},
		},
	];
	for (let i = 0; i < single.length; i++) {
		for (let j = 0; j < single.length; j++) {
			const re = new RegExp(`(?:\\bfrom\\s+)?\\b(?:${src[i]})${SEP_RE}(?:${src[j]})`, "i");
			const gi = groupCount(single[i].re);
			list.push({
				re,
				read: (m) => {
					const a = single[i].read(pick(m, 1, gi));
					const b = single[j].read(pick(m, 1 + gi, groupCount(single[j].re)));
					return a && b ? [a[0], b[0]] : null;
				},
			});
		}
	}
	return list;
}

function groupCount(re: RegExp): number {
	return new RegExp(re.source + "|").exec("")!.length - 1;
}

function pick(m: RegExpExecArray, from: number, count: number): RegExpExecArray {
	const arr = [m[0], ...m.slice(from, from + count)] as unknown as RegExpExecArray;
	return arr;
}

const RANGE = rangeMatchers();
const RELATIVE: { re: RegExp; offset: number }[] = [
	{ re: /\btoday\b/i, offset: 0 },
	{ re: /\btomorrow\b/i, offset: 1 },
];
const DURATION_RE = /\bfor\s+(\d+(?:\.\d+)?)\s*(d|days?|w|wks?|weeks?|m|mos?|months?)\b/i;
const PROGRESS_RE = /(?:^|\s)(\d{1,3})\s?%(?=\s|$)/;
const TAG_RE = /(?:^|\s)#([^\s#]+)/g;

/** Pick the year for a month/day so it lands inside the project, or the nearest year after its start. */
function inferYear(p: Partial, project: Project, notBefore?: number): number {
	const ps = toDay(project.start);
	const pe = toDay(project.end);
	const startYear = +project.start.slice(0, 4);
	for (const y of [startYear, startYear + 1, startYear + 2, startYear - 1]) {
		const day = dayFromYmd(y, p.m, p.d ?? 1);
		if (notBefore !== undefined && day < notBefore) continue;
		if (day >= ps && day <= pe) return y;
	}
	if (notBefore !== undefined) {
		for (let y = startYear - 1; y < startYear + 5; y++) if (dayFromYmd(y, p.m, p.d ?? 1) >= notBefore) return y;
	}
	return dayFromYmd(startYear, p.m, p.d ?? 1) >= ps ? startYear : startYear + 1;
}

function resolve(p: Partial, project: Project, edge: "start" | "end", notBefore?: number): number {
	const y = p.y ?? inferYear(p, project, notBefore);
	if (p.d !== undefined) return dayFromYmd(y, p.m, Math.min(p.d, daysInMonth(y, p.m)));
	return edge === "start" ? dayFromYmd(y, p.m, 1) : dayFromYmd(y, p.m, daysInMonth(y, p.m));
}

const KEYWORD_TYPES: [RegExp, ItemType][] = [
	[/\b(deadline|due)\b/i, "deadline"],
	[/\bmilestone\b/i, "milestone"],
	[/\b(meeting|conference|seminar|workshop|presentation|viva|defen[cs]e|review panel|symposium)\b/i, "event"],
];

export function parseQuickAdd(input: string, ctx: ParseContext): ParseResult | null {
	let text = ` ${input.trim()} `;
	if (!input.trim()) return null;

	// Type prefix
	let type: ItemType = ctx.defaultType;
	let explicitType = false;
	let buffer = false;
	const prefix = text.trim()[0];
	if (prefix === "~") {
		type = "task";
		buffer = true;
		explicitType = true;
		text = " " + text.trim().slice(1) + " ";
	}
	const prefixes: Record<string, ItemType> = { "!": "deadline", "*": "milestone", "◆": "milestone", "+": "event", "@": "location" };
	if (prefixes[prefix]) {
		type = prefixes[prefix];
		explicitType = true;
		text = " " + text.trim().slice(1) + " ";
	}

	// Phase tags
	let phase: string | undefined;
	let newPhase: string | undefined;
	text = text.replace(TAG_RE, (_m, tag: string) => {
		if (phase || newPhase) return " ";
		const norm = slugify(tag);
		const hit =
			ctx.project.phases.find((p) => p.id === norm || slugify(p.name) === norm) ??
			ctx.project.phases.find((p) => slugify(p.name).startsWith(norm) || p.id.startsWith(norm)) ??
			ctx.project.phases.find((p) => slugify(p.name).split("-").some((w) => w.startsWith(norm)));
		if (hit) phase = hit.id;
		else {
			const name = tag.replace(/[-_]/g, " ");
			newPhase = name[0].toUpperCase() + name.slice(1);
		}
		return " ";
	});

	// Progress
	let progress: number | undefined;
	text = text.replace(PROGRESS_RE, (_m, n: string) => {
		progress = Math.min(100, +n);
		return " ";
	});

	// Duration
	let durationDays: number | undefined;
	text = text.replace(DURATION_RE, (_m, n: string, unit: string) => {
		const u = unit[0].toLowerCase();
		const v = +n;
		durationDays = u === "d" ? Math.round(v) : u === "w" ? Math.round(v * 7) : -Math.round(v); // negative = months
		return " ";
	});

	// Dates: ranges first, then singles, then relative words
	let startDay: number | undefined;
	let endDay: number | undefined;
	let monthOnly = false;
	let matched = false;
	for (const m of RANGE) {
		const r = m.re.exec(text);
		if (!r) continue;
		const parts = m.read(r);
		if (!parts) continue;
		const [a, b] = parts;
		if (a.y === undefined && b.y !== undefined) {
			// "Nov – Feb 2027": the shared year belongs to the end; step the start back if needed.
			a.y = b.y;
			if (a.m > b.m || (a.m === b.m && (a.d ?? 1) > (b.d ?? 31))) a.y = b.y - 1;
		}
		startDay = resolve(a, ctx.project, "start");
		endDay = resolve(b, ctx.project, "end", startDay);
		monthOnly = a.d === undefined && b.d === undefined;
		text = text.replace(r[0], " ");
		matched = true;
		break;
	}
	if (!matched) {
		for (const m of single) {
			const r = m.re.exec(text);
			if (!r) continue;
			const parts = m.read(r);
			if (!parts) continue;
			const p = parts[0];
			startDay = resolve(p, ctx.project, "start");
			if (p.d === undefined) {
				monthOnly = true;
				endDay = resolve(p, ctx.project, "end", startDay);
			}
			text = text.replace(r[0], " ");
			matched = true;
			break;
		}
	}
	if (!matched) {
		for (const rel of RELATIVE) {
			if (rel.re.test(text)) {
				startDay = toDay(ctx.today) + rel.offset;
				text = text.replace(rel.re, " ");
				matched = true;
				break;
			}
		}
	}

	// Keyword-based type, only for single specific days and only without an explicit prefix.
	if (!explicitType && ctx.defaultType === "task" && matched && endDay === undefined && durationDays === undefined) {
		for (const [re, t] of KEYWORD_TYPES) {
			if (re.test(text)) {
				type = t;
				break;
			}
		}
	}

	let title = text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^(from|on|by|in|at|until|between|due)\s+/i, "")
		.replace(/\s+(from|on|by|in|at|until|between|due|for|starting)$/i, "")
		.replace(/^[,;:·\-–—\s]+|[,;:·\-–—\s]+$/g, "");

	const dateGuessed = !matched;
	if (startDay === undefined) {
		const ps = toDay(ctx.project.start);
		const pe = toDay(ctx.project.end);
		startDay = Math.min(Math.max(toDay(ctx.today), ps), pe);
	}

	if (isRangeType(type)) {
		if (durationDays !== undefined) {
			endDay = durationDays >= 0 ? startDay + Math.max(1, durationDays) - 1 : addMonths(startDay, -durationDays) - 1;
		} else if (endDay === undefined) {
			endDay = monthOnly ? endDay : startDay + (dateGuessed ? 13 : 0);
		}
	} else {
		endDay = undefined;
	}

	const result: ParseResult = {
		type,
		title,
		start: fromDay(startDay),
		dateGuessed,
	};
	if (endDay !== undefined) result.end = fromDay(Math.max(startDay, endDay));
	if (phase) result.phase = phase;
	if (newPhase) result.newPhase = newPhase;
	if (progress !== undefined && type === "task") result.progress = progress;
	if (buffer) {
		result.buffer = true;
		if (!result.title) result.title = "Buffer";
	}
	return result;
}
