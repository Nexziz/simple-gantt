import { ItemView, Notice, TFile, WorkspaceLeaf, debounce, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import { createFromTemplate, TemplateId } from "./core/templates";
import { FRONTMATTER_KEY, extractBlock, normalizeProject, replaceBlock, toPlain } from "./core/serialize";
import { todayIso } from "./core/dates";
import type { Project } from "./core/types";
import { GanttBoard } from "./ui/board";
import type SimpleGanttPlugin from "./main";

export const VIEW_TYPE = "simple-gantt-view";
export const ICON_ID = "simple-gantt";

export class GanttView extends ItemView {
	private board: GanttBoard | null = null;
	private file: TFile | null = null;
	/** The YAML we last wrote, so our own saves don't trigger a reload. */
	private lastYaml: string | null = null;
	private pending: Project | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: SimpleGanttPlugin) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return this.file ? this.file.basename : "Simple Gantt";
	}

	getIcon() {
		return ICON_ID;
	}

	async onOpen() {
		this.contentEl.empty();
		this.contentEl.addClass("simple-gantt-view");
		this.board = new GanttBoard(this.contentEl, {
			save: (p) => this.queueSave(p),
			today: () => todayIso(),
			listProjects: () => this.plugin.listProjects().map((f) => ({ id: f.path, title: this.titleOf(f) })),
			switchProject: (path) => void this.openPath(path),
			createProject: (t) => void this.createProject(t),
			exportFile: (name, data) => this.exportFile(name, data),
			notify: (m) => new Notice(m),
			openNote: (link) => void this.app.workspace.openLinkText(link, this.file?.path ?? "", "tab"),
			suggestNotes: (q) => this.suggestNotes(q),
		});

		this.registerEvent(this.app.workspace.on("css-change", () => this.board?.refreshTheme()));
		this.registerEvent(this.app.vault.on("modify", (f) => f === this.file && this.reloadFromDisk()));
		this.registerEvent(this.app.vault.on("rename", (f) => {
			if (f === this.file) {
				this.plugin.rememberProject(f.path);
				this.board?.setProject(this.board.getProject(), f.path);
			}
		}));
		this.registerEvent(this.app.vault.on("delete", (f) => {
			if (f === this.file) {
				this.file = null;
				this.board?.setProject(null);
			}
		}));

		if (!this.file) {
			const last = this.plugin.settings.lastProject;
			const candidate = (last && this.app.vault.getAbstractFileByPath(last)) || this.plugin.listProjects()[0];
			if (candidate instanceof TFile) await this.loadFile(candidate);
			else this.board.setProject(null);
		}
	}

	async onClose() {
		await this.flush();
		this.board?.destroy();
		this.board = null;
	}

	getState() {
		return { ...super.getState(), file: this.file?.path ?? null };
	}

	async setState(state: { file?: string | null }, result: Parameters<ItemView["setState"]>[1]) {
		if (state?.file) await this.openPath(state.file);
		return super.setState(state, result);
	}

	async openPath(path: string) {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.loadFile(f);
		else new Notice(`Simple Gantt: “${path}” was not found`);
	}

	private titleOf(f: TFile): string {
		return f.basename;
	}

	private async loadFile(file: TFile) {
		await this.flush();
		const text = await this.app.vault.read(file);
		const yaml = extractBlock(text);
		let raw: unknown = {};
		try {
			raw = yaml ? parseYaml(yaml) : {};
		} catch {
			new Notice(`Simple Gantt: could not read the data in “${file.basename}”. Check the YAML block.`);
			return;
		}
		this.file = file;
		this.lastYaml = yaml;
		this.plugin.rememberProject(file.path);
		this.board?.setProject(normalizeProject(raw, file.basename), file.path);
		// Tab title follows the project.
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}

	private async reloadFromDisk() {
		if (!this.file || this.pending) return;
		const text = await this.app.vault.read(this.file);
		const yaml = extractBlock(text);
		if (yaml === null || yaml === this.lastYaml) return;
		try {
			this.lastYaml = yaml;
			this.board?.setProject(normalizeProject(parseYaml(yaml), this.file.basename), this.file.path);
		} catch {
			// Mid-edit YAML in the editor: keep showing the last good version.
		}
	}

	private queueSave(project: Project) {
		this.pending = project;
		this.saveSoon();
	}

	private saveSoon = debounce(() => void this.flush(), 400, true);

	private async flush() {
		const project = this.pending;
		const file = this.file;
		if (!project || !file) return;
		this.pending = null;
		const yaml = stringifyYaml(toPlain(project));
		this.lastYaml = yaml.replace(/\n*$/, "\n");
		await this.app.vault.process(file, (text) => replaceBlock(text, yaml));
	}

	private async createProject(template: TemplateId) {
		const title = template === "dissertation" ? "Dissertation timeline" : "New timeline";
		const project = createFromTemplate(template, title, todayIso());
		const file = await this.plugin.createProjectFile(project);
		if (file) await this.loadFile(file);
	}

	private suggestNotes(query: string): string[] {
		const q = query.toLowerCase();
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => !this.app.metadataCache.getFileCache(f)?.frontmatter?.[FRONTMATTER_KEY])
			.map((f) => f.path.replace(/\.md$/, ""))
			.filter((p) => !q || p.toLowerCase().includes(q))
			.slice(0, 30);
	}

	private async exportFile(name: string, data: Blob | string) {
		const folder = this.plugin.settings.exportFolder || this.file?.parent?.path || "";
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
		const path = normalizePath(folder ? `${folder}/${name}` : name);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (typeof data === "string") {
			if (existing instanceof TFile) await this.app.vault.modify(existing, data);
			else await this.app.vault.create(path, data);
		} else {
			const buf = await data.arrayBuffer();
			if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, buf);
			else await this.app.vault.createBinary(path, buf);
		}
		new Notice(`Exported to ${path}`);
	}
}

