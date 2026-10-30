import { ItemView, TFile, WorkspaceLeaf, debounce } from "obsidian";
import { agenda } from "./core/agenda";
import { formatDay, formatDuration, toDay, todayIso } from "./core/dates";
import { nextDeadline, overallProgress } from "./core/nudges";
import { themeFromCss } from "./core/theme";
import { GanttItem, ITEM_TYPE_LABELS, Project } from "./core/types";
import { icon } from "./ui/icons";
import type SimpleGanttPlugin from "./main";
import { ICON_ID } from "./view";

export const OVERVIEW_VIEW_TYPE = "simple-gantt-overview";

/**
 * A small sidebar panel: the next deadline, what's on now and what's coming up, with a button to the full
 * timeline. It lives in a sidebar tab, so its icon can be dragged to any tab group (top, bottom, left, right).
 */
export class OverviewView extends ItemView {
	/** The timeline shown; follows the one last opened unless picked here. */
	private path: string | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: SimpleGanttPlugin) {
		super(leaf);
	}

	getViewType() {
		return OVERVIEW_VIEW_TYPE;
	}

	getDisplayText() {
		return "Timeline overview";
	}

	getIcon() {
		return ICON_ID;
	}

	async onOpen() {
		this.contentEl.addClass("sg-overview");
		const later = debounce(() => void this.refresh(), 300, true);
		this.registerEvent(this.app.vault.on("modify", (f) => f instanceof TFile && this.plugin.isProject(f) && later()));
		this.registerEvent(this.app.workspace.on("file-open", () => later()));
		this.registerEvent(this.app.workspace.on("css-change", () => later()));
		// Days roll over while Obsidian stays open.
		this.registerInterval(window.setInterval(later, 30 * 60 * 1000));
		await this.refresh();
	}

	async refresh() {
		const files = this.plugin.listProjects();
		const wanted = this.path ?? this.plugin.settings.lastProject;
		const file = files.find((f) => f.path === wanted) ?? files[0] ?? null;
		const project = file ? await this.plugin.readProject(file) : null;
		this.draw(files, file, project);
	}

	private draw(files: TFile[], file: TFile | null, project: Project | null) {
		const el = this.contentEl;
		el.empty();
		if (!file || !project) {
			const empty = el.createDiv({ cls: "sg-ov-empty" });
			empty.append(icon("gantt", 26));
			empty.createEl("p", { text: "Plan your project on a timeline." });
			const add = (label: string, template: "dissertation" | "blank", cta = false) => {
				const b = empty.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
				b.addEventListener("click", () => void this.plugin.newProject(template));
			};
			add("New dissertation timeline", "dissertation", true);
			add("New blank timeline", "blank");
			return;
		}
		const today = toDay(todayIso());
		const palette = themeFromCss(el).palette;
		const colorOf = (it: GanttItem) => {
			const ph = project.phases.find((p) => p.id === it.phase);
			return ph ? palette[ph.color] : "var(--text-faint)";
		};

		// Which timeline
		const head = el.createDiv({ cls: "sg-ov-head" });
		if (files.length > 1) {
			const sel = head.createEl("select", { cls: "dropdown sg-ov-pick", attr: { "aria-label": "Timeline" } });
			for (const f of files) {
				const o = sel.createEl("option", { text: f.basename, attr: { value: f.path } });
				if (f === file) o.selected = true;
			}
			sel.addEventListener("change", () => {
				this.path = sel.value;
				void this.refresh();
			});
		} else head.createDiv({ cls: "sg-ov-title", text: project.title });

		// Progress and the next deadline
		const glance = el.createDiv({ cls: "sg-ov-glance" });
		const pct = overallProgress(project);
		glance.append(ring(pct));
		const facts = glance.createDiv({ cls: "sg-ov-facts" });
		facts.createDiv({ cls: "sg-ov-pct", text: `${pct}% done` });
		const next = nextDeadline(project, today);
		if (next) {
			const d = facts.createDiv({ cls: "sg-ov-next" });
			d.append(icon("deadline", 12));
			d.createSpan({ text: `${next.item.title} · ${next.days === 0 ? "today" : `in ${formatDuration(next.days)}`}` });
		}

		const open = el.createEl("button", { cls: "mod-cta sg-ov-open" });
		open.append(icon("external", 14), createSpan({ text: "Open timeline" }));
		open.addEventListener("click", () => void this.plugin.activateView(file.path));

		// Now, coming up, overdue
		const list = (title: string, rows: { item: GanttItem; when: string; cls?: string }[], emptyText?: string) => {
			if (!rows.length && !emptyText) return;
			const sec = el.createDiv({ cls: "sg-ov-sec" });
			sec.createDiv({ cls: "sg-ov-label", text: title });
			if (!rows.length) sec.createDiv({ cls: "sg-ov-none", text: emptyText });
			for (const r of rows) {
				const row = sec.createEl("button", { cls: `sg-ov-row ${r.cls ?? ""}`, attr: { "aria-label": `${ITEM_TYPE_LABELS[r.item.type]}: ${r.item.title}` } });
				const mark = row.createSpan({ cls: "sg-ov-mark" });
				mark.append(icon(r.item.type, 13));
				mark.setCssProps({ "--sg-ov-color": colorOf(r.item) });
				const text = row.createSpan({ cls: "sg-ov-text" });
				text.createSpan({ cls: "sg-ov-name", text: r.item.title });
				text.createSpan({ cls: "sg-ov-when", text: r.when });
				if (r.item.type === "task" && r.item.progress) {
					const bar = text.createSpan({ cls: "sg-ov-bar" });
					bar.setCssProps({ "--sg-ov-progress": `${r.item.progress}%`, "--sg-ov-color": colorOf(r.item) });
				}
				row.addEventListener("click", () => void this.plugin.activateView(file.path, r.item.id));
			}
		};
		const a = agenda(project, today);
		const ago = (day: number) => (today - day === 1 ? "yesterday" : `${formatDuration(today - day)} ago`);
		const until = (day: number) => (day - today === 1 ? "tomorrow" : `in ${formatDuration(day - today)}`);
		list("Did you reach…?", a.late.map(({ item, day }) => ({ item, when: `${formatDay(day, false)} · ${ago(day)}`, cls: "is-late" })));
		list("Now", a.now.map((item) => {
			const end = toDay(item.end ?? item.start);
			return { item, when: end === today ? "ends today" : `until ${formatDay(end, false)} · ${formatDuration(end - today + 1)} left` };
		}), "Nothing scheduled right now.");
		list("Next 4 weeks", a.soon.map(({ item, day }) => ({ item, when: `${formatDay(day, false)} · ${until(day)}` })), "Nothing coming up.");

		el.createDiv({ cls: "sg-ov-tip", text: "Tip: drag this panel's icon onto any tab group in the sidebars to move it." });
	}
}

/** A small progress ring. */
function ring(pct: number): SVGSVGElement {
	const NS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 36 36");
	svg.setAttribute("class", "sg-ov-ring");
	const r = 15;
	const c = 2 * Math.PI * r;
	for (const [cls, dash] of [["sg-ov-ring-bg", `${c}`], ["sg-ov-ring-fg", `${(c * pct) / 100} ${c}`]] as const) {
		const circle = document.createElementNS(NS, "circle");
		circle.setAttribute("cx", "18");
		circle.setAttribute("cy", "18");
		circle.setAttribute("r", String(r));
		circle.setAttribute("class", cls);
		circle.setAttribute("stroke-dasharray", dash);
		svg.appendChild(circle);
	}
	return svg;
}
