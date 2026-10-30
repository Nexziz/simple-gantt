import { formatDuration, toDay } from "./dates";
import { GanttItem, ITEM_TYPE_LABELS, Project, isDone, isRangeType } from "./types";

/** The plan as plain rows, for a Markdown table in the dissertation or a spreadsheet. */
export interface Row {
	phase: string;
	title: string;
	type: string;
	start: string;
	end: string;
	duration: string;
	status: string;
	after: string;
}

const HEAD: Row = { phase: "Phase", title: "Item", type: "Type", start: "Start", end: "End", duration: "Duration", status: "Status", after: "Starts after" };

export function tableRows(project: Project): Row[] {
	const phaseOrder = new Map(project.phases.map((p, i) => [p.id, i]));
	const byId = new Map(project.items.map((i) => [i.id, i]));
	const rank = (it: GanttItem) => (it.phase !== undefined && phaseOrder.has(it.phase) ? phaseOrder.get(it.phase)! : project.phases.length);
	return [...project.items]
		.sort((a, b) => rank(a) - rank(b) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title))
		.map((it) => {
			const range = isRangeType(it.type);
			const end = it.end ?? it.start;
			const status = it.dropped ? "Replaced by Plan B"
				: isDone(it) ? `Done${it.doneOn ? ` ${it.doneOn}` : ""}`
					: it.type === "task" && it.progress ? `${it.progress}%` : "";
			return {
				phase: project.phases.find((p) => p.id === it.phase)?.name ?? "",
				title: it.title,
				type: it.buffer ? "Buffer" : ITEM_TYPE_LABELS[it.type],
				start: it.start,
				end: range ? end : "",
				duration: range ? formatDuration(toDay(end) - toDay(it.start) + 1) : "",
				status,
				after: (it.after ?? []).map((id) => byId.get(id)?.title).filter(Boolean).join("; "),
			};
		});
}

const COLS: (keyof Row)[] = ["phase", "title", "type", "start", "end", "duration", "status", "after"];

export function toMarkdownTable(project: Project): string {
	const rows = tableRows(project);
	// Leave out columns that are empty for every row.
	const cols = COLS.filter((c) => rows.some((r) => r[c]));
	const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
	const line = (r: Row) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`;
	return [line(HEAD), `|${cols.map(() => " --- ").join("|")}|`, ...rows.map(line)].join("\n") + "\n";
}

export function toCsv(project: Project): string {
	const cell = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
	return [HEAD, ...tableRows(project)].map((r) => COLS.map((c) => cell(r[c])).join(",")).join("\r\n") + "\r\n";
}
