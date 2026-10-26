import { addMonths, toDay } from "./dates";
import type { CheckIn, JournalEntry, Project } from "./types";

/** Writing prompts for the journal box, rotated so it never feels like a form. */
export const PROMPTS = [
	"What moved forward since last time?",
	"What's blocking you right now?",
	"What are you proud of this week?",
	"What will you focus on next?",
	"What surprised you?",
	"What would you tell your supervisor today?",
	"What did you learn that changes the plan?",
	"Where did your energy go?",
];

export const REVIEW_PROMPTS = [
	"What went well?",
	"What would you do differently next time?",
	"Did it take longer than planned? Why?",
	"What did this unlock for the next step?",
];

export function prompt(seed: number, list = PROMPTS): string {
	return list[((seed % list.length) + list.length) % list.length];
}

/** All check-in dates (day numbers) from the project start up to its end. */
export function checkInSlots(project: Project): number[] {
	const freq = project.checkin;
	if (!freq) return [];
	const start = toDay(project.start);
	const end = toDay(project.end);
	const slots: number[] = [];
	for (let i = 0; i < 400; i++) {
		const d = step(start, freq, i);
		if (d > end) break;
		slots.push(d);
	}
	return slots;
}

function step(start: number, freq: CheckIn, i: number): number {
	if (freq === "weekly") return start + 7 * i;
	if (freq === "fortnightly") return start + 14 * i;
	return addMonths(start, i);
}

export function entriesBetween(project: Project, from: number, to: number): JournalEntry[] {
	return (project.journal ?? []).filter((e) => {
		const d = toDay(e.date);
		return d >= from && d < to;
	});
}

export type SlotState = "done" | "due" | "missed" | "future";

export interface Slot {
	day: number;
	next: number;
	state: SlotState;
}

/** Check-in slots with their state relative to today. */
export function slotStates(project: Project, today: number): Slot[] {
	const slots = checkInSlots(project);
	return slots.map((day, i) => {
		const next = slots[i + 1] ?? toDay(project.end) + 1;
		const has = entriesBetween(project, day, next).length > 0;
		const state: SlotState = has ? "done" : day > today ? "future" : today < next ? "due" : "missed";
		return { day, next, state };
	});
}

/** The current check-in if it hasn't been written yet. */
export function dueCheckIn(project: Project, today: number): Slot | null {
	return slotStates(project, today).find((s) => s.state === "due") ?? null;
}
