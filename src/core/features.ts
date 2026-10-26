import type { Project } from "./types";

/**
 * Optional parts of the board. Each project can switch them off (stored as `off: [...]` in the note).
 * Switching off only hides things; the data stays in the note and returns when switched back on.
 */
export type Feature = "locations" | "events" | "journal" | "planb" | "links" | "buffers" | "progress" | "nudges" | "celebrate";

export const FEATURES: { key: Feature; label: string; desc: string; icon: string }[] = [
	{ key: "links", label: "Links", desc: "Arrows between items; moving one pushes what comes after", icon: "branch" },
	{ key: "progress", label: "Progress", desc: "Progress bars, the % slider and the progress ring", icon: "task" },
	{ key: "nudges", label: "Reminders", desc: "“Did you reach…?”, upcoming deadlines and other nudges", icon: "bell" },
	{ key: "events", label: "Key dates", desc: "Meetings, reviews and conferences (deadlines always stay)", icon: "event" },
	{ key: "locations", label: "Locations", desc: "A “Where” row for fieldwork, trips and travel", icon: "location" },
	{ key: "buffers", label: "Buffer time", desc: "Hatched slack to absorb delays", icon: "buffer" },
	{ key: "planb", label: "Plan B", desc: "Backup plans with a decision date", icon: "branch" },
	{ key: "journal", label: "Journal", desc: "Notes, moods and check-in reminders", icon: "book" },
	{ key: "celebrate", label: "Celebrations", desc: "Confetti when you tick something off", icon: "party" },
];

export const ALL_FEATURES: Feature[] = FEATURES.map((f) => f.key);

/** Presets: which features are switched off. */
export const PRESETS: { id: "essentials" | "everything"; label: string; desc: string; off: Feature[] }[] = [
	{ id: "essentials", label: "Essentials", desc: "Tasks, milestones, deadlines, links and progress", off: ["locations", "events", "journal", "planb", "buffers"] },
	{ id: "everything", label: "Everything", desc: "Every tool switched on", off: [] },
];

export function isOn(project: Project | null | undefined, feature: Feature): boolean {
	return !project?.off?.includes(feature);
}

export function setFeature(project: Project, feature: Feature, on: boolean) {
	const off = new Set(project.off ?? []);
	if (on) off.delete(feature);
	else off.add(feature);
	if (off.size) project.off = ALL_FEATURES.filter((f) => off.has(f));
	else delete project.off;
}
