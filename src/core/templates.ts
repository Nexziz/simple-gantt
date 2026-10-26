import { addMonths, fromDay, monthStart, toDay } from "./dates";
import { COLOR_ORDER, Project } from "./types";

export type TemplateId = "dissertation" | "blank";

export const TEMPLATES: { id: TemplateId; name: string; description: string }[] = [
	{ id: "dissertation", name: "Dissertation", description: "12 months with research phases ready to fill in" },
	{ id: "blank", name: "Blank project", description: "An empty timeline with a single phase" },
];

/** A new project starting at the beginning of the month of `today`. */
export function createFromTemplate(id: TemplateId, title: string, today: string): Project {
	const start = monthStart(toDay(today));
	const end = addMonths(start, 12) - 1;
	const base: Project = { title, start: fromDay(start), end: fromDay(end), phases: [], items: [] };
	const names =
		id === "dissertation"
			? ["Literature review", "Methodology & ethics", "Data collection", "Analysis", "Writing", "Submission"]
			: ["Work"];
	names.forEach((name, i) => base.phases.push({ id: name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, ""), name, color: COLOR_ORDER[i] }));
	if (id === "dissertation") {
		base.subtitle = "Dissertation plan";
		base.items.push({ id: "submit", type: "deadline", title: "Final submission", start: fromDay(end - 3) });
	}
	return base;
}
