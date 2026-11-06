/**
 * How a timeline prints. Saved per timeline (in its note, as `print:` with only the changed values), so the
 * same plan always prints the same way.
 */
export interface PrintSettings {
	paper: "a4" | "a3" | "letter";
	orientation: "landscape" | "portrait";
	/** Room between the rows: more makes arrows and steps easier to follow. */
	spacing: "tight" | "normal" | "roomy";
	textSize: "small" | "normal" | "large";
	/** How lengths and countdowns are counted: all in weeks, all in days, or weeks then months. */
	timeUnit: "weeks" | "days" | "auto";
	/** Where buffer, vacation and Plan B names go: above the bar, under it, or above unless crowded (auto). */
	captionPlace: "auto" | "above" | "below";
	/** A table of the milestones under the chart, earliest first. */
	milestoneTable: boolean;
	/** Put the deadlines in that table too. */
	tableDeadlines: boolean;
	/** A task's dates after its name. */
	taskDates: boolean;
	/** The line marking the day it's printed. */
	today: boolean;
	/** Arrows between linked steps. */
	arrows: boolean;
	/** Also the long arrows that run down through other phases, as on the board. */
	longArrows: boolean;
	/** Names of buffers and Plan Bs above their task. */
	captions: boolean;
	/** When each vacation and buffer runs, after its name. */
	captionDates: boolean;
	/** A table of the vacations and buffers under the chart, with their dates and patterns. */
	bufferTable: boolean;
	/** The row of week dates in the header. */
	weeks: boolean;
	/** Subtitle and author under the title. */
	subtitle: boolean;
	/** "Dissertation submission in 22 weeks" by the title. */
	countdown: boolean;
}

export const DEFAULT_PRINT: PrintSettings = {
	paper: "a4",
	orientation: "landscape",
	spacing: "normal",
	textSize: "normal",
	captionPlace: "auto",
	timeUnit: "weeks",
	milestoneTable: true,
	tableDeadlines: false,
	taskDates: true,
	today: true,
	arrows: true,
	longArrows: true,
	captions: true,
	captionDates: true,
	bufferTable: true,
	weeks: true,
	subtitle: true,
	countdown: true,
};

const CHOICES: { [K in keyof PrintSettings]?: readonly string[] } = {
	paper: ["a4", "a3", "letter"],
	orientation: ["landscape", "portrait"],
	spacing: ["tight", "normal", "roomy"],
	textSize: ["small", "normal", "large"],
	captionPlace: ["auto", "above", "below"],
	timeUnit: ["weeks", "days", "auto"],
};

/** Read print settings from a note, keeping only valid values. */
export function readPrintSettings(raw: unknown): Partial<PrintSettings> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(DEFAULT_PRINT) as (keyof PrintSettings)[]) {
		const v = r[key];
		const choices = CHOICES[key];
		if (choices ? typeof v === "string" && choices.includes(v) : typeof v === "boolean") out[key] = v;
	}
	return Object.keys(out).length ? out : undefined;
}

/** Only what differs from the defaults, for saving in the note. */
export function changedPrintSettings(s: Partial<PrintSettings> | undefined): Partial<PrintSettings> | undefined {
	if (!s) return undefined;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(DEFAULT_PRINT) as (keyof PrintSettings)[])
		if (s[key] !== undefined && s[key] !== DEFAULT_PRINT[key]) out[key] = s[key];
	return Object.keys(out).length ? out : undefined;
}

export function printSettingsOf(saved: Partial<PrintSettings> | undefined): PrintSettings {
	return { ...DEFAULT_PRINT, ...(saved ?? {}) };
}

/** Paper sizes: CSS pixels at 96 dpi (so text prints at its real size) and PDF points. */
export const PAPER: Record<PrintSettings["paper"], { w: number; h: number; wPt: number; hPt: number; label: string }> = {
	a4: { w: 1123, h: 794, wPt: 841.89, hPt: 595.28, label: "A4" },
	a3: { w: 1587, h: 1123, wPt: 1190.55, hPt: 841.89, label: "A3" },
	letter: { w: 1056, h: 816, wPt: 792, hPt: 612, label: "Letter" },
};

/** The page size in pixels and points for the chosen paper and orientation. */
export function pageSize(s: PrintSettings): { w: number; h: number; wPt: number; hPt: number } {
	const p = PAPER[s.paper];
	return s.orientation === "landscape" ? p : { w: p.h, h: p.w, wPt: p.hPt, hPt: p.wPt };
}
