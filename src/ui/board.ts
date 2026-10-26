import { MONTHS_LONG, formatDay, formatDuration, formatRange, fromDay, toDay, ymd } from "../core/dates";
import { PROMPTS, REVIEW_PROMPTS, prompt, slotStates } from "../core/journal";
import { Nudge, computeNudges, nextDeadline, overallProgress, rippleShift } from "../core/nudges";
import { addLink, enforceLinks, predecessorsOf, pruneLinks, removeLink, successorsOf, wouldCycle } from "../core/links";
import { Layout, Placed, computeLayout } from "../core/layout";
import { ParseResult, parseQuickAdd } from "../core/parse";
import { MOOD_COLORS, connectorX, makeMeasure, paintBody, paintHeader, paintLabels, renderExportSvg, svgEl, svgToPng, svgToString } from "../core/render";
import { TEMPLATES, TemplateId } from "../core/templates";
import { Theme, themeFromCss } from "../core/theme";
import {
	CHECKIN_LABELS, COLOR_ORDER, CheckIn, ColorName, GanttItem, ITEM_TYPES, ITEM_TYPE_LABELS, ItemType, MOODS, Mood, Project,
	addPhase, cloneProject, isCheckable, isDone, isRangeType, newId,
} from "../core/types";
import { confetti } from "./confetti";
import { icon } from "./icons";

type PanelFocus = "title" | "review" | "planb" | null;

interface JournalDraft {
	date: string;
	mood?: Mood;
	text: string;
	editingId?: string;
}

/** Everything the board needs from the app around it (Obsidian, or the preview harness). */
export interface BoardHost {
	save(project: Project): void;
	today(): string;
	listProjects(): { id: string; title: string }[];
	switchProject(id: string): void;
	createProject(template: TemplateId): void;
	exportFile(filename: string, data: Blob | string): Promise<void>;
	notify(message: string): void;
	openNote?(link: string): void;
	suggestNotes?(query: string): string[];
}

type Zoom = "year" | "quarter" | "month" | "custom";
const ZOOM_SPAN: Record<Exclude<Zoom, "custom">, number> = { year: 0, quarter: 92, month: 31 };
const MAX_PPD = 48;

interface Drag {
	pointerId: number;
	kind: "move" | "start" | "end" | "create" | "link";
	startX: number;
	startY: number;
	moved: boolean;
	item?: GanttItem;
	orig?: { start: string; end?: string; phase?: string };
	laneKey?: string;
	anchorDay?: number;
	currentDay?: number;
	snapshot?: Project;
	/** Link drags: the item under the pointer. */
	targetId?: string | null;
}

type El = HTMLElement;

/** A child for h(): an element, text, or nothing. */
type Kid = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
	tag: K, opts: { cls?: string; text?: string; kids?: Kid[]; attrs?: Record<string, string> } = {}, parent?: Element,
): HTMLElementTagNameMap[K] {
	const el = createEl(tag);
	if (opts.cls) el.className = opts.cls;
	if (opts.text !== undefined) el.textContent = opts.text;
	if (opts.kids) append(el, opts.kids);
	if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) el.setAttribute(k, v);
	if (parent) parent.appendChild(el);
	return el;
}

function append(el: Element, kids: Kid[]) {
	for (const k of kids) if (k) el.append(k);
}

/** A <span> with text, for icon + label buttons. */
function span(text: string, cls?: string): HTMLSpanElement {
	return h("span", { text, cls });
}

/** A small colour dot (phase colour) as an element. */
function dot(color: string): HTMLElement {
	const i = h("i");
	i.setCssProps({ "--sg-dot": color });
	return i;
}

const PLACEHOLDERS: Record<ItemType, string> = {
	task: "Add a task…  e.g. Literature review Jan–Mar #lit",
	milestone: "Add a milestone…  e.g. Chapter 2 drafted 20 Jan",
	deadline: "Add a deadline…  e.g. Ethics submission 15 Feb",
	event: "Add a key date…  e.g. Supervisor meeting 3 Dec",
	location: "Add a location…  e.g. Fieldwork Lisbon 22 Feb – 9 Apr",
};

export class GanttBoard {
	readonly root: El;
	private project: Project | null = null;
	private projectId: string | null = null;
	private theme!: Theme;
	private measure = makeMeasure("sans-serif");
	private layout: Layout | null = null;

	private zoom: Zoom = "year";
	private ppd = 2;
	private zoomAnim = 0;
	private selectedId: string | null = null;
	private flashId: string | null = null;
	private quickType: ItemType = "task";
	private activePhase: string | null = null;
	private undoStack: string[] = [];
	private redoStack: string[] = [];
	private drag: Drag | null = null;
	private panelMode: "item" | "project" | "journal" | null = null;
	private nudgeIndex = 0;
	private dismissedNudges = new Set<string>();
	private draft: JournalDraft | null = null;
	private journalFocusId: string | null = null;
	private resizeObs: ResizeObserver;

	// Elements
	private toolbar!: El;
	private titleBtn!: El;
	private zoomBtns = new Map<Zoom, El>();
	private undoBtn!: HTMLButtonElement;
	private stats!: El;
	private foldBtn!: El;
	private nudgeBar!: El;
	private quick!: El;
	private quickInput!: HTMLInputElement;
	private quickPreview!: El;
	private typeChips = new Map<ItemType, El>();
	private scroller!: El;
	private canvas!: El;
	private corner!: El;
	private headerWrap!: El;
	private labelsWrap!: El;
	private bodyWrap!: El;
	private tooltip!: El;
	private panel!: El;
	private menu: El | null = null;
	private empty!: El;

	constructor(container: El, private host: BoardHost) {
		this.root = h("div", { cls: "sg-root", attrs: { tabindex: "-1" } }, container);
		this.build();
		this.refreshTheme();
		this.resizeObs = new ResizeObserver(() => {
			if (this.zoom !== "custom") this.ppd = this.fitPpd(this.zoom);
			this.render();
		});
		this.resizeObs.observe(this.root);
	}

	destroy() {
		this.resizeObs.disconnect();
		window.cancelAnimationFrame(this.zoomAnim);
		this.root.remove();
	}

	/** Load (or replace) the project shown. External edits keep the view's zoom and scroll. */
	setProject(project: Project | null, id: string | null = null) {
		const switched = id !== this.projectId;
		this.project = project;
		this.projectId = id;
		// The board never calls this for its own edits, so any history refers to a different document now.
		this.undoStack = [];
		this.redoStack = [];
		if (switched) {
			this.selectedId = null;
			this.closePanel();
			this.zoom = "year";
			this.ppd = this.fitPpd("year");
		} else if (this.selectedId && !project?.items.some((i) => i.id === this.selectedId)) {
			this.selectedId = null;
			this.closePanel();
		} else if (this.panelMode) this.refreshPanel();
		this.root.classList.toggle("is-empty", !project);
		this.render();
	}

	getProject(): Project | null {
		return this.project;
	}

	refreshTheme() {
		this.theme = themeFromCss(this.root);
		this.measure = makeMeasure(this.theme.font);
		this.render();
	}

	// ─── Structure ─────────────────────────────────────────────────────────

