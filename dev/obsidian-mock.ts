/* A minimal in-memory stand-in for the Obsidian API, enough to run the plugin end to end in a browser. */
import { parse as parseYamlText, stringify as stringifyYamlText } from "yaml";
import "./obsidian-dom";

type Cb = (...args: any[]) => void;

export const notices: string[] = [];
export class Notice { constructor(m: string) { notices.push(m); } }

export class TFile {
	stat = { mtime: Date.now() };
	constructor(public path: string) {}
	get basename() { return this.path.split("/").pop()!.replace(/\.[^.]+$/, ""); }
	get extension() { return this.path.split(".").pop()!; }
	get parent() { const i = this.path.lastIndexOf("/"); return { path: i > 0 ? this.path.slice(0, i) : "" }; }
}

class Events {
	private handlers: Record<string, Cb[]> = {};
	on(name: string, cb: Cb) { (this.handlers[name] ??= []).push(cb); return { name, cb }; }
	trigger(name: string, ...args: any[]) { for (const cb of this.handlers[name] ?? []) cb(...args); }
}

export class Vault extends Events {
	data = new Map<string, string | ArrayBuffer>();
	files = new Map<string, TFile>();
	folders = new Set<string>();
	getAbstractFileByPath(p: string) { return this.files.get(p) ?? (this.folders.has(p) ? { path: p } : null); }
	getMarkdownFiles() { return [...this.files.values()].filter((f) => f.extension === "md"); }
	async read(f: TFile) { return this.data.get(f.path) as string; }
	async create(p: string, s: string) { const f = new TFile(p); this.files.set(p, f); this.data.set(p, s); this.trigger("create", f); return f; }
	async createBinary(p: string, b: ArrayBuffer) { const f = new TFile(p); this.files.set(p, f); this.data.set(p, b); return f; }
	async modify(f: TFile, s: string) { this.data.set(f.path, s); f.stat.mtime = Date.now(); this.trigger("modify", f); }
	async modifyBinary(f: TFile, b: ArrayBuffer) { this.data.set(f.path, b); }
	async process(f: TFile, fn: (s: string) => string) { const s = fn(this.data.get(f.path) as string); await this.modify(f, s); return s; }
	async createFolder(p: string) { this.folders.add(p); }
}

export class MetadataCache {
	constructor(private vault: Vault) {}
	getFileCache(f: TFile) {
		const s = this.vault.data.get(f.path);
		const m = typeof s === "string" ? /^---\n([\s\S]*?)\n---/.exec(s) : null;
		return m ? { frontmatter: parseYamlText(m[1]) as Record<string, unknown> } : {};
	}
}

const viewFactories: Record<string, (leaf: WorkspaceLeaf) => any> = {};

export class WorkspaceLeaf {
	view: any = null;
	constructor(public app: App) {}
	async setViewState(s: { type: string; state?: any }) {
		this.view = viewFactories[s.type](this);
		document.getElementById("host")?.appendChild(this.view.contentEl);
		await this.view.onOpen();
		if (s.state) await this.view.setState(s.state, {});
	}
}

export class Workspace extends Events {
	leaves: WorkspaceLeaf[] = [];
	constructor(private app: App) { super(); }
	getLeavesOfType(t: string) { return this.leaves.filter((l) => l.view?.getViewType() === t); }
	getLeaf() { const l = new WorkspaceLeaf(this.app); this.leaves.push(l); return l; }
	async revealLeaf() {}
	getActiveFile() { return null; }
	openLinkText(link: string) { notices.push(`open:${link}`); }
}

export class App {
	vault = new Vault();
	metadataCache = new MetadataCache(this.vault);
	workspace = new Workspace(this);
}

export class Component {
	registerEvent() {}
}

export class ItemView extends Component {
	app: App;
	contentEl = document.createElement("div");
	constructor(public leaf: WorkspaceLeaf) { super(); this.app = leaf.app; }
	getState() { return {}; }
	async setState() {}
	registerEvent() {}
}

export class Plugin extends Component {
	commands: any[] = [];
	processors: Record<string, Function> = {};
	saved: any = null;
	constructor(public app: App, public manifest: any = {}) { super(); }
	registerView(t: string, f: (leaf: WorkspaceLeaf) => any) { viewFactories[t] = f; }
	addRibbonIcon(_i: string, title: string, cb: () => void) { (window as any).ribbon = { title, cb }; }
	addCommand(c: any) { this.commands.push(c); }
	registerMarkdownCodeBlockProcessor(lang: string, f: Function) { this.processors[lang] = f; }
	addSettingTab() {}
	async loadData() { return this.saved; }
	async saveData(d: any) { this.saved = JSON.parse(JSON.stringify(d)); }
}

export class PluginSettingTab { constructor(public app: App, public plugin: Plugin) {} }
export class Setting {}

export function addIcon() {}
export const parseYaml = (s: string): unknown => parseYamlText(s);
export const stringifyYaml = (o: unknown) => stringifyYamlText(o, { lineWidth: 0 });
export function normalizePath(p: string) { return p.replace(/\/+/g, "/").replace(/^\/|\/$/g, ""); }
export function debounce(fn: Cb, ms: number) {
	let t: any;
	return (...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
