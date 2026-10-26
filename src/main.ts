import { Notice, Plugin, TFile, addIcon, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import { todayIso, toDay } from "./core/dates";
import { renderExportSvg } from "./core/render";
import { BLOCK_LANG, FRONTMATTER_KEY, noteTemplate, normalizeProject, toPlain } from "./core/serialize";
import { createFromTemplate } from "./core/templates";
import type { Project } from "./core/types";
import { DEFAULT_SETTINGS, SimpleGanttSettingTab, SimpleGanttSettings } from "./settings";
import { RIBBON_ICON_SVG, icon } from "./ui/icons";
import { GanttView, ICON_ID, VIEW_TYPE } from "./view";

export default class SimpleGanttPlugin extends Plugin {
	settings!: SimpleGanttSettings;

	async onload() {
		await this.loadSettings();
		addIcon(ICON_ID, RIBBON_ICON_SVG);
		this.registerView(VIEW_TYPE, (leaf) => new GanttView(leaf, this));

		this.addRibbonIcon(ICON_ID, "Open Simple Gantt", () => this.activateView());

		this.addCommand({ id: "open", name: "Open timeline", callback: () => this.activateView() });
		this.addCommand({
			id: "new-dissertation",
			name: "New dissertation timeline",
			callback: () => this.newProject("dissertation"),
		});
		this.addCommand({ id: "new-blank", name: "New blank timeline", callback: () => this.newProject("blank") });
		this.addCommand({
			id: "open-current-note",
			name: "Open this note as a timeline",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const ok = !!file && this.isProject(file);
				if (ok && !checking) this.activateView(file!.path);
				return ok;
			},
		});

		// Reading-view preview of any ```simple-gantt block, e.g. inside the project note or embedded elsewhere.
		this.registerMarkdownCodeBlockProcessor(BLOCK_LANG, (source, el, ctx) => {
			const wrap = el.createDiv({ cls: "sg-inline" });
			let project: Project;
			try {
				project = normalizeProject(parseYaml(source), "Timeline");
			} catch (e) {
				wrap.createDiv({ cls: "sg-inline-error", text: `Simple Gantt: the data block could not be read (${(e as Error).message}).` });
				return;
			}
			wrap.appendChild(renderExportSvg(project, { width: 1600, today: toDay(todayIso()) }));
			const btn = wrap.createEl("button", { cls: "sg-btn sg-inline-open" });
			btn.innerHTML = `${icon("external", 14)}<span>Open in Simple Gantt</span>`;
			btn.addEventListener("click", () => this.activateView(ctx.sourcePath));
		});

		this.addSettingTab(new SimpleGanttSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	rememberProject(path: string) {
		if (this.settings.lastProject === path) return;
		this.settings.lastProject = path;
		void this.saveSettings();
	}

	isProject(file: TFile): boolean {
		return file.extension === "md" && !!this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_KEY];
	}

	listProjects(): TFile[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => this.isProject(f))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	/** Open the Gantt tab (re-using an existing one), optionally on a specific project note. */
	async activateView(path?: string) {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE, active: true, state: path ? { file: path } : {} });
		} else if (path) {
			await (leaf.view as GanttView).openPath(path);
		}
		await workspace.revealLeaf(leaf);
	}

	async newProject(template: "dissertation" | "blank") {
		const title = template === "dissertation" ? "Dissertation timeline" : "New timeline";
		const file = await this.createProjectFile(createFromTemplate(template, title, todayIso()));
		if (file) await this.activateView(file.path);
	}

	async createProjectFile(project: Project): Promise<TFile | null> {
		const folder = this.settings.folder;
		try {
			if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
			let path = normalizePath(`${folder ? folder + "/" : ""}${project.title}.md`);
			for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++)
				path = normalizePath(`${folder ? folder + "/" : ""}${project.title} ${n}.md`);
			return await this.app.vault.create(path, noteTemplate(stringifyYaml(toPlain(project))));
		} catch (e) {
			new Notice(`Simple Gantt: could not create the project (${(e as Error).message})`);
			return null;
		}
	}
}