	private build() {
		const r = this.root;
		this.toolbar = h("div", { cls: "sg-toolbar" }, r);
		this.titleBtn = h("button", { cls: "sg-title-btn", attrs: { "aria-label": "Switch or create project" } }, this.toolbar);
		this.titleBtn.addEventListener("click", () => this.openProjectMenu());
		this.stats = h("div", { cls: "sg-stats" }, this.toolbar);
		h("div", { cls: "sg-spacer" }, this.toolbar);

		this.undoBtn = h("button", { cls: "sg-btn sg-icon-btn", kids: [icon("undo")], attrs: { "aria-label": "Undo (Ctrl+Z)" } }, this.toolbar);
		this.undoBtn.addEventListener("click", () => this.undo());

		const seg = h("div", { cls: "sg-seg", attrs: { role: "group", "aria-label": "Zoom" } }, this.toolbar);
		for (const z of ["year", "quarter", "month"] as const) {
			const b = h("button", { text: z[0].toUpperCase() + z.slice(1) }, seg);
			b.addEventListener("click", () => this.setZoom(z));
			this.zoomBtns.set(z, b);
		}
		const todayBtn = h("button", { cls: "sg-btn", kids: [icon("today"), span(`Today`)] }, this.toolbar);
		todayBtn.addEventListener("click", () => this.scrollToToday());
		const exportBtn = h("button", { cls: "sg-btn", kids: [icon("download"), span(`Export`)] }, this.toolbar);
		exportBtn.addEventListener("click", () => this.openExportMenu(exportBtn));
		const journalBtn = h("button", { cls: "sg-btn sg-journal-btn", kids: [icon("book"), span(`Journal`)], attrs: { "aria-label": "Journal (J)" } }, this.toolbar);
		journalBtn.addEventListener("click", () => (this.panelMode === "journal" ? this.closePanel() : this.openJournal()));
		const settingsBtn = h("button", { cls: "sg-btn sg-icon-btn", kids: [icon("settings")], attrs: { "aria-label": "Project settings" } }, this.toolbar);
		settingsBtn.addEventListener("click", () => this.openProjectPanel());
		this.foldBtn = h("button", { cls: "sg-btn sg-icon-btn", kids: [icon("fold")], attrs: { "aria-label": "Fold all phases (F)" } }, this.toolbar);
		this.foldBtn.addEventListener("click", () => this.toggleFoldAll());
		this.toolbar.insertBefore(this.foldBtn, settingsBtn);
		const helpBtn = h("button", { cls: "sg-btn sg-icon-btn", kids: [icon("help")], attrs: { "aria-label": "How to use (?)" } }, this.toolbar);
		helpBtn.addEventListener("click", () => this.openHelp(helpBtn));

		// Quick add
		this.quick = h("div", { cls: "sg-quick" }, r);
		const row = h("div", { cls: "sg-quick-row" }, this.quick);
		const chips = h("div", { cls: "sg-chips", attrs: { role: "radiogroup", "aria-label": "Type" } }, row);
		for (const t of ITEM_TYPES) {
			const c = h("button", { cls: `sg-chip sg-chip-${t}`, kids: [icon(t, 14), span(`${ITEM_TYPE_LABELS[t]}`)], attrs: { role: "radio" } }, chips);
			c.addEventListener("click", () => {
				this.quickType = t;
				this.syncQuick();
				this.quickInput.focus();
			});
			this.typeChips.set(t, c);
		}
		const field = h("div", { cls: "sg-quick-field" }, row);
		h("span", { cls: "sg-quick-plus", kids: [icon("plus")] }, field);
		this.quickInput = h("input", { cls: "sg-quick-input", attrs: { type: "text", spellcheck: "false", "aria-label": "Quick add" } }, field);
		h("kbd", { cls: "sg-kbd", kids: [icon("enter", 12)] }, field);
		this.quickPreview = h("div", { cls: "sg-quick-preview" }, this.quick);
		this.quickInput.addEventListener("input", () => this.syncQuick());
		this.quickInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.commitQuick(e.shiftKey);
			} else if (e.key === "Escape") {
				this.quickInput.value = "";
				this.syncQuick();
				this.quickInput.blur();
			}
		});

		this.nudgeBar = h("div", { cls: "sg-nudges", attrs: { "aria-live": "polite" } }, r);

		// Chart
		this.scroller = h("div", { cls: "sg-scroller" }, r);
		this.canvas = h("div", { cls: "sg-canvas" }, this.scroller);
		this.corner = h("div", { cls: "sg-corner" }, this.canvas);
		this.headerWrap = h("div", { cls: "sg-header" }, this.canvas);
		this.labelsWrap = h("div", { cls: "sg-labels" }, this.canvas);
		this.labelsWrap.addEventListener("click", (e) => this.onLabelClick(e));
		this.bodyWrap = h("div", { cls: "sg-body" }, this.canvas);
		this.tooltip = h("div", { cls: "sg-tooltip" }, r);
		this.panel = h("div", { cls: "sg-panel", attrs: { "aria-hidden": "true" } }, r);

		this.empty = h("div", { cls: "sg-empty" }, r);
		this.buildEmpty();

		this.bindPointer();
		this.scroller.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
		let scrollFrame = 0;
		this.scroller.addEventListener("scroll", () => {
			window.cancelAnimationFrame(scrollFrame);
			scrollFrame = window.requestAnimationFrame(() => this.paintHeaderOnly());
		});
		this.root.addEventListener("keydown", (e) => this.onKey(e));
		this.root.addEventListener("pointerdown", (e) => {
			if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
			// Clicking the chart gives the board keyboard focus (arrows, Space, F, J…).
			if ((e.target as Element).closest(".sg-scroller")) this.root.focus({ preventScroll: true });
		});
		this.syncQuick();
	}

	private buildEmpty() {
		const card = h("div", { cls: "sg-empty-card" }, this.empty);
		h("div", { cls: "sg-empty-icon", kids: [icon("gantt", 28)] }, card);
		h("h2", { text: "Plan your project on a timeline" }, card);
		h("p", { text: "Phases, tasks, milestones, deadlines, key dates and places — all on one clean chart you can export for your report." }, card);
		const opts = h("div", { cls: "sg-empty-options" }, card);
		for (const t of TEMPLATES) {
			const b = h("button", { cls: "sg-template" }, opts);
			h("strong", { text: t.name }, b);
			h("span", { text: t.description }, b);
			b.addEventListener("click", () => this.host.createProject(t.id));
		}
	}

	// ─── Rendering ─────────────────────────────────────────────────────────

	private labelWidth(): number {
		return this.root.clientWidth < 640 ? 152 : 236;
	}

	private fitPpd(zoom: Zoom): number {
		if (!this.project) return 2;
		const avail = Math.max(200, this.scroller.clientWidth - this.labelWidth() - 1);
		if (zoom === "year" || zoom === "custom") {
			const probe = computeLayout(this.project, { pxPerDay: 1, showEmptyLanes: true, measure: this.measure });
			return Math.max(1.2, avail / (probe.viewEnd - probe.viewStart + 1));
		}
		return Math.min(MAX_PPD, avail / ZOOM_SPAN[zoom]);
	}

	render() {
		const p = this.project;
		this.titleBtn.replaceChildren(span(p?.title ?? "Simple Gantt", "sg-title-text"), icon("chevronDown", 14));
		for (const [z, b] of this.zoomBtns) b.classList.toggle("is-active", z === this.zoom);
		const allFolded = !!p?.phases.length && p.phases.every((ph) => ph.collapsed);
		this.foldBtn.replaceChildren(icon(allFolded ? "unfold" : "fold"));
		this.foldBtn.setAttribute("aria-label", allFolded ? "Unfold all phases (F)" : "Fold all phases (F)");
		this.foldBtn.classList.toggle("is-active", allFolded);
		this.undoBtn.disabled = !this.undoStack.length;
		if (!p) {
			this.layout = null;
			this.stats.replaceChildren();
			this.nudgeBar.replaceChildren();
			this.nudgeBar.classList.remove("is-visible");
			return;
		}
		const labelW = this.labelWidth();
		const today = toDay(this.host.today());
		const layout = computeLayout(p, { pxPerDay: this.ppd, showEmptyLanes: true, showJournal: true, today, measure: this.measure });
		this.layout = layout;
		if (!this.drag?.moved) {
			this.renderStats();
			this.renderNudges();
		}
		const paint = {
			theme: this.theme, measure: this.measure, today: toDay(this.host.today()),
			selectedId: this.selectedId, flashId: this.flashId, interactive: true,
		};
		this.canvas.setCssProps({
			"--sg-cols": `${labelW}px ${layout.width}px`,
			"--sg-rows": `${layout.headerH}px ${layout.bodyH}px`,
		});
		this.corner.replaceChildren();
		h("span", { cls: "sg-corner-label", text: "Phases" }, this.corner);
		this.headerWrap.replaceChildren(paintHeader(layout, { ...paint, visible: this.visibleRange() }));
		this.labelsWrap.replaceChildren(paintLabels(layout, labelW, paint));
		this.bodyWrap.replaceChildren(paintBody(layout, paint));
		if (this.drag?.kind === "create") this.paintGhost();
		this.flashId = null;
	}

	private visibleRange(): [number, number] {
		const from = this.scroller.scrollLeft;
		return [from, from + this.scroller.clientWidth - this.labelWidth()];
	}

	private paintHeaderOnly() {
		if (!this.layout) return;
		const paint = { theme: this.theme, measure: this.measure, today: toDay(this.host.today()), visible: this.visibleRange() };
		this.headerWrap.replaceChildren(paintHeader(this.layout, paint));
	}

	// ─── Zoom & scroll ─────────────────────────────────────────────────────

	setZoom(zoom: Exclude<Zoom, "custom">) {
		if (!this.project) return;
		const target = this.fitPpd(zoom);
		const anchorDay = zoom === "year" ? null : this.centerAnchorDay();
		this.zoom = zoom;
		this.animatePpd(target, anchorDay, this.scroller.clientWidth / 2);
	}

	/** The day at the centre of the view, or today when it's visible-ish. */
	private centerAnchorDay(): number {
		const today = toDay(this.host.today());
		if (!this.layout) return today;
		const { viewStart, viewEnd } = this.layout;
		if (this.zoom === "year" && today >= viewStart && today <= viewEnd) return today;
		const x = this.scroller.scrollLeft + (this.scroller.clientWidth - this.labelWidth()) / 2;
		return this.layout.viewStart + x / this.ppd;
	}

	/** Smoothly change pixels-per-day, keeping `anchorDay` under screen x `anchorX` (relative to scroller). */
	private animatePpd(target: number, anchorDay: number | null, anchorX: number) {
		window.cancelAnimationFrame(this.zoomAnim);
		const from = this.ppd;
		const t0 = performance.now();
		const dur = 320;
		const step = (now: number) => {
			const t = Math.min(1, (now - t0) / dur);
			const e = 1 - Math.pow(1 - t, 3);
			this.ppd = Math.exp(Math.log(from) + (Math.log(target) - Math.log(from)) * e);
			this.render();
			if (anchorDay !== null && this.layout) {
				const x = this.labelWidth() + (anchorDay - this.layout.viewStart) * this.ppd;
				this.scroller.scrollLeft = x - anchorX;
			} else if (this.zoom === "year") this.scroller.scrollLeft *= 1 - e;
			if (t < 1) this.zoomAnim = window.requestAnimationFrame(step);
		};
		this.zoomAnim = window.requestAnimationFrame(step);
	}

	private onWheel(e: WheelEvent) {
		if (!(e.ctrlKey || e.metaKey) || !this.layout) return;
		e.preventDefault();
		const rect = this.scroller.getBoundingClientRect();
		const ax = e.clientX - rect.left;
		const day = this.layout.viewStart + (this.scroller.scrollLeft + ax - this.labelWidth()) / this.ppd;
		const min = this.fitPpd("year");
		this.ppd = Math.min(MAX_PPD, Math.max(min, this.ppd * Math.exp(-e.deltaY * 0.0025)));
		this.zoom = this.ppd <= min + 0.001 ? "year" : "custom";
		this.render();
		this.scroller.scrollLeft = this.labelWidth() + (day - this.layout.viewStart) * this.ppd - ax;
	}

	scrollToToday() {
		if (!this.layout) return;
		const today = toDay(this.host.today());
		const x = this.labelWidth() + this.layout.xOf(today);
		this.scroller.scrollTo({ left: x - this.labelWidth() - (this.scroller.clientWidth - this.labelWidth()) / 3, behavior: "smooth" });
	}

	// ─── Mutations & undo ──────────────────────────────────────────────────

	private snapshot() {
		if (!this.project) return;
		this.undoStack.push(JSON.stringify(this.project));
		if (this.undoStack.length > 100) this.undoStack.shift();
		this.redoStack = [];
	}

	private commit() {
		if (!this.project) return;
		pruneLinks(this.project);
		const pushed = enforceLinks(this.project);
		this.host.save(this.project);
		this.render();
		if (pushed.length)
			this.host.notify(`Moved ${pushed.length} linked item${pushed.length === 1 ? "" : "s"} later to keep the order`);
	}

	undo() {
		const prev = this.undoStack.pop();
		if (!prev || !this.project) return;
		this.redoStack.push(JSON.stringify(this.project));
		this.project = JSON.parse(prev) as Project;
		this.afterHistory();
	}

	redo() {
		const next = this.redoStack.pop();
		if (!next || !this.project) return;
		this.undoStack.push(JSON.stringify(this.project));
		this.project = JSON.parse(next) as Project;
		this.afterHistory();
	}

	private afterHistory() {
		if (this.selectedId && !this.findItem(this.selectedId)) {
			this.selectedId = null;
			this.closePanel();
		} else if (this.panelMode) this.refreshPanel();
		this.commit();
	}

	private findItem(id: string): GanttItem | undefined {
		return this.project?.items.find((i) => i.id === id);
	}

	private addItem(item: GanttItem, openEditor = false) {
		if (!this.project) return;
		this.project.items.push(item);
		this.flashId = item.id;
		if (item.phase) this.activePhase = item.phase;
		if (openEditor) this.select(item.id, true);
		this.commit();
	}

	deleteItem(id: string) {
		if (!this.project) return;
		const item = this.findItem(id);
		if (!item) return;
		this.snapshot();
		this.project.items = this.project.items.filter((i) => i.id !== id);
		if (this.selectedId === id) {
			this.selectedId = null;
			this.closePanel();
		}
		this.commit();
		this.host.notify(`Deleted “${item.title}” — press Ctrl+Z to undo`);
	}

	private select(id: string | null, openPanel = false, focus: PanelFocus = "title") {
		this.selectedId = id;
		if (id && openPanel) this.openItemPanel(focus);
		else if (!id && this.panelMode === "item") this.closePanel();
		this.render();
	}

	// ─── Quick add ─────────────────────────────────────────────────────────

	private parseQuick(): ParseResult | null {
		if (!this.project) return null;
		return parseQuickAdd(this.quickInput.value, { project: this.project, defaultType: this.quickType, today: this.host.today() });
	}

	private defaultPhase(): string | undefined {
		const p = this.project;
		if (!p || !p.phases.length) return undefined;
		if (this.activePhase && p.phases.some((ph) => ph.id === this.activePhase)) return this.activePhase;
		return p.phases[0].id;
	}

	private syncQuick() {
		for (const [t, c] of this.typeChips) {
			c.classList.toggle("is-active", t === this.quickType);
			c.setAttribute("aria-checked", String(t === this.quickType));
		}
		this.quickInput.placeholder = PLACEHOLDERS[this.quickType];
		this.quickPreview.replaceChildren();
		const jot = this.quickJournalText();
		if (jot !== null) {
			this.quick.classList.add("has-preview");
			h("span", { cls: "sg-pv-type", kids: [icon("book", 12), `Journal`] }, this.quickPreview);
			h("span", { cls: "sg-pv-title", text: jot || "Write a quick note…" }, this.quickPreview);
			h("span", { cls: "sg-pv-date", text: formatDay(toDay(this.host.today())) }, this.quickPreview);
			return;
		}
		const r = this.parseQuick();
		this.quick.classList.toggle("has-preview", !!r);
		if (!r || !this.project) return;
		const pv = this.quickPreview;
		h("span", { cls: `sg-pv-type sg-chip-${r.type}`, kids: r.buffer ? [icon("buffer", 12), "Buffer"] : [icon(r.type, 12), `${ITEM_TYPE_LABELS[r.type]}`] }, pv);
		h("span", { cls: "sg-pv-title", text: r.title || "Untitled" }, pv);
		const s = toDay(r.start);
		const e = r.end ? toDay(r.end) : s;
		h("span", { cls: "sg-pv-date", text: isRangeType(r.type) ? `${formatRange(s, e)} · ${formatDuration(e - s + 1)}` : formatDay(s) }, pv);
		if (r.type === "task" || r.type === "milestone") {
			const phase = r.phase ? this.project.phases.find((p) => p.id === r.phase) : r.newPhase ? null : this.project.phases.find((p) => p.id === this.defaultPhase());
			if (phase) h("span", { cls: "sg-pv-phase", kids: [dot(this.theme.palette[phase.color]), phase.name] }, pv);
			else if (r.newPhase) h("span", { cls: "sg-pv-phase is-new", kids: [icon("plus", 11), `New phase “${r.newPhase}”`] }, pv);
		}
		if (r.progress !== undefined) h("span", { cls: "sg-pv-date", text: `${r.progress}%` }, pv);
		if (r.dateGuessed) h("span", { cls: "sg-pv-hint", text: "No date found — try “Mar”, “15 Feb” or “Jan–Mar”" }, pv);
	}

	/** Text after a leading ">" (a quick journal line), or null. */
	private quickJournalText(): string | null {
		const v = this.quickInput.value.trim();
		return v.startsWith(">") ? v.slice(1).trim() : null;
	}

	private commitQuick(openEditor: boolean) {
		const jot = this.quickJournalText();
		if (jot !== null) {
			if (!jot || !this.project) return;
			this.snapshot();
			(this.project.journal ??= []).push({ id: newId(), date: this.host.today(), text: jot });
			this.commit();
			this.quickInput.value = "";
			this.syncQuick();
			this.host.notify("Added to your journal ✍️");
			if (openEditor) this.openJournal();
			return;
		}
		const r = this.parseQuick();
		if (!r || !this.project) return;
		this.snapshot();
		let phase = r.phase;
		if ((r.type === "task" || r.type === "milestone") && !phase) {
			phase = r.newPhase ? addPhase(this.project, r.newPhase).id : this.defaultPhase();
		}
		const item: GanttItem = { id: newId(), type: r.type, title: r.title || "Untitled", start: r.start };
		if (r.end) item.end = r.end;
		if (phase) item.phase = phase;
		if (r.progress !== undefined) item.progress = r.progress;
		if (r.buffer) item.buffer = true;
		this.addItem(item, openEditor);
		this.quickInput.value = "";
		this.syncQuick();
		this.revealItem(item.id);
	}

	/** Scroll so an item is visible (only matters when zoomed in). */
	private revealItem(id: string) {
		const p = this.layout?.placed.find((x) => x.item.id === id);
		if (!p) return;
		const lw = this.labelWidth();
		const left = this.scroller.scrollLeft;
		const right = left + this.scroller.clientWidth - lw;
		if (p.x0 < left || p.x1 > right) this.scroller.scrollTo({ left: Math.max(0, p.x0 - 80), behavior: "smooth" });
		const top = this.scroller.scrollTop;
		const y = p.cy + (this.layout?.headerH ?? 0);
		if (y < top + 60 || y > top + this.scroller.clientHeight - 20)
			this.scroller.scrollTo({ top: Math.max(0, y - this.scroller.clientHeight / 2), behavior: "smooth" });
	}

	// ─── Pointer interaction ───────────────────────────────────────────────

	private bodyPoint(e: PointerEvent | MouseEvent): { x: number; y: number } {
		const rect = this.bodyWrap.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private laneAt(y: number) {
		return this.layout?.lanes.find((l) => y >= l.y && y < l.y + l.height) ?? null;
	}

	private bindPointer() {
		const body = this.bodyWrap;
		body.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || !this.project || !this.layout) return;
			const target = e.target as Element;
			const part = target.closest("[data-part]");
			const itemEl = target.closest(".sg-item");
			const { x, y } = this.bodyPoint(e);
			if (itemEl && itemEl.getAttribute("data-kind") !== "item") return; // handled on click
			if (target.getAttribute("data-lane") === "journal") return;
			if (itemEl && part) {
				const item = this.findItem(itemEl.getAttribute("data-id")!);
				if (!item) return;
				const role = part.getAttribute("data-part");
				const kind = role === "start" ? "start" : role === "end" ? "end" : role === "link" ? "link" : "move";
				this.drag = {
					pointerId: e.pointerId, kind, startX: x, startY: y, moved: false, item,
					orig: { start: item.start, end: item.end, phase: item.phase },
				};
				body.setPointerCapture(e.pointerId);
				e.preventDefault();
			} else if (target.classList.contains("sg-lane-hit") && e.pointerType !== "touch") {
				this.drag = {
					pointerId: e.pointerId, kind: "create", startX: x, startY: y, moved: false,
					laneKey: target.getAttribute("data-lane")!, anchorDay: this.layout.dayAt(x), currentDay: this.layout.dayAt(x),
				};
				body.setPointerCapture(e.pointerId);
				e.preventDefault();
			} else if (this.selectedId) {
				this.select(null);
			}
		});

		body.addEventListener("click", (e) => {
			const el = (e.target as Element).closest(".sg-item");
			const kind = el?.getAttribute("data-kind");
			if (!el || !kind || kind === "item") return;
			const id = el.getAttribute("data-id")!;
			if (kind === "ghost" || kind === "decision") this.select(el.getAttribute("data-parent"), true, "planb");
			else if (kind === "entry") this.openJournal({ entryId: id.replace(/^journal~/, "") });
			else if (kind === "slot") this.openJournal({ date: fromDay(+id.replace(/^slot~/, "")) });
			else if (kind === "summary") this.setFolded(id.replace(/^phase~/, ""), false);
		});

		body.addEventListener("pointermove", (e) => {
			const d = this.drag;
			const { x, y } = this.bodyPoint(e);
			if (!d) {
				this.hover(e);
				return;
			}
			if (d.pointerId !== e.pointerId || !this.layout || !this.project) return;
			if (!d.moved && Math.hypot(x - d.startX, y - d.startY) < 4) return;
			if (!d.moved) {
				d.moved = true;
				d.snapshot = cloneProject(this.project);
				this.root.classList.add("is-dragging");
			}
			if (d.kind === "link") {
				this.paintLinkDrag(d, x, y, e);
				return;
			}
			if (d.kind === "create") {
				d.currentDay = this.layout.dayAt(x);
				this.paintGhost();
				const [a, b] = [Math.min(d.anchorDay!, d.currentDay), Math.max(d.anchorDay!, d.currentDay)];
				this.showTooltip(e, [h("b", { text: `New ${d.laneKey === "locations" ? "location" : "task"}` }), span(`${formatRange(a, b)} · ${formatDuration(b - a + 1)}`)]);
				return;
			}
			const item = d.item!;
			const delta = Math.round((x - d.startX) / this.ppd);
			const s0 = toDay(d.orig!.start);
			const e0 = d.orig!.end ? toDay(d.orig!.end) : s0;
			let s = s0, en = e0;
			// Start every frame from the positions at drag start, so Shift can be pressed or released mid-drag.
			this.restoreFrom(d.snapshot!);
			let rippled = 0;
			if (d.kind === "move") {
				s = s0 + delta;
				en = e0 + delta;
				const lane = this.laneAt(y);
				if ((item.type === "task" || item.type === "milestone") && lane?.kind === "phase") item.phase = lane.key;
				if (e.shiftKey) rippled = rippleShift(this.project, item, delta) - 1;
			} else if (d.kind === "start") s = Math.min(e0, s0 + delta);
			else en = Math.max(s0, e0 + delta);
			item.start = fromDay(s);
			if (isRangeType(item.type)) item.end = fromDay(en);
			const pushed = enforceLinks(this.project).filter((id) => id !== item.id).length;
			this.render();
			this.paintDragGuides(item);
			const label = isRangeType(item.type) ? `${formatRange(s, en)} · ${formatDuration(en - s + 1)}` : formatDay(s);
			const extra = d.kind !== "move" ? null : e.shiftKey
				? h("span", { cls: "sg-tt-ripple", kids: [icon("push", 12), `Moving ${rippled} later item${rippled === 1 ? "" : "s"} too`] })
				: span("Hold Shift to move everything after it", "sg-tt-hint");
			const pushedNote = pushed && !e.shiftKey
				? h("span", { cls: "sg-tt-ripple", kids: [icon("branch", 12), `Pushes ${pushed} linked item${pushed === 1 ? "" : "s"}`] })
				: null;
			this.showTooltip(e, [h("b", { text: item.title }), span(label), pushedNote, extra]);
		});

		const finish = (e: PointerEvent) => {
			const d = this.drag;
			if (!d || d.pointerId !== e.pointerId) return;
			this.drag = null;
			this.root.classList.remove("is-dragging");
			this.hideTooltip();
			if (!this.project || !this.layout) return;
			if (d.kind === "create") {
				this.bodyWrap.querySelector(".sg-ghost")?.remove();
				if (d.moved) this.createFromDrag(d);
				return;
			}
			if (d.kind === "link") {
				this.bodyWrap.querySelector(".sg-link-drag")?.remove();
				if (d.item && d.targetId) this.linkItems(d.item.id, d.targetId);
				else if (!d.moved) this.host.notify("Drag the dot onto another item to link them");
				this.render();
				return;
			}
			if (d.moved) {
				this.undoStack.push(JSON.stringify(d.snapshot));
				this.redoStack = [];
				if (d.item?.phase) this.activePhase = d.item.phase;
				this.commit();
				if (this.panelMode === "item" && this.selectedId === d.item?.id) this.refreshPanel();
			} else if (d.item) {
				// Plain click: open the panel but keep focus on the board so arrow keys and Space work.
				this.select(d.item.id, true, null);
				this.root.focus({ preventScroll: true });
			}
		};
		body.addEventListener("pointerup", finish);
		body.addEventListener("pointercancel", finish);
		body.addEventListener("pointerleave", () => !this.drag && this.hideTooltip());

		body.addEventListener("dblclick", (e) => {
			const target = e.target as Element;
			if (!target.classList.contains("sg-lane-hit") || !this.layout || !this.project) return;
			const lane = this.layout.lanes.find((l) => l.key === target.getAttribute("data-lane"));
			if (!lane) return;
			const day = this.layout.dayAt(this.bodyPoint(e).x);
			if (lane.kind === "journal") return this.openJournal({ date: fromDay(day) });
			this.snapshot();
			const item: GanttItem =
				lane.kind === "keydates" ? { id: newId(), type: "event", title: "New key date", start: fromDay(day) } :
				lane.kind === "locations" ? { id: newId(), type: "location", title: "New location", start: fromDay(day), end: fromDay(day + 6) } :
				{ id: newId(), type: "milestone", title: "New milestone", start: fromDay(day), phase: lane.phase?.id };
			this.addItem(item, true);
		});
	}

	private paintGhost() {
		const d = this.drag;
		if (!d || d.kind !== "create" || !this.layout) return;
		const lane = this.layout.lanes.find((l) => l.key === d.laneKey);
		const svg = this.bodyWrap.querySelector("svg");
		if (!lane || !svg) return;
		svg.querySelector(".sg-ghost")?.remove();
		const a = Math.min(d.anchorDay!, d.currentDay!);
		const b = Math.max(d.anchorDay!, d.currentDay!);
		const x0 = this.layout.xOf(a);
		const color = lane.color ? this.theme.palette[lane.color] : this.theme.inkSecondary;
		svgEl("rect", {
			class: "sg-ghost", x: x0, y: lane.y + lane.height / 2 - this.layout.g.barH / 2, width: Math.max(3, this.layout.xOf(b + 1) - x0), height: this.layout.g.barH,
			rx: 4, fill: color, "fill-opacity": 0.25, stroke: color, "stroke-dasharray": "4 3", "pointer-events": "none",
		}, svg);
	}

	private createFromDrag(d: Drag) {
		if (!this.project || !this.layout) return;
		const lane = this.layout.lanes.find((l) => l.key === d.laneKey);
		if (!lane) return;
		const a = Math.min(d.anchorDay!, d.currentDay!);
		const b = Math.max(d.anchorDay!, d.currentDay!);
		this.snapshot();
		let item: GanttItem;
		if (lane.kind === "locations") item = { id: newId(), type: "location", title: "New location", start: fromDay(a), end: fromDay(b) };
		else if (lane.kind === "keydates") item = { id: newId(), type: "event", title: "New key date", start: fromDay(a) };
		else item = { id: newId(), type: "task", title: "New task", start: fromDay(a), end: fromDay(b), phase: lane.phase?.id };
		this.addItem(item, true);
	}

	private hover(e: PointerEvent) {
		const itemEl = (e.target as Element).closest(".sg-item");
		const id = itemEl?.getAttribute("data-id") ?? null;
		this.bodyWrap.querySelectorAll(".sg-link.is-hot").forEach((l) => l.classList.remove("is-hot"));
		if (id) this.bodyWrap.querySelectorAll(".sg-link").forEach((l) => l.getAttribute("data-link")?.split(" ").includes(id) && l.classList.add("is-hot"));
		const p = itemEl && this.layout?.placed.find((x) => x.item.id === itemEl.getAttribute("data-id"));
		if (!p) return this.hideTooltip();
		this.showTooltip(e, this.tooltipContent(p));
	}

	private tooltipContent(p: Placed): Kid[] {
		const it = p.item;
		const parent = p.parentId ? this.findItem(p.parentId) : undefined;
		const b = (text: string) => h("b", { text });
		if (p.kind === "ghost" && parent?.planB) {
			return [
				b(it.title),
				span(`${formatRange(p.startDay, p.endDay)} · ${formatDuration(p.endDay - p.startDay + 1)}`),
				span(`Alternative for “${parent.title}”, decided on ${formatDay(toDay(parent.planB.by))}`),
				span("Click to open Plan B", "sg-tt-hint"),
			];
		}
		if (p.kind === "decision" && parent?.planB) {
			return [
				b(`${p.state === "due" ? "Decision due" : "Decision point"} · ${formatDay(p.startDay)}`),
				span(`If “${parent.title}” isn't done by then → ${parent.planB.title || "Plan B"}`),
				span("Click to decide", "sg-tt-hint"),
			];
		}
		if (p.kind === "entry") {
			const face = p.mood ? MOODS[p.mood - 1].face + " " : "";
			const text = it.title.length > 220 ? it.title.slice(0, 220) + "…" : it.title;
			return [b(`${face}Journal · ${formatDay(p.startDay)}`), span(text, "sg-tt-desc")];
		}
		if (p.kind === "slot") {
			const msg = p.state === "due" ? "Due now — click to write" : p.state === "missed" ? "Missed — click to catch up" : "Coming up";
			return [b(`Check-in · ${formatDay(p.startDay)}`), span(msg)];
		}
		const parts: Kid[] = [b(it.title)];
		const type = ITEM_TYPE_LABELS[it.type];
		const dates = isRangeType(it.type) ? `${formatRange(p.startDay, p.endDay)} · ${formatDuration(p.endDay - p.startDay + 1)}` : formatDay(p.startDay);
		parts.push(span(`${type} · ${dates}`));
		const phase = this.project?.phases.find((ph) => ph.id === it.phase);
		if (phase) parts.push(h("span", { cls: "sg-tt-phase", kids: [dot(this.theme.palette[phase.color]), phase.name] }));
		if (it.type === "task" && it.progress) {
			const bar = h("i");
			bar.setCssProps({ "--sg-progress": `${it.progress}%` });
			parts.push(h("span", { cls: "sg-tt-progress", kids: [bar] }), span(`${it.progress}% done`));
		}
		if (isDone(it)) {
			const face = it.review?.mood ? ` ${MOODS[it.review.mood - 1].face}` : "";
			parts.push(h("span", { cls: "sg-tt-done", kids: [icon("check", 12), `${this.timingText(it)}${face}`] }));
			if (it.review?.text) parts.push(span(`“${it.review.text}”`, "sg-tt-desc"));
		}
		if (it.planB && !it.planB.status && !isDone(it))
			parts.push(h("span", { cls: "sg-tt-planb", kids: [icon("branch", 12), `Plan B from ${formatDay(toDay(it.planB.by))}: ${it.planB.title || "set up"}`] }));
		if (it.dropped) parts.push(span("Replaced by Plan B", "sg-tt-hint"));
		if (it.description) parts.push(span(it.description, "sg-tt-desc"));
		if (it.note) parts.push(h("span", { cls: "sg-tt-note", kids: [icon("note", 12), it.note] }));
		return parts;
	}

	private showTooltip(e: MouseEvent, kids: Kid[]) {
		const t = this.tooltip;
		t.replaceChildren();
		append(t, kids);
		t.classList.add("is-visible");
		const rect = this.root.getBoundingClientRect();
		const w = t.offsetWidth;
		const hgt = t.offsetHeight;
		let x = e.clientX - rect.left + 14;
		let y = e.clientY - rect.top + 16;
		if (x + w > rect.width - 8) x = e.clientX - rect.left - w - 14;
		if (y + hgt > rect.height - 8) y = e.clientY - rect.top - hgt - 12;
		t.setCssProps({ "--sg-x": `${Math.max(8, x)}px`, "--sg-y": `${Math.max(8, y)}px` });
	}

	private hideTooltip() {
		this.tooltip.classList.remove("is-visible");
	}

	// ─── Folding, row actions, nudging, help ────────────────────────────────

	private onLabelClick(e: MouseEvent) {
		const target = e.target as Element;
		const laneKey = target.closest("[data-lane]")?.getAttribute("data-lane");
		const action = target.closest("[data-action]")?.getAttribute("data-action");
		if (!laneKey || !this.project) return;
		if (action === "add") return this.addToLane(laneKey);
		if (action === "toggle") {
			const phase = this.project.phases.find((ph) => ph.id === laneKey);
			if (phase) this.setFolded(phase.id, !phase.collapsed);
		}
	}

	setFolded(phaseId: string, folded: boolean) {
		const phase = this.project?.phases.find((ph) => ph.id === phaseId);
		if (!phase || !!phase.collapsed === folded) return;
		this.mutate(() => {
			if (folded) phase.collapsed = true;
			else delete phase.collapsed;
		});
	}

	toggleFoldAll() {
		const p = this.project;
		if (!p?.phases.length) return;
		const fold = !p.phases.every((ph) => ph.collapsed);
		this.mutate(() => p.phases.forEach((ph) => (fold ? (ph.collapsed = true) : delete ph.collapsed)));
		this.host.notify(fold ? "Folded every phase into one summary bar. Press F to unfold." : "Unfolded all phases");
	}

	/** The "+" on a row: set up quick add for that row and put the cursor where the title goes. */
	private addToLane(laneKey: string) {
		const lane = this.layout?.lanes.find((l) => l.key === laneKey);
		if (!lane) return;
		let prefill = "";
		if (lane.kind === "phase") {
			this.quickType = "task";
			prefill = ` #${laneKey}`;
			this.activePhase = laneKey;
		} else if (lane.kind === "keydates") this.quickType = "deadline";
		else if (lane.kind === "locations") this.quickType = "location";
		else if (lane.kind === "journal") prefill = "> ";
		this.quickInput.value = prefill;
		this.syncQuick();
		this.quickInput.focus();
		const caret = lane.kind === "journal" ? prefill.length : 0;
		this.quickInput.setSelectionRange(caret, caret);
		this.quick.classList.remove("sg-flash");
		void this.quick.offsetWidth;
		this.quick.classList.add("sg-flash");
	}

	/** Arrow keys: ←/→ move a day (Shift: a week), Alt+←/→ resize, ↑/↓ change phase. */
	private nudgeItem(item: GanttItem, key: string, week: boolean, resize: boolean) {
		const p = this.project;
		if (!p) return;
		const step = week ? 7 : 1;
		if (key === "ArrowLeft" || key === "ArrowRight") {
			const delta = key === "ArrowLeft" ? -step : step;
			this.mutate(() => {
				if (resize && item.end) item.end = fromDay(Math.max(toDay(item.start), toDay(item.end) + delta));
				else {
					item.start = fromDay(toDay(item.start) + delta);
					if (item.end) item.end = fromDay(toDay(item.end) + delta);
				}
			}, this.panelMode === "item");
		} else if ((key === "ArrowUp" || key === "ArrowDown") && (item.type === "task" || item.type === "milestone")) {
			const i = p.phases.findIndex((ph) => ph.id === item.phase);
			const next = p.phases[i + (key === "ArrowUp" ? -1 : 1)];
			if (!next) return;
			this.mutate(() => (item.phase = next.id), this.panelMode === "item");
			this.activePhase = next.id;
		}
		this.revealItem(item.id);
	}

	private addBufferAfter(item: GanttItem) {
		if (!this.project) return;
		const start = toDay(item.end ?? item.start) + (item.type === "task" ? 1 : 0);
		const buffer: GanttItem = {
			id: newId(), type: "task", buffer: true, title: "Buffer", phase: item.phase,
			start: fromDay(start), end: fromDay(start + 13), after: [item.id],
		};
		this.snapshot();
		this.addItem(buffer);
		this.host.notify("Added 2 weeks of buffer. Drag its edges to resize.");
	}

	/** While dragging: dashed guides at the new start/end with the dates in the header. */
	private paintDragGuides(item: GanttItem) {
		const p = this.layout?.placed.find((x) => x.kind === "item" && x.item.id === item.id);
		const body = this.bodyWrap.querySelector("svg");
		const header = this.headerWrap.querySelector("svg");
		if (!p || !body || !header || !this.layout) return;
		const xs: [number, number][] = isRangeType(item.type)
			? [[p.x0, p.startDay], [p.x1, p.endDay]]
			: [[(p.x0 + p.x1) / 2, p.startDay]];
		const hh = this.layout.headerH;
		for (const [x, day] of xs) {
			svgEl("line", { x1: x, x2: x, y1: 0, y2: this.layout.bodyH, stroke: this.theme.accent, "stroke-dasharray": "3 3", opacity: 0.6, "pointer-events": "none" }, body);
			const label = formatDay(day, false);
			const w = this.measure(label, 600, 11) + 14;
			const g = svgEl("g", { class: "sg-guide", "pointer-events": "none" }, header);
			svgEl("rect", { x: x - w / 2, y: hh - 22, width: w, height: 18, rx: 9, fill: this.theme.accent }, g);
			const t = svgEl("text", { x, y: hh - 13, "text-anchor": "middle", "dominant-baseline": "central", fill: "#ffffff", "font-size": 11, "font-weight": 600 }, g);
			t.textContent = label;
		}
	}

	private openHelp(anchor: El) {
		this.popMenu(anchor, (menu) => {
			menu.classList.add("sg-help");
			const section = (title: string, rows: [string, string][]) => {
				h("div", { cls: "sg-menu-label", text: title }, menu);
				for (const [keys, what] of rows) h("div", { cls: "sg-help-row", kids: [h("kbd", { text: keys }), span(what)] }, menu);
			};
			section("Add", [
				["Type above", "e.g. “Lit review Jan–Mar #lit”"],
				["Drag", "across an empty row to draw a task"],
				["Double-click", "a row for a milestone or key date"],
				["+", "on a row's label to add to that row"],
				["! * + @ ~ >", "deadline · milestone · key date · place · buffer · journal"],
			]);
			section("Move", [
				["Drag", "a bar to move it, its edges to resize"],
				["Shift + drag", "moves everything after it too"],
				["← →", "1 day · Shift: 1 week · Alt: resize"],
				["↑ ↓", "move to the phase above / below"],
			]);
			section("Connect & tidy", [
				["Drag the dot", "at a bar's end onto what comes next"],
				["Click a phase", "to fold it into one summary bar · F folds all"],
				["Space", "tick off the selected item"],
				["J · Ctrl+Z", "journal · undo"],
			]);
		});
	}

	// ─── Links ─────────────────────────────────────────────────────────────

	/** While dragging from a connector dot: draw a rubber band and find the item under the pointer. */
	private paintLinkDrag(d: Drag, x: number, y: number, e: PointerEvent) {
		const svg = this.bodyWrap.querySelector("svg");
		const src = this.layout?.placed.find((p) => p.kind === "item" && p.item.id === d.item?.id);
		if (!svg || !src || !this.project) return;
		svg.querySelector(".sg-link-drag")?.remove();
		svg.querySelectorAll(".is-link-target").forEach((el) => el.classList.remove("is-link-target"));
		const under = this.root.ownerDocument.elementFromPoint(e.clientX, e.clientY)?.closest('.sg-item[data-kind="item"]');
		const targetId = under?.getAttribute("data-id") ?? null;
		const valid = !!targetId && targetId !== src.item.id && !wouldCycle(this.project, src.item.id, targetId);
		d.targetId = valid ? targetId : null;
		if (valid) under!.classList.add("is-link-target");
		const g = svgEl("g", { class: "sg-link-drag", "pointer-events": "none" }, svg);
		svgEl("path", {
			d: `M${connectorX(src)},${src.cy} C${connectorX(src) + 60},${src.cy} ${x - 60},${y} ${x},${y}`,
			fill: "none", stroke: this.theme.accent, "stroke-width": 2, "stroke-dasharray": "5 4",
		}, g);
		svgEl("circle", { cx: x, cy: y, r: 4, fill: this.theme.accent }, g);
		const target = valid ? this.findItem(targetId!) : undefined;
		this.showTooltip(e, target
			? [h("b", { text: "Link" }), span(`“${target.title}” starts after “${src.item.title}”`)]
			: [h("b", { text: "Link to…" }), span(targetId && targetId !== src.item.id ? "That would make a loop" : "Drop on the item that comes next", "sg-tt-hint")]);
	}

	/** Make `succId` start after `predId`, pushing it (and what follows) if needed. */
	linkItems(predId: string, succId: string) {
		if (!this.project) return;
		const pred = this.findItem(predId);
		const succ = this.findItem(succId);
		if (!pred || !succ) return;
		if (wouldCycle(this.project, predId, succId)) return this.host.notify("Can't link those: it would make a loop");
		if (succ.after?.includes(predId)) return this.host.notify(`“${succ.title}” already starts after “${pred.title}”`);
		this.snapshot();
		addLink(this.project, predId, succId);
		this.flashId = succId;
		this.commit();
		this.host.notify(`Linked: “${succ.title}” now starts after “${pred.title}”`);
		if (this.panelMode === "item") this.refreshPanel();
	}

	private buildLinksSection(form: El, item: GanttItem) {
		const p = this.project!;
		const sec = h("div", { cls: "sg-links-sec" }, form);
		h("div", { cls: "sg-label", text: "Starts after" }, sec);
		const chips = h("div", { cls: "sg-link-chips" }, sec);
		for (const pred of predecessorsOf(p, item)) {
			const chip = h("span", { cls: "sg-link-chip", kids: [icon(pred.type, 11), span(pred.title)] }, chips);
			const x = h("button", { cls: "sg-link-x", kids: [icon("x", 11)], attrs: { "aria-label": `Unlink ${pred.title}` } }, chip);
			x.addEventListener("click", () => this.mutate(() => removeLink(p, pred.id, item.id), true));
		}
		const options = p.items
			.filter((o) => o.id !== item.id && o.type !== "location" && !o.dropped && !item.after?.includes(o.id) && !wouldCycle(p, o.id, item.id))
			.sort((a, b) => a.start.localeCompare(b.start));
		if (options.length) {
			const sel = h("select", { cls: "sg-input sg-input-sm sg-link-add" }, chips);
			h("option", { text: item.after?.length ? "+ Another…" : "+ Pick what comes before…", attrs: { value: "" } }, sel);
			for (const o of options) h("option", { text: `${o.title} · ${formatDay(toDay(o.end ?? o.start), false)}`, attrs: { value: o.id } }, sel);
			sel.addEventListener("change", () => sel.value && this.linkItems(sel.value, item.id));
		}
		if ((item.type === "task" && !item.buffer) || item.type === "milestone") {
			const add = h("button", { cls: "sg-link-btn", kids: [icon("buffer", 13), "Add 2 weeks of buffer after this"] }, sec);
			add.addEventListener("click", () => this.addBufferAfter(item));
		}
		const next = successorsOf(p, item);
		if (next.length) h("div", { cls: "sg-hint", text: `Followed by ${next.map((n) => `“${n.title}”`).join(", ")}` }, sec);
		else if (!item.after?.length) h("div", { cls: "sg-hint", text: "Tip: drag the dot at the end of a bar onto another item." }, sec);
	}

	// ─── Keyboard ──────────────────────────────────────────────────────────

	private onKey(e: KeyboardEvent) {
		const inField = (e.target as Element).closest("input, textarea, select, [contenteditable]");
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key.toLowerCase() === "z" && !inField) {
			e.preventDefault();
			if (e.shiftKey) this.redo();
			else this.undo();
		} else if (mod && e.key.toLowerCase() === "y" && !inField) {
			e.preventDefault();
			this.redo();
		} else if (e.key === "Escape") {
			if (this.menu) this.closeMenu();
			else if (this.panelMode) this.closePanel();
			else this.select(null);
		} else if ((e.key === "Delete" || e.key === "Backspace") && !inField && this.selectedId) {
			e.preventDefault();
			this.deleteItem(this.selectedId);
		} else if ((e.key === "/" || e.key === "n") && !inField && !mod) {
			e.preventDefault();
			this.quickInput.focus();
		} else if (e.key === " " && !inField && this.selectedId) {
			const item = this.findItem(this.selectedId);
			if (item && isCheckable(item)) {
				e.preventDefault();
				this.toggleDone(item);
			}
		} else if (e.key.startsWith("Arrow") && !inField && !mod && this.selectedId) {
			const item = this.findItem(this.selectedId);
			if (item) {
				e.preventDefault();
				this.nudgeItem(item, e.key, e.shiftKey, e.altKey);
			}
		} else if (e.key.toLowerCase() === "f" && !inField && !mod) {
			e.preventDefault();
			this.toggleFoldAll();
		} else if (e.key === "?" && !inField) {
			e.preventDefault();
			this.openHelp(this.toolbar.querySelector('[aria-label="How to use (?)"]') as El);
		} else if (e.key.toLowerCase() === "j" && !inField && !mod) {
			e.preventDefault();
			if (this.panelMode === "journal") this.closePanel();
			else this.openJournal();
		}
	}

	// ─── Side panel ────────────────────────────────────────────────────────

	private openItemPanel(focus: PanelFocus = "title") {
		this.panelMode = "item";
		this.refreshPanel(focus);
		this.panel.classList.add("is-open");
		this.panel.setAttribute("aria-hidden", "false");
	}

	private openProjectPanel() {
		if (!this.project) return;
		this.selectedId = null;
		this.panelMode = "project";
		this.refreshPanel();
		this.panel.classList.add("is-open");
		this.panel.setAttribute("aria-hidden", "false");
		this.render();
	}

	closePanel() {
		this.panelMode = null;
		this.panel.classList.remove("is-open");
		this.panel.setAttribute("aria-hidden", "true");
	}

	private refreshPanel(focus: PanelFocus = null) {
		if (this.panelMode === "item") this.buildItemPanel(focus);
		else if (this.panelMode === "project") this.buildProjectPanel();
		else if (this.panelMode === "journal") this.buildJournalPanel();
	}

	/** Run a mutation from a panel field. One undo step per field focus. */
	private editor(field: HTMLElement, apply: () => void, live = true) {
		let snapped = false;
		field.addEventListener("focus", () => (snapped = false));
		const run = () => {
			if (!snapped) {
				this.snapshot();
				snapped = true;
			}
			apply();
			this.commit();
		};
		field.addEventListener(live ? "input" : "change", run);
	}

	private buildItemPanel(focus: PanelFocus) {
		const p = this.project;
		const item = this.selectedId ? this.findItem(this.selectedId) : undefined;
		const panel = this.panel;
		panel.replaceChildren();
		if (!p || !item) return this.closePanel();

		const head = h("div", { cls: "sg-panel-head" }, panel);
		h("span", { cls: `sg-panel-type sg-chip-${item.type}`, kids: [icon(item.type, 14)] }, head);
		h("h3", { text: `Edit ${ITEM_TYPE_LABELS[item.type].toLowerCase()}` }, head);
		const close = h("button", { cls: "sg-btn sg-icon-btn", kids: [icon("x")], attrs: { "aria-label": "Close" } }, head);
		close.addEventListener("click", () => this.select(null));

		const form = h("div", { cls: "sg-form" }, panel);
		const title = this.textField(form, "Title", item.title);
		this.editor(title, () => (item.title = title.value));
		title.addEventListener("keydown", (e) => e.key === "Enter" && title.blur());
		if (focus === "title") window.setTimeout(() => {
			title.focus();
			if (/^New /.test(item.title)) title.select();
		}, 60);

		if (item.dropped) {
			const banner = h("div", { cls: "sg-dropped-banner", kids: [icon("branch", 14), span(`Replaced by its Plan B. It stays on the chart, faded, as a record of the change.`)] }, form);
			const restore = h("button", { cls: "sg-btn", text: "Restore" }, banner);
			restore.addEventListener("click", () => {
				this.snapshot();
				delete item.dropped;
				if (item.planB?.status === "active") delete item.planB.status;
				this.commit();
				this.refreshPanel();
			});
		}
		if (isCheckable(item) && !item.dropped) this.buildDoneSection(form, item, focus === "review");

		// Type
		const typeRow = this.fieldWrap(form, "Type");
		const seg = h("div", { cls: "sg-type-seg" }, typeRow);
		for (const t of ITEM_TYPES) {
			const b = h("button", { cls: `sg-chip sg-chip-${t}${t === item.type ? " is-active" : ""}`, kids: [icon(t, 13), span(`${ITEM_TYPE_LABELS[t]}`)] }, seg);
			b.addEventListener("click", () => {
				if (t === item.type) return;
				this.snapshot();
				const wasRange = isRangeType(item.type);
				item.type = t;
				if (isRangeType(t) && !wasRange) item.end = fromDay(toDay(item.start) + 6);
				if (!isRangeType(t)) delete item.end;
				if (t !== "task") delete item.progress;
				if ((t === "task" || t === "milestone") && !item.phase) item.phase = this.defaultPhase();
				this.commit();
				this.refreshPanel();
			});
		}

		// Phase
		if (item.type !== "location") {
			const wrap = this.fieldWrap(form, item.type === "task" || item.type === "milestone" ? "Phase" : "Colour by phase");
			const sel = h("select", { cls: "sg-input" }, wrap);
			if (item.type === "event" || item.type === "deadline") h("option", { text: "None", attrs: { value: "" } }, sel);
			for (const ph of p.phases) h("option", { text: ph.name, attrs: { value: ph.id } }, sel);
			h("option", { text: "+ New phase…", attrs: { value: "__new" } }, sel);
			sel.value = item.phase ?? "";
			sel.addEventListener("change", () => {
				if (sel.value === "__new") {
					// Inline name field (Obsidian has no window.prompt).
					sel.classList.add("sg-hidden");
					const input = h("input", { cls: "sg-input", attrs: { type: "text", placeholder: "Name the new phase, then press Enter" } }, wrap);
					input.focus();
					let finished = false;
					const done = (create: boolean) => {
						if (finished) return;
						finished = true;
						const name = input.value.trim();
						if (create && name) {
							this.snapshot();
							item.phase = addPhase(p, name).id;
							this.activePhase = item.phase;
							this.commit();
						}
						this.refreshPanel();
					};
					input.addEventListener("keydown", (e) => {
						if (e.key === "Enter") done(true);
						if (e.key === "Escape") {
							e.stopPropagation();
							done(false);
						}
					});
					input.addEventListener("blur", () => done(true));
					return;
				}
				this.snapshot();
				item.phase = sel.value || undefined;
				if (item.phase) this.activePhase = item.phase;
				this.commit();
				this.refreshPanel();
			});
		}

		// Dates
		const dates = h("div", { cls: "sg-row2" }, form);
		const start = this.dateField(dates, isRangeType(item.type) ? "Start" : "Date", item.start);
		let end: HTMLInputElement | null = null;
		if (isRangeType(item.type)) end = this.dateField(dates, "End", item.end ?? item.start);
		const dur = h("div", { cls: "sg-hint" }, form);
		const syncDur = () => {
			const s = toDay(item.start);
			const e = item.end ? toDay(item.end) : s;
			dur.textContent = isRangeType(item.type) ? `${formatDuration(e - s + 1)} · ${formatRange(s, e)}` : formatDay(s);
		};
		syncDur();
		this.editor(start, () => {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(start.value)) return;
			const len = item.end ? toDay(item.end) - toDay(item.start) : 0;
			item.start = start.value;
			if (item.end) {
				// Keep the duration when the start moves, like dragging the bar.
				item.end = fromDay(toDay(start.value) + len);
				if (end) end.value = item.end;
			}
			syncDur();
		}, false);
		if (end) {
			const endEl = end;
			this.editor(endEl, () => {
				if (!/^\d{4}-\d{2}-\d{2}$/.test(endEl.value)) return;
				item.end = fromDay(Math.max(toDay(item.start), toDay(endEl.value)));
				syncDur();
			}, false);
		}

		// Progress
		if (item.type === "task") {
			const wrap = this.fieldWrap(form, "Progress");
			const row = h("div", { cls: "sg-progress-row" }, wrap);
			const range = h("input", { cls: "sg-range", attrs: { type: "range", min: "0", max: "100", step: "5" } }, row);
			range.value = String(item.progress ?? 0);
			const out = h("span", { cls: "sg-progress-val", text: `${item.progress ?? 0}%` }, row);
			this.editor(range, () => {
				item.progress = +range.value || undefined;
				out.textContent = `${range.value}%`;
			});
		}

		if (item.type === "task") {
			const row = h("label", { cls: "sg-check sg-buffer-toggle" }, form);
			const cb = h("input", { attrs: { type: "checkbox" } }, row);
			cb.checked = !!item.buffer;
			h("span", { kids: [icon("buffer", 13), "Buffer time: slack kept free to absorb delays"] }, row);
			cb.addEventListener("change", () => this.mutate(() => {
				if (cb.checked) item.buffer = true;
				else delete item.buffer;
			}, true));
		}
		if (item.type !== "location" && item.type !== "event" && !item.dropped) this.buildLinksSection(form, item);
		if (isCheckable(item) && !item.dropped && !isDone(item)) this.buildPlanBSection(form, item, focus === "planb");
		if (!isDone(item) && !item.dropped) this.buildSlipSection(form, item);

		// Note link
		const noteWrap = this.fieldWrap(form, "Linked note");
		const noteRow = h("div", { cls: "sg-note-row" }, noteWrap);
		const listId = `sg-notes-${Math.random().toString(36).slice(2)}`;
		const note = h("input", { cls: "sg-input", attrs: { type: "text", placeholder: "Link a note…", list: listId } }, noteRow);
		note.value = item.note ?? "";
		const dl = h("datalist", { attrs: { id: listId } }, noteRow);
		const fillSuggestions = () => {
			dl.replaceChildren();
			for (const s of this.host.suggestNotes?.(note.value) ?? []) h("option", { attrs: { value: s } }, dl);
		};
		note.addEventListener("focus", fillSuggestions);
		note.addEventListener("input", fillSuggestions);
		this.editor(note, () => (item.note = note.value.trim() || undefined));
		if (this.host.openNote) {
			const open = h("button", { cls: "sg-btn sg-icon-btn", kids: [icon("external")], attrs: { "aria-label": "Open note" } }, noteRow);
			open.addEventListener("click", () => item.note && this.host.openNote!(item.note));
		}

		// Description
		const descWrap = this.fieldWrap(form, "Notes");
		const desc = h("textarea", { cls: "sg-input", attrs: { rows: "3", placeholder: "Anything worth remembering…" } }, descWrap);
		desc.value = item.description ?? "";
		this.editor(desc, () => (item.description = desc.value.trim() || undefined));

		const foot = h("div", { cls: "sg-panel-foot" }, panel);
		const dup = h("button", { cls: "sg-btn", kids: [icon("copy", 14), span(`Duplicate`)] }, foot);
		dup.addEventListener("click", () => {
			this.snapshot();
			const copy: GanttItem = { ...cloneProject({ items: [item] } as unknown as Project).items[0], id: newId(), title: `${item.title} (copy)` };
			this.addItem(copy, true);
		});
		h("div", { cls: "sg-spacer" }, foot);
		const del = h("button", { cls: "sg-btn sg-danger", kids: [icon("trash", 14), span(`Delete`)] }, foot);
		del.addEventListener("click", () => this.deleteItem(item.id));
	}

	private buildProjectPanel() {
		const p = this.project;
		const panel = this.panel;
		panel.replaceChildren();
		if (!p) return this.closePanel();
		const head = h("div", { cls: "sg-panel-head" }, panel);
		h("span", { cls: "sg-panel-type", kids: [icon("settings", 14)] }, head);
		h("h3", { text: "Project" }, head);
		const close = h("button", { cls: "sg-btn sg-icon-btn", kids: [icon("x")], attrs: { "aria-label": "Close" } }, head);
		close.addEventListener("click", () => this.closePanel());

		const form = h("div", { cls: "sg-form" }, panel);
		const title = this.textField(form, "Title", p.title);
		this.editor(title, () => (p.title = title.value));
		const sub = this.textField(form, "Subtitle", p.subtitle ?? "", "e.g. your dissertation title");
		this.editor(sub, () => (p.subtitle = sub.value.trim() || undefined));
		const author = this.textField(form, "Author", p.author ?? "", "Your name");
		this.editor(author, () => (p.author = author.value.trim() || undefined));
		const dates = h("div", { cls: "sg-row2" }, form);
		const s = this.dateField(dates, "Starts", p.start);
		const e = this.dateField(dates, "Ends", p.end);
		this.editor(s, () => {
			if (/^\d{4}-\d{2}-\d{2}$/.test(s.value) && s.value <= p.end) p.start = s.value;
		}, false);
		this.editor(e, () => {
			if (/^\d{4}-\d{2}-\d{2}$/.test(e.value) && e.value >= p.start) p.end = e.value;
		}, false);

		const dens = this.fieldWrap(form, "Spacing");
		const seg = h("div", { cls: "sg-seg sg-seg-wide" }, dens);
		for (const [value, label] of [["comfortable", "Comfortable"], ["compact", "Compact"]] as const) {
			const b = h("button", { text: label, cls: (p.density ?? "comfortable") === value ? "is-active" : "" }, seg);
			b.addEventListener("click", () => this.mutate(() => {
				if (value === "compact") p.density = "compact";
				else delete p.density;
			}, true));
		}

		h("div", { cls: "sg-section-title", text: "Phases" }, form);
		const list = h("div", { cls: "sg-phase-list" }, form);
		p.phases.forEach((ph, i) => {
			const row = h("div", { cls: "sg-phase-row" }, list);
			const sw = h("button", { cls: "sg-swatch", attrs: { "aria-label": "Change colour" } }, row);
			sw.setCssProps({ "--sg-swatch": this.theme.palette[ph.color] });
			sw.addEventListener("click", () => this.openColorMenu(sw, ph.color, (c) => {
				this.snapshot();
				ph.color = c;
				this.commit();
				this.refreshPanel();
			}));
			const name = h("input", { cls: "sg-input", attrs: { type: "text" } }, row);
			name.value = ph.name;
			this.editor(name, () => (ph.name = name.value));
			const count = p.items.filter((it) => it.phase === ph.id).length;
			h("span", { cls: "sg-phase-count", text: String(count), attrs: { title: `${count} items` } }, row);
			const up = h("button", { cls: "sg-btn sg-icon-btn sg-mini", kids: [icon("up", 14)], attrs: { "aria-label": "Move up" } }, row);
			const down = h("button", { cls: "sg-btn sg-icon-btn sg-mini", kids: [icon("down", 14)], attrs: { "aria-label": "Move down" } }, row);
			const del = h("button", { cls: "sg-btn sg-icon-btn sg-mini", kids: [icon("trash", 14)], attrs: { "aria-label": "Delete phase" } }, row);
			up.toggleAttribute("disabled", i === 0);
			down.toggleAttribute("disabled", i === p.phases.length - 1);
			const move = (dir: number) => {
				this.snapshot();
				const [x] = p.phases.splice(i, 1);
				p.phases.splice(i + dir, 0, x);
				this.commit();
				this.refreshPanel();
			};
			up.addEventListener("click", () => move(-1));
			down.addEventListener("click", () => move(1));
			del.addEventListener("click", () => {
				this.snapshot();
				p.phases.splice(i, 1);
				this.commit();
				this.refreshPanel();
				if (count) this.host.notify(`Deleted phase “${ph.name}” — its ${count} items moved to “Other”. Ctrl+Z to undo.`);
			});
		});
		const add = h("button", { cls: "sg-btn sg-add-phase", kids: [icon("plus", 14), span(`Add phase`)] }, form);
		add.addEventListener("click", () => {
			this.snapshot();
			addPhase(p, `Phase ${p.phases.length + 1}`);
			this.commit();
			this.refreshPanel();
			const inputs = this.panel.querySelectorAll<HTMLInputElement>(".sg-phase-row .sg-input");
			const last = inputs[inputs.length - 1];
			last?.focus();
			last?.select();
		});

		h("div", { cls: "sg-section-title", text: "Quick add tips" }, form);
		h("div", {
			cls: "sg-tips",
			kids: [
				["Literature review Jan–Mar #lit", "task in a phase"],
				["!Ethics form 15 Feb", "deadline"],
				["*Chapter 2 done 20 Jan", "milestone"],
				["+Supervisor meeting 3 Dec", "key date"],
				["@Fieldwork Lisbon Feb–Apr", "location"],
				["Pilot 18 Jan for 4 weeks 30%", "duration & progress"],
				["> Good meeting today", "journal note"],
			].map(([code, what]) => h("div", { kids: [h("code", { text: code }), span(what)] })),
		}, form);
	}

	// ─── Done & "how did it go?" ───────────────────────────────────────────

	/** "3 days early 🎉", "right on time", "5 days late" — relative to the planned date. */
	private timingText(item: GanttItem): string {
		if (!item.doneOn) return item.type === "task" ? "Finished" : "Reached";
		const actual = toDay(item.doneOn);
		const diff = actual - toDay(item.end ?? item.start);
		const when = `${item.type === "task" ? "Finished" : item.type === "deadline" ? "Met" : "Reached"} ${formatDay(actual)}`;
		if (diff === 0) return `${when} · right on time ✨`;
		if (diff < 0) return `${when} · ${-diff} day${diff === -1 ? "" : "s"} early 🎉`;
		return `${when} · ${diff} day${diff === 1 ? "" : "s"} later than planned`;
	}

	toggleDone(item: GanttItem) {
		if (!this.project || !isCheckable(item)) return;
		this.snapshot();
		if (!isDone(item)) {
			item.done = true;
			item.doneOn = this.host.today();
			if (item.type === "task") item.progress = 100;
			this.commit();
			this.celebrate(item);
			this.select(item.id, true, "review");
		} else {
			delete item.done;
			delete item.doneOn;
			if (item.type === "task" && (item.progress ?? 0) >= 100) item.progress = 90;
			this.commit();
			if (this.panelMode === "item") this.refreshPanel();
		}
	}

	private celebrate(item: GanttItem) {
		const p = this.layout?.placed.find((x) => x.item.id === item.id);
		const root = this.root.getBoundingClientRect();
		const body = this.bodyWrap.getBoundingClientRect();
		let x = root.width / 2, y = root.height / 2;
		if (p) {
			const px = body.left - root.left + (item.type === "task" ? p.x1 : (p.x0 + p.x1) / 2);
			const py = body.top - root.top + p.cy;
			if (px > 0 && px < root.width && py > 0 && py < root.height) [x, y] = [px, py];
		}
		const phase = this.project?.phases.find((ph) => ph.id === item.phase);
		const phaseDone = !!phase && this.project!.items.filter((i) => i.phase === phase.id && !i.dropped && isCheckable(i)).every(isDone);
		const colors = phase ? [this.theme.palette[phase.color], ...Object.values(this.theme.palette)] : Object.values(this.theme.palette);
		confetti(this.root, x, y, colors, item.type !== "task" || phaseDone);
		if (phase && phaseDone) this.host.notify(`🎉 Every item in “${phase.name}” is done!`);
	}

	private buildDoneSection(form: El, item: GanttItem, focusReview: boolean) {
		const done = isDone(item);
		const box = h("div", { cls: `sg-done${done ? " is-done" : ""}` }, form);
		const btn = h("button", {
			cls: "sg-done-check", kids: [icon("check", 16)],
			attrs: { role: "checkbox", "aria-checked": String(done), "aria-label": done ? "Mark as not done" : "Mark as done" },
		}, box);
		const txt = h("div", { cls: "sg-done-text" }, box);
		const verb = item.type === "task" ? "finished" : item.type === "deadline" ? "met" : "reached";
		h("strong", { text: done ? verb[0].toUpperCase() + verb.slice(1) : `Mark as ${verb}` }, txt);
		h("span", { text: done ? this.timingText(item) : "Tick it off when it's done · Space" }, txt);
		btn.addEventListener("click", () => this.toggleDone(item));
		if (!done) return;

		const card = h("div", { cls: `sg-review${focusReview ? " is-fresh" : ""}` }, form);
		h("div", { cls: "sg-review-title", kids: [icon("sparkle", 14), span(`How did it go?`)] }, card);
		const moods = h("div", { cls: "sg-moods" }, card);
		const review = (item.review ??= {});
		for (const m of MOODS) {
			const b = h("button", { cls: `sg-mood${review.mood === m.value ? " is-active" : ""}`, text: m.face, attrs: { "aria-label": m.label, title: m.label } }, moods);
			b.addEventListener("click", () => {
				this.snapshot();
				review.mood = review.mood === m.value ? undefined : m.value;
				moods.querySelectorAll(".sg-mood").forEach((el, i) => el.classList.toggle("is-active", review.mood === i + 1));
				this.commit();
			});
		}
		const ta = h("textarea", { cls: "sg-input", attrs: { rows: "3", placeholder: prompt(hash(item.id), REVIEW_PROMPTS) } }, card);
		ta.value = review.text ?? "";
		this.editor(ta, () => (review.text = ta.value.trim() || undefined));
		const row = h("div", { cls: "sg-review-row" }, card);
		h("span", { cls: "sg-label", text: "Finished on" }, row);
		const date = h("input", { cls: "sg-input sg-input-sm", attrs: { type: "date" } }, row);
		date.value = item.doneOn ?? this.host.today();
		this.editor(date, () => {
			if (/^\d{4}-\d{2}-\d{2}$/.test(date.value)) item.doneOn = date.value;
		}, false);
		if (focusReview) window.setTimeout(() => ta.focus(), 120);
	}

	// ─── Plan B ────────────────────────────────────────────────────────────

	private buildPlanBSection(form: El, item: GanttItem, focus: boolean) {
		const sec = h("div", { cls: "sg-planb" }, form);
		if (!item.planB) {
			const add = h("button", {
				cls: "sg-planb-add",
				kids: [icon("branch", 16), h("span", { kids: [h("strong", { text: "Add a Plan B" }), h("small", { text: "What happens if this doesn't work out?" })] })],
			}, sec);
			add.addEventListener("click", () => {
				this.snapshot();
				item.planB = { by: item.end ?? item.start, title: "" };
				this.commit();
				this.refreshPanel("planb");
			});
			return;
		}
		const pb = item.planB;
		const today = toDay(this.host.today());
		const due = !pb.status && toDay(pb.by) <= today;
		sec.classList.add("has-plan");
		if (due) sec.classList.add("is-due");
		const head = h("div", { cls: "sg-planb-head" }, sec);
		h("span", { cls: "sg-planb-icon", kids: [icon("branch", 14)] }, head);
		h("strong", { text: "Plan B" }, head);
		const status = pb.status === "dismissed" ? "Not needed" : due ? "Decision due" : `Decide in ${toDay(pb.by) - today} days`;
		h("span", { cls: `sg-pill${due ? " is-warn" : ""}`, text: status }, head);

		const ifRow = this.fieldWrap(sec, "If this isn't done by");
		const by = h("input", { cls: "sg-input", attrs: { type: "date" } }, ifRow);
		by.value = pb.by;
		this.editor(by, () => {
			if (/^\d{4}-\d{2}-\d{2}$/.test(by.value)) pb.by = by.value;
		}, false);
		const thenRow = this.fieldWrap(sec, "…then I'll");
		const title = h("input", { cls: "sg-input", attrs: { type: "text", placeholder: "e.g. use a public dataset instead" } }, thenRow);
		title.value = pb.title;
		this.editor(title, () => (pb.title = title.value));
		if (focus) window.setTimeout(() => (pb.title ? by : title).focus(), 120);

		const dates = h("div", { cls: "sg-row2" }, sec);
		const ps = h("input", { cls: "sg-input", attrs: { type: "date" } }, this.fieldWrap(dates, "Plan B from (optional)"));
		const pe = h("input", { cls: "sg-input", attrs: { type: "date" } }, this.fieldWrap(dates, "until"));
		ps.value = pb.start ?? "";
		pe.value = pb.end ?? "";
		this.editor(ps, () => {
			if (!ps.value) {
				delete pb.start;
				delete pb.end;
				pe.value = "";
				return;
			}
			const len = pb.start && pb.end ? toDay(pb.end) - toDay(pb.start) : 13;
			pb.start = ps.value;
			pb.end = fromDay(toDay(ps.value) + len);
			pe.value = pb.end;
		}, false);
		this.editor(pe, () => {
			if (pb.start && pe.value) pb.end = fromDay(Math.max(toDay(pb.start), toDay(pe.value)));
		}, false);
		const note = h("textarea", { cls: "sg-input", attrs: { rows: "2", placeholder: "What would it take? Who to ask?" } }, this.fieldWrap(sec, "Notes"));
		note.value = pb.note ?? "";
		this.editor(note, () => (pb.note = note.value.trim() || undefined));

		const actions = h("div", { cls: "sg-planb-actions" }, sec);
		if (pb.status === "dismissed") {
			const rearm = h("button", { cls: "sg-btn", text: "Keep it as a backup again" }, actions);
			rearm.addEventListener("click", () => this.mutate(() => delete pb.status, true));
		} else {
			const sw = h("button", { cls: "sg-btn sg-primary", kids: [icon("branch", 14), span(`Switch to Plan B`)] }, actions);
			sw.addEventListener("click", () => this.switchToPlanB(item));
			if (due) {
				const snooze = h("button", { cls: "sg-btn", text: "Still on track · ask in 2 weeks" }, actions);
				snooze.addEventListener("click", () => this.snoozeDecision(item));
			}
		}
		h("div", { cls: "sg-spacer" }, actions);
		const rm = h("button", { cls: "sg-btn sg-icon-btn", kids: [icon("trash", 14)], attrs: { "aria-label": "Remove Plan B" } }, actions);
		rm.addEventListener("click", () => this.mutate(() => delete item.planB, true));
	}

	/** Snapshot, apply, save; optionally rebuild the panel. */
	private mutate(fn: () => void, refresh = false) {
		this.snapshot();
		fn();
		this.commit();
		if (refresh) this.refreshPanel();
	}

	switchToPlanB(item: GanttItem) {
		const pb = item.planB;
		if (!pb || !this.project) return;
		this.snapshot();
		pb.status = "active";
		item.dropped = true;
		const today = toDay(this.host.today());
		const start = pb.start ? toDay(pb.start) : Math.max(today, toDay(pb.by));
		const length = pb.start ? toDay(pb.end ?? pb.start) - start : item.end ? toDay(item.end) - toDay(item.start) : 0;
		const alt: GanttItem = { id: newId(), type: item.type, title: pb.title || `Plan B for ${item.title}`, start: fromDay(start), phase: item.phase };
		if (isRangeType(alt.type)) alt.end = fromDay(start + Math.max(0, length));
		if (pb.note) alt.description = pb.note;
		this.addItem(alt, false);
		this.select(alt.id, true, null);
		this.host.notify(`Switched to Plan B: “${alt.title}”. The original stays on the chart, faded.`);
	}

	snoozeDecision(item: GanttItem, days = 14) {
		const pb = item.planB;
		if (!pb) return;
		this.mutate(() => (pb.by = fromDay(Math.max(toDay(pb.by), toDay(this.host.today())) + days)), this.panelMode === "item");
		this.host.notify(`Okay! I'll ask again on ${formatDay(toDay(pb.by))}.`);
	}

	// ─── When things slip ──────────────────────────────────────────────────

	private buildSlipSection(form: El, item: GanttItem) {
		const sec = h("div", { cls: "sg-slip" }, form);
		h("div", { cls: "sg-label", text: "Running late? Push this and everything after it" }, sec);
		const row = h("div", { cls: "sg-slip-row" }, sec);
		let samePhase = false;
		for (const [label, days] of [["+1 week", 7], ["+2 weeks", 14], ["+1 month", 30], ["−1 week", -7]] as const) {
			const b = h("button", { cls: "sg-chip sg-slip-chip", text: label }, row);
			b.addEventListener("click", () => {
				if (!this.project) return;
				this.snapshot();
				const n = rippleShift(this.project, item, days, samePhase);
				this.commit();
				this.refreshPanel();
				this.host.notify(`Moved ${n} item${n === 1 ? "" : "s"} ${days > 0 ? "later" : "earlier"} by ${Math.abs(days)} days`);
			});
		}
		if (item.phase) {
			const only = h("label", { cls: "sg-check" }, sec);
			const cb = h("input", { attrs: { type: "checkbox" } }, only);
			h("span", { text: "Only this phase" }, only);
			cb.addEventListener("change", () => (samePhase = cb.checked));
		}
		h("div", { cls: "sg-hint", text: "Tip: hold Shift while dragging a bar to do the same thing by hand." }, sec);
	}

	// ─── Journal ───────────────────────────────────────────────────────────

	openJournal(opts: { date?: string; entryId?: string } = {}) {
		if (!this.project) return;
		this.selectedId = null;
		this.panelMode = "journal";
		const entry = opts.entryId ? this.project.journal?.find((e) => e.id === opts.entryId) : undefined;
		this.journalFocusId = entry?.id ?? null;
		if (!this.draft || opts.date) this.draft = { date: opts.date ?? this.host.today(), text: "" };
		this.refreshPanel();
		this.panel.classList.add("is-open");
		this.panel.setAttribute("aria-hidden", "false");
		this.render();
		window.setTimeout(() => {
			if (entry) this.panel.querySelector(`[data-entry="${entry.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
			else this.panel.querySelector<HTMLTextAreaElement>(".sg-composer textarea")?.focus();
		}, 80);
	}

	private buildJournalPanel() {
		const p = this.project;
		const panel = this.panel;
		panel.replaceChildren();
		if (!p) return this.closePanel();
		const draft = (this.draft ??= { date: this.host.today(), text: "" });
		const today = toDay(this.host.today());

		const head = h("div", { cls: "sg-panel-head" }, panel);
		h("span", { cls: "sg-panel-type", kids: [icon("book", 14)] }, head);
		h("h3", { text: "Journal" }, head);
		const close = h("button", { cls: "sg-btn sg-icon-btn", kids: [icon("x")], attrs: { "aria-label": "Close" } }, head);
		close.addEventListener("click", () => this.closePanel());

		const form = h("div", { cls: "sg-form" }, panel);

		// Composer
		const comp = h("div", { cls: `sg-composer${draft.editingId ? " is-editing" : ""}` }, form);
		const top = h("div", { cls: "sg-composer-top" }, comp);
		const date = h("input", { cls: "sg-input sg-input-sm", attrs: { type: "date", "aria-label": "Date" } }, top);
		date.value = draft.date;
		date.addEventListener("change", () => /^\d{4}-\d{2}-\d{2}$/.test(date.value) && (draft.date = date.value));
		const moods = h("div", { cls: "sg-moods sg-moods-sm" }, top);
		for (const m of MOODS) {
			const b = h("button", { cls: `sg-mood${draft.mood === m.value ? " is-active" : ""}`, text: m.face, attrs: { title: m.label, "aria-label": m.label } }, moods);
			b.addEventListener("click", () => {
				draft.mood = draft.mood === m.value ? undefined : m.value;
				moods.querySelectorAll(".sg-mood").forEach((el, i) => el.classList.toggle("is-active", draft.mood === i + 1));
			});
		}
		const n = p.journal?.length ?? 0;
		const ta = h("textarea", { cls: "sg-composer-text", attrs: { rows: "4", placeholder: prompt(n + today, PROMPTS) } }, comp);
		ta.value = draft.text;
		ta.addEventListener("input", () => (draft.text = ta.value));
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.saveJournal();
			}
		});
		const foot = h("div", { cls: "sg-composer-foot" }, comp);
		const shuffle = h("button", { cls: "sg-link", text: "Another prompt" }, foot);
		let k = 1;
		shuffle.addEventListener("click", () => (ta.placeholder = prompt(n + today + k++, PROMPTS)));
		h("span", { cls: "sg-hint-inline", text: "Ctrl+Enter" }, foot);
		if (draft.editingId) {
			const cancel = h("button", { cls: "sg-btn", text: "Cancel" }, foot);
			cancel.addEventListener("click", () => {
				this.draft = { date: this.host.today(), text: "" };
				this.refreshPanel();
			});
		}
		const save = h("button", { cls: "sg-btn sg-primary", text: draft.editingId ? "Update" : "Save entry" }, foot);
		save.addEventListener("click", () => this.saveJournal());

		// Check-in rhythm
		const rhythm = h("div", { cls: "sg-rhythm" }, form);
		const label = h("div", { cls: "sg-rhythm-text" }, rhythm);
		h("strong", { text: "Check-in reminders" }, label);
		const slots = slotStates(p, today);
		const due = slots.find((sl) => sl.state === "due");
		const nextSlot = slots.find((sl) => sl.state === "future");
		const streak = this.streak(slots, today);
		h("span", {
			text: !p.checkin ? "Off: turn on for a gentle nudge" :
				due ? "A check-in is due now ✍️" :
				nextSlot ? `Next one ${formatDay(nextSlot.day, false)}${streak > 1 ? ` · 🔥 ${streak} in a row` : ""}` : "All done for this project",
		}, label);
		const sel = h("select", { cls: "sg-input sg-input-sm" }, rhythm);
		h("option", { text: "Off", attrs: { value: "" } }, sel);
		for (const [v, l] of Object.entries(CHECKIN_LABELS)) h("option", { text: l, attrs: { value: v } }, sel);
		sel.value = p.checkin ?? "";
		sel.addEventListener("change", () => this.mutate(() => {
			if (sel.value) p.checkin = sel.value as CheckIn;
			else delete p.checkin;
		}, true));

		// Feed: journal entries and "how did it go?" reviews, newest first, grouped by month.
		type Row = { date: string; kind: "entry" | "review"; id: string; mood?: Mood; text: string; title?: string };
		const rows: Row[] = [
			...(p.journal ?? []).map((e) => ({ date: e.date, kind: "entry" as const, id: e.id, mood: e.mood, text: e.text })),
			...p.items.filter((i) => isDone(i) && i.doneOn).map((i) => ({
				date: i.doneOn!, kind: "review" as const, id: i.id, mood: i.review?.mood, text: i.review?.text ?? "", title: i.title,
			})),
		].sort((a, b) => b.date.localeCompare(a.date));
		const feed = h("div", { cls: "sg-feed" }, form);
		if (!rows.length) {
			h("div", { cls: "sg-feed-empty", kids: [icon("book", 22), span(`Your project story starts here. Write a few lines after a meeting, a good day or a bad one. Finished items and how they went show up here too.`)] }, feed);
		}
		let month = "";
		for (const r of rows) {
			const [y, m] = ymd(toDay(r.date));
			const key = `${MONTHS_LONG[m]} ${y}`;
			if (key !== month) {
				month = key;
				h("div", { cls: "sg-feed-month", text: key }, feed);
			}
			const card = h("div", { cls: `sg-feed-card sg-feed-${r.kind}${r.id === this.journalFocusId ? " is-focus" : ""}`, attrs: { "data-entry": r.id } }, feed);
			if (r.mood) card.setCssProps({ "--sg-mood": MOOD_COLORS[r.mood] });
			const meta = h("div", { cls: "sg-feed-meta" }, card);
			h("span", { cls: "sg-feed-date", text: formatDay(toDay(r.date), false) }, meta);
			if (r.mood) h("span", { cls: "sg-feed-mood", text: MOODS[r.mood - 1].face, attrs: { title: MOODS[r.mood - 1].label } }, meta);
			if (r.kind === "review") h("span", { cls: "sg-feed-tag", kids: [icon("check", 11), `${r.title!}`] }, meta);
			h("div", { cls: "sg-feed-text", text: r.text || (r.kind === "review" ? "Ticked off" : "") }, card);
			card.addEventListener("click", () => {
				if (r.kind === "review") return this.select(r.id, true, "review");
				const e = p.journal!.find((x) => x.id === r.id)!;
				this.draft = { date: e.date, mood: e.mood, text: e.text, editingId: e.id };
				this.refreshPanel();
				this.panel.querySelector<HTMLTextAreaElement>(".sg-composer textarea")?.focus();
			});
			if (r.kind === "entry") {
				const del = h("button", { cls: "sg-feed-del", kids: [icon("trash", 13)], attrs: { "aria-label": "Delete entry" } }, card);
				del.addEventListener("click", (ev) => {
					ev.stopPropagation();
					this.mutate(() => (p.journal = p.journal!.filter((x) => x.id !== r.id)), true);
					this.host.notify("Entry deleted. Ctrl+Z to undo");
				});
			}
		}

		const pfoot = h("div", { cls: "sg-panel-foot" }, panel);
		const copy = h("button", { cls: "sg-btn", kids: [icon("note", 14), span(`Save as note`)] }, pfoot);
		copy.addEventListener("click", () => void this.exportJournal());
		h("div", { cls: "sg-spacer" }, pfoot);
		h("span", { cls: "sg-hint-inline", text: `${rows.length} entr${rows.length === 1 ? "y" : "ies"}` }, pfoot);
	}

	/** Consecutive written check-ins, counting back from the latest one that has started. */
	private streak(slots: ReturnType<typeof slotStates>, today: number): number {
		let n = 0;
		for (let i = slots.length - 1; i >= 0; i--) {
			const sl = slots[i];
			if (sl.day > today) continue;
			if (sl.state === "due" && n === 0) continue;
			if (sl.state !== "done") break;
			n++;
		}
		return n;
	}

	private saveJournal() {
		const p = this.project;
		const d = this.draft;
		if (!p || !d || (!d.text.trim() && !d.mood)) return;
		const before = p.checkin ? slotStates(p, toDay(this.host.today())).some((sl) => sl.state === "due") : false;
		this.snapshot();
		const journal = (p.journal ??= []);
		const existing = d.editingId ? journal.find((e) => e.id === d.editingId) : undefined;
		const id = existing?.id ?? newId();
		const entry = { id, date: d.date, text: d.text.trim(), ...(d.mood ? { mood: d.mood } : {}) };
		if (existing) Object.assign(existing, entry, d.mood ? {} : { mood: undefined });
		else journal.push(entry);
		this.journalFocusId = id;
		this.draft = { date: this.host.today(), text: "" };
		this.commit();
		this.refreshPanel();
		const after = p.checkin ? slotStates(p, toDay(this.host.today())).some((sl) => sl.state === "due") : false;
		if (before && !after) this.host.notify(`Check-in done ✓ See you ${p.checkin === "weekly" ? "next week" : p.checkin === "fortnightly" ? "in two weeks" : "next month"}.`);
	}

	private async exportJournal() {
		const p = this.project;
		if (!p) return;
		const lines = [`# ${p.title}: journal`, ""];
		const rows = [
			...(p.journal ?? []).map((e) => ({ date: e.date, head: formatDay(toDay(e.date)), mood: e.mood, text: e.text })),
			...p.items.filter((i) => isDone(i) && i.doneOn).map((i) => ({
				date: i.doneOn!, head: `✓ ${i.title} (${this.timingText(i).toLowerCase()})`, mood: i.review?.mood, text: i.review?.text ?? "",
			})),
		].sort((a, b) => a.date.localeCompare(b.date));
		let month = "";
		for (const r of rows) {
			const [y, m] = ymd(toDay(r.date));
			const key = `${MONTHS_LONG[m]} ${y}`;
			if (key !== month) lines.push(`## ${(month = key)}`, "");
			lines.push(`### ${r.head}${r.mood ? ` ${MOODS[r.mood - 1].face}` : ""}`, "");
			if (r.text) lines.push(r.text, "");
		}
		const base = (p.title || "timeline").replace(/[\\/:*?"<>|]+/g, "").trim() || "timeline";
		await this.host.exportFile(`${base} journal.md`, lines.join("\n"));
	}

	// ─── Toolbar stats & nudges ────────────────────────────────────────────

	private renderStats() {
		const p = this.project;
		this.stats.replaceChildren();
		if (!p) return;
		const pct = overallProgress(p);
		const r = 9, c = 2 * Math.PI * r;
		const ring = h("div", { cls: "sg-ring", attrs: { title: `${pct}% of the plan done` } }, this.stats);
		const svg = svgEl("svg", { width: 24, height: 24, viewBox: "0 0 24 24" });
		svgEl("circle", { cx: 12, cy: 12, r, fill: "none", stroke: "var(--background-modifier-border)", "stroke-width": 3 }, svg);
		svgEl("circle", {
			cx: 12, cy: 12, r, fill: "none", stroke: "var(--interactive-accent)", "stroke-width": 3, "stroke-linecap": "round",
			"stroke-dasharray": `${(c * pct) / 100} ${c}`, transform: "rotate(-90 12 12)",
		}, svg);
		append(ring, [svg, span(`${pct}%`)]);
		const next = nextDeadline(p, toDay(this.host.today()));
		if (next) {
			const chip = h("button", {
				cls: `sg-countdown${next.days <= 14 ? " is-soon" : ""}`,
				kids: [icon("deadline", 13), span(next.item.title), h("b", { text: next.days === 0 ? "today" : next.days === 1 ? "tomorrow" : `${next.days} days` })],
				attrs: { title: `Next deadline: ${formatDay(toDay(next.item.start))}` },
			}, this.stats);
			chip.addEventListener("click", () => {
				this.select(next.item.id);
				this.revealItem(next.item.id);
			});
		}
	}

	private renderNudges() {
		const bar = this.nudgeBar;
		const p = this.project;
		const list = p ? computeNudges(p, toDay(this.host.today())).filter((n) => !this.dismissedNudges.has(n.key)) : [];
		const key = list.map((n) => n.key).join("|") + `#${this.nudgeIndex}`;
		if (bar.dataset.key === key) return;
		bar.dataset.key = key;
		bar.replaceChildren();
		bar.classList.toggle("is-visible", list.length > 0);
		if (!list.length || !p) return;
		this.nudgeIndex = Math.min(this.nudgeIndex, list.length - 1);
		const n = list[this.nudgeIndex];
		const card = h("div", { cls: `sg-nudge sg-nudge-${n.kind}` }, bar);
		const iconName = n.kind === "conflict" ? "deadline" : n.kind === "decision" ? "branch" : n.kind === "checkin" ? "book" : n.kind === "reached" ? "party" : "deadline";
		h("span", { cls: "sg-nudge-icon", kids: [icon(iconName, 16)] }, card);
		const text = h("div", { cls: "sg-nudge-text" }, card);
		const actions = h("div", { cls: "sg-nudge-actions" }, card);
		const act = (label: Kid[], fn: () => void, primary = false) => {
			const b = h("button", { cls: `sg-btn${primary ? " sg-primary" : ""}`, kids: label }, actions);
			b.addEventListener("click", fn);
		};
		this.fillNudge(n, text, act, actions);
		if (list.length > 1) {
			const pager = h("div", { cls: "sg-pager" }, card);
			const prev = h("button", { cls: "sg-btn sg-icon-btn sg-mini", kids: [icon("chevronLeft", 14)], attrs: { "aria-label": "Previous" } }, pager);
			h("span", { text: `${this.nudgeIndex + 1}/${list.length}` }, pager);
			const nextB = h("button", { cls: "sg-btn sg-icon-btn sg-mini", kids: [icon("chevronRight", 14)], attrs: { "aria-label": "Next" } }, pager);
			prev.addEventListener("click", () => {
				this.nudgeIndex = (this.nudgeIndex - 1 + list.length) % list.length;
				this.renderNudges();
			});
			nextB.addEventListener("click", () => {
				this.nudgeIndex = (this.nudgeIndex + 1) % list.length;
				this.renderNudges();
			});
		}
		const x = h("button", { cls: "sg-btn sg-icon-btn sg-mini", kids: [icon("x", 14)], attrs: { "aria-label": "Dismiss" } }, card);
		x.addEventListener("click", () => {
			this.dismissedNudges.add(n.key);
			this.renderNudges();
		});
	}

	private fillNudge(n: Nudge, text: El, act: (label: Kid[], fn: () => void, primary?: boolean) => void, actions: El) {
		const t = (strong: string, rest: string) => {
			h("strong", { text: strong }, text);
			h("span", { text: rest }, text);
		};
		if (n.kind === "decision") {
			const pb = n.item.planB!;
			t("Decision time", `“${n.item.title}” isn't done and its Plan B date (${formatDay(toDay(pb.by), false)}) has arrived.`);
			act([icon("branch", 14), span(`Switch to: ${pb.title || "Plan B"}`)], () => this.switchToPlanB(n.item), true);
			act(["Still on track"], () => this.snoozeDecision(n.item));
		} else if (n.kind === "checkin") {
			const p = this.project!;
			t(`Time for your ${p.checkin === "weekly" ? "weekly" : p.checkin === "fortnightly" ? "fortnightly" : "monthly"} check-in`, "How's it going?");
			for (const m of MOODS) {
				const b = h("button", { cls: "sg-mood", text: m.face, attrs: { title: m.label, "aria-label": m.label } }, actions);
				b.addEventListener("click", () => {
					this.draft = { date: this.host.today(), text: "", mood: m.value };
					this.openJournal();
				});
			}
		} else if (n.kind === "reached") {
			const what = n.item.type === "task" ? "finish" : n.item.type === "deadline" ? "make" : "reach";
			t(`Did you ${what} “${n.item.title}”?`, `It was planned ${n.daysAgo === 1 ? "yesterday" : `${n.daysAgo} days ago`}.`);
			act([icon("check", 14), span("Yes!")], () => this.toggleDone(n.item), true);
			act(["Not yet, move it"], () => this.select(n.item.id, true, n.item.planB ? "planb" : "title"));
		} else if (n.kind === "conflict") {
			t("Running into a deadline", `“${n.pred.title}” now ends after “${n.item.title}” (${formatDay(toDay(n.item.start), false)}).`);
			act(["Show"], () => {
				this.select(n.pred.id, true);
				this.revealItem(n.pred.id);
			}, true);
		} else {
			t(`“${n.item.title}”`, n.days === 0 ? "is due today." : `is due in ${n.days} day${n.days === 1 ? "" : "s"} (${formatDay(toDay(n.item.start), false)}).`);
			act(["Show"], () => {
				this.select(n.item.id, true);
				this.revealItem(n.item.id);
			});
		}
	}

	/** Reset every item's dates and phase to a snapshot (used while dragging). */
	private restoreFrom(snapshot: Project) {
		if (!this.project) return;
		const byId = new Map(snapshot.items.map((i) => [i.id, i]));
		for (const it of this.project.items) {
			const o = byId.get(it.id);
			if (!o) continue;
			it.start = o.start;
			it.end = o.end;
			it.phase = o.phase;
			if (o.planB && it.planB) {
				it.planB.by = o.planB.by;
				it.planB.start = o.planB.start;
				it.planB.end = o.planB.end;
			}
		}
	}

	private fieldWrap(parent: El, label: string): El {
		const wrap = h("label", { cls: "sg-field" }, parent);
		h("span", { cls: "sg-label", text: label }, wrap);
		return wrap;
	}

	private textField(parent: El, label: string, value: string, placeholder = ""): HTMLInputElement {
		const input = h("input", { cls: "sg-input", attrs: { type: "text", placeholder } }, this.fieldWrap(parent, label));
		input.value = value;
		return input;
	}

	private dateField(parent: El, label: string, value: string): HTMLInputElement {
		const input = h("input", { cls: "sg-input", attrs: { type: "date" } }, this.fieldWrap(parent, label));
		input.value = value;
		return input;
	}

	// ─── Menus ─────────────────────────────────────────────────────────────

	private popMenu(anchor: El, build: (menu: El) => void): El {
		this.closeMenu();
		const menu = h("div", { cls: "sg-menu" }, this.root);
		build(menu);
		const r = anchor.getBoundingClientRect();
		const root = this.root.getBoundingClientRect();
		const left = Math.min(r.left - root.left, root.width - menu.offsetWidth - 8);
		menu.setCssProps({ "--sg-menu-x": `${Math.max(8, left)}px`, "--sg-menu-y": `${r.bottom - root.top + 6}px` });
		this.menu = menu;
		return menu;
	}

	private closeMenu() {
		this.menu?.remove();
		this.menu = null;
	}

	private menuItem(menu: El, kids: Kid[], onClick: () => void, cls = "") {
		const b = h("button", { cls: `sg-menu-item ${cls}`, kids }, menu);
		b.addEventListener("click", () => {
			this.closeMenu();
			onClick();
		});
	}

	private openProjectMenu() {
		this.popMenu(this.titleBtn, (menu) => {
			const projects = this.host.listProjects();
			if (projects.length) h("div", { cls: "sg-menu-label", text: "Projects" }, menu);
			for (const pr of projects)
				this.menuItem(menu, [icon("gantt", 14), span(pr.title)], () => this.host.switchProject(pr.id), pr.id === this.projectId ? "is-active" : "");
			h("div", { cls: "sg-menu-sep" }, menu);
			for (const t of TEMPLATES) this.menuItem(menu, [icon("plus", 14), span(`New: ${t.name}`)], () => this.host.createProject(t.id));
		});
	}

	private openExportMenu(anchor: El) {
		this.popMenu(anchor, (menu) => {
			h("div", { cls: "sg-menu-label", text: "Export for print & reports" }, menu);
			const label = (main: string, note: string) => h("span", { kids: [`${main} `, h("small", { text: note })] });
			this.menuItem(menu, [icon("download", 14), label("PNG image", "high resolution")], () => void this.exportAs("png"));
			this.menuItem(menu, [icon("download", 14), label("SVG", "vector, for Word / LaTeX")], () => void this.exportAs("svg"));
		});
	}

	private openColorMenu(anchor: El, current: ColorName, onPick: (c: ColorName) => void) {
		this.popMenu(anchor, (menu) => {
			menu.classList.add("sg-color-menu");
			for (const c of COLOR_ORDER) {
				const b = h("button", { cls: `sg-swatch${c === current ? " is-active" : ""}`, attrs: { "aria-label": c } }, menu);
				b.setCssProps({ "--sg-swatch": this.theme.palette[c] });
				b.addEventListener("click", () => {
					this.closeMenu();
					onPick(c);
				});
			}
		});
	}

	async exportAs(kind: "png" | "svg") {
		if (!this.project) return;
		const svg = renderExportSvg(this.project, { today: toDay(this.host.today()) });
		const base = (this.project.title || "timeline").replace(/[\\/:*?"<>|]+/g, "").trim() || "timeline";
		try {
			if (kind === "svg") await this.host.exportFile(`${base}.svg`, svgToString(svg));
			else await this.host.exportFile(`${base}.png`, await svgToPng(svg, 2));
		} catch (err) {
			this.host.notify(`Export failed: ${(err as Error).message}`);
		}
	}
}

function hash(s: string): number {
	let x = 0;
	for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
	return Math.abs(x);
}
