/**
 * Hours worked, from Pocket Watch: when a Pocket Watch project follows a timeline, your time on it is shared
 * out among the timeline's phases and tasks there, and shown here after each task's name, under each phase,
 * in the overview panel and on paper. Simple Gantt only shows them; Pocket Watch keeps the time.
 */

/** A task's or phase's time: how long, on how many days, and the first and last of them (ISO). */
export interface HoursStat {
	ms: number;
	days: number;
	first: string | null;
	last: string | null;
	/** Phases: the time on the phase itself, not on one of its tasks. */
	own?: number;
}

/** What Pocket Watch's `timelineHours` gives: the total, what isn't sorted yet, and each task's and phase's time. */
export interface Hours {
	total: number;
	unsorted: number;
	projects?: { id: string; name: string; color?: number }[];
	/** By item id. */
	items: Record<string, HoursStat>;
	/** By phase id, with its tasks' time. */
	phases: Record<string, HoursStat>;
}

const MINUTE = 60 * 1000;

/** "45m", "3h", "12h 30m"; empty under a minute, so an item with no time shows nothing. */
export function formatHours(ms: number | null | undefined): string {
	const min = Math.floor((ms ?? 0) / MINUTE);
	if (min < 1) return "";
	const h = Math.floor(min / 60);
	const m = min % 60;
	if (!h) return `${m}m`;
	return m ? `${h}h ${m}m` : `${h}h`;
}

/** A task's time, written out, or "" when it has none. */
export function itemHours(hours: Hours | null | undefined, id: string): string {
	return hours ? formatHours(hours.items[id]?.ms) : "";
}

/** A phase's time (with its tasks'), written out, or "" when it has none. */
export function phaseHours(hours: Hours | null | undefined, id: string): string {
	return hours ? formatHours(hours.phases[id]?.ms) : "";
}

/** Keep only a well-formed answer from Pocket Watch (it's another plugin, so don't trust its shape). */
export function readHours(raw: unknown): Hours | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const stats = (v: unknown): Record<string, HoursStat> => {
		const out: Record<string, HoursStat> = {};
		if (!v || typeof v !== "object") return out;
		for (const [id, s] of Object.entries(v as Record<string, unknown>)) {
			const o = s as Record<string, unknown> | null;
			const ms = Number(o?.ms);
			if (!o || !Number.isFinite(ms) || ms < 0) continue;
			out[id] = {
				ms, days: Number(o.days) || 0,
				first: typeof o.first === "string" ? o.first : null, last: typeof o.last === "string" ? o.last : null,
				...(Number.isFinite(Number(o.own)) ? { own: Number(o.own) } : {}),
			};
		}
		return out;
	};
	const total = Number(r.total);
	if (!Number.isFinite(total)) return null;
	const unsorted = Number(r.unsorted);
	return {
		total, unsorted: Number.isFinite(unsorted) ? unsorted : 0,
		projects: Array.isArray(r.projects) ? (r.projects as Hours["projects"]) : [],
		items: stats(r.items), phases: stats(r.phases),
	};
}
