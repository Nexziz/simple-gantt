/**
 * Dates are stored as ISO strings (YYYY-MM-DD) and handled internally as whole
 * "day numbers" (days since 1970-01-01, UTC) so arithmetic never trips over DST.
 */

const MS_PER_DAY = 86400000;

export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];

export function isIsoDate(s: unknown): s is string {
	return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(toDay(s));
}

export function toDay(iso: string): number {
	const [y, m, d] = iso.split("-").map(Number);
	return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

export function dayFromYmd(y: number, m: number, d: number): number {
	return Math.round(Date.UTC(y, m, d) / MS_PER_DAY);
}

export function fromDay(day: number): string {
	return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** [year, monthIndex, dayOfMonth] for a day number. */
export function ymd(day: number): [number, number, number] {
	const d = new Date(day * MS_PER_DAY);
	return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

/** 0 = Monday … 6 = Sunday. */
export function weekday(day: number): number {
	return (new Date(day * MS_PER_DAY).getUTCDay() + 6) % 7;
}

export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function monthStart(day: number): number {
	const [y, m] = ymd(day);
	return dayFromYmd(y, m, 1);
}

export function monthEnd(day: number): number {
	const [y, m] = ymd(day);
	return dayFromYmd(y, m + 1, 0);
}

export function addMonths(day: number, n: number): number {
	const [y, m, d] = ymd(day);
	const target = dayFromYmd(y, m + n, 1);
	const [ty, tm] = ymd(target);
	return dayFromYmd(ty, tm, Math.min(d, daysInMonth(ty, tm)));
}

/** Local "today" as an ISO date. */
export function todayIso(): string {
	const now = new Date();
	return fromDay(dayFromYmd(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function formatDay(day: number, withYear = true): string {
	const [y, m, d] = ymd(day);
	return withYear ? `${d} ${MONTHS_SHORT[m]} ${y}` : `${d} ${MONTHS_SHORT[m]}`;
}

/** "3 Feb – 14 Mar 2027", collapsing the shared year/month where possible. */
export function formatRange(startDay: number, endDay: number): string {
	if (startDay === endDay) return formatDay(startDay);
	const [sy, sm] = ymd(startDay);
	const [ey, em, ed] = ymd(endDay);
	if (sy === ey && sm === em) return `${ymd(startDay)[2]}–${ed} ${MONTHS_SHORT[em]} ${ey}`;
	if (sy === ey) return `${formatDay(startDay, false)} – ${formatDay(endDay)}`;
	return `${formatDay(startDay)} – ${formatDay(endDay)}`;
}

/** Human duration, e.g. "3 weeks", "2.5 months", "1 day". */
export function formatDuration(days: number): string {
	if (days === 1) return "1 day";
	if (days < 14) return `${days} days`;
	if (days < 60) {
		const w = Math.round(days / 7);
		return `${w} weeks`;
	}
	const m = Math.round((days / 30.44) * 2) / 2;
	return `${m} months`;
}

/** Short month span label, e.g. "Sep – Feb". */
export function formatMonthSpan(startDay: number, endDay: number): string {
	const [sy, sm] = ymd(startDay);
	const [ey, em] = ymd(endDay);
	if (sy === ey && sm === em) return MONTHS_SHORT[sm];
	return `${MONTHS_SHORT[sm]} – ${MONTHS_SHORT[em]}`;
}
