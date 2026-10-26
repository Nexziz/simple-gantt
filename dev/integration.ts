/* End-to-end test of the real plugin code against the in-memory Obsidian mock. Runs in Chromium. */
import { App, notices } from "obsidian";
import SimpleGanttPlugin from "../src/main";

const log: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function check(cond: unknown, msg: string) {
	log.push(`${cond ? "✓" : "✗"} ${msg}`);
	if (!cond) (window as any).__failed = true;
}

(async () => {
	try {
		const app = new App();
		const plugin = new SimpleGanttPlugin(app as any, {} as any);
		await plugin.onload();
		check((window as any).ribbon?.title === "Open Simple Gantt", "ribbon button registered");

		// Opening with no projects shows the empty state
		await (window as any).ribbon.cb();
		const view = () => app.workspace.leaves[0].view;
		check(document.querySelector(".sg-root.is-empty"), "empty state shown when there are no projects");

		// Create from template via the empty state button
		(document.querySelector(".sg-template") as HTMLButtonElement).click();
		await sleep(100);
		const file = app.vault.getMarkdownFiles()[0];
		check(file?.path === "Gantt/Dissertation timeline.md", `project note created (${file?.path})`);
		const text0 = await app.vault.read(file);
		check(/^---\nsimple-gantt: true\n---/.test(text0) && text0.includes("```simple-gantt"), "note has frontmatter and data block");
		check(document.querySelectorAll(".sg-labels-svg .sg-lane-label").length === 8, "6 phases + Where + Key dates lanes rendered");

		// Quick add a task with a new phase, then a deadline
		const input = document.querySelector(".sg-quick-input") as HTMLInputElement;
		const type = (s: string) => {
			input.value = s;
			input.dispatchEvent(new Event("input"));
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		};
		type("Teaching assistant work Oct–Dec #teaching");
		type("!Ethics form 15 Jan");
		await sleep(700);
		const text1 = await app.vault.read(file);
		check(text1.includes("title: Teaching assistant work") && text1.includes("name: Teaching"), "quick-added task + new phase saved to the note");
		check(/title: Ethics form\n\s+type: deadline/.test(text1), "quick-added deadline saved");
		check(text1.startsWith("---\nsimple-gantt: true\n---\n\nOpen this timeline"), "rest of the note is preserved");

		// Undo restores the previous state and saves it
		(document.querySelector(".sg-root") as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
		await sleep(600);
		check(!(await app.vault.read(file)).includes("Ethics form"), "Ctrl+Z undoes the last quick add and saves");

		// External edit in the editor reloads the board
		await app.vault.modify(file, (await app.vault.read(file)).replace("title: Dissertation timeline", "title: Renamed in editor"));
		await sleep(50);
		check(view().board.getProject().title === "Renamed in editor", "external edits reload the board");
		check(document.querySelector(".sg-title-text")?.textContent === "Renamed in editor", "toolbar shows new title");
		(document.querySelector(".sg-root") as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
		check(view().board.getProject().title === "Renamed in editor", "undo never reverts edits made outside the board");

		// Drag a bar: move the teaching task by ~2 weeks
		const bar = document.querySelector('.sg-item.sg-task rect.sg-mark') as SVGRectElement;
		const id = bar.closest(".sg-item")!.getAttribute("data-id")!;
		const before = view().board.getProject().items.find((i: any) => i.id === id);
		const startBefore = before.start;
		const r = bar.getBoundingClientRect();
		const body = document.querySelector(".sg-body") as HTMLElement;
		const ppd = view().board["ppd"] as number;
		const opts = (x: number) => ({ clientX: x, clientY: r.top + r.height / 2, pointerId: 1, button: 0, bubbles: true, pointerType: "mouse" });
		bar.dispatchEvent(new PointerEvent("pointerdown", opts(r.left + r.width / 2)));
		body.dispatchEvent(new PointerEvent("pointermove", opts(r.left + r.width / 2 + ppd * 7)));
		body.dispatchEvent(new PointerEvent("pointermove", opts(r.left + r.width / 2 + ppd * 14)));
		body.dispatchEvent(new PointerEvent("pointerup", opts(r.left + r.width / 2 + ppd * 14)));
		const after = view().board.getProject().items.find((i: any) => i.id === id);
		const shift = (Date.parse(after.start) - Date.parse(startBefore)) / 864e5;
		check(shift === 14, `dragging a bar moves it by whole days (moved ${shift} days)`);
		await sleep(600);
		check(new RegExp(`start: '?${after.start}'?`).test(await app.vault.read(file)), "dragged dates are saved to the note");

		// Export
		await view().board.exportAs("svg");
		check(app.vault.getAbstractFileByPath("Gantt/Renamed in editor.svg"), "SVG export written next to the note");
		await view().board.exportAs("png");
		const png = app.vault.data.get("Gantt/Renamed in editor.png") as ArrayBuffer;
		check(png && png.byteLength > 50000, `PNG export written (${png ? Math.round(png.byteLength / 1024) : 0} KB)`);

		// Code block processor renders a preview
		const el = document.createElement("div");
		const src = (await app.vault.read(file)).match(/```simple-gantt\n([\s\S]*?)```/)![1];
		plugin["processors"]?.["simple-gantt"]?.(src, el, { sourcePath: file.path });
		check(el.querySelector(".sg-inline svg"), "reading-view preview renders the chart");
		const bad = document.createElement("div");
		plugin["processors"]?.["simple-gantt"]?.("title: [oops", bad, { sourcePath: file.path });
		check(bad.querySelector(".sg-inline-error"), "broken YAML shows a friendly error instead of crashing");

		check((plugin as any).saved?.lastProject === file.path, "last opened project remembered");
		check((plugin as any).saved?.projects?.[0] === file.path && plugin.listProjects()[0] === file, "timelines are tracked without scanning the vault");

		// ── New features ──
		const board = view().board;
		const proj = () => board.getProject();
		const read = () => app.vault.read(file);
		const root = document.querySelector(".sg-root") as HTMLElement;
		const key = (k: string, extra: KeyboardEventInit = {}) => root.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));

		// Quick journal line
		type("> Great supervisor meeting today");
		await sleep(600);
		check(/journal:\n\s+- date: '?\d{4}-\d{2}-\d{2}'?\n\s+text: Great supervisor meeting today/.test(await read()), "'>' in quick add writes a journal entry");

		// Tick a task done with Space, then write how it went
		const task = proj().items.find((i: any) => i.type === "task");
		board["select"](task.id);
		key(" ");
		check(task.done === true && task.progress === 100 && !!task.doneOn, "Space ticks the selected task off");
		check(document.querySelector(".sg-confetti"), "confetti celebrates it");
		check(document.querySelector(".sg-panel.is-open .sg-review"), "'How did it go?' card opens");
		(document.querySelector('.sg-review .sg-mood[aria-label="Great"]') as HTMLButtonElement).click();
		const ta = document.querySelector(".sg-review textarea") as HTMLTextAreaElement;
		ta.dispatchEvent(new Event("focus"));
		ta.value = "Smoother than expected";
		ta.dispatchEvent(new Event("input"));
		await sleep(600);
		const t2 = await read();
		check(t2.includes("done: true") && /review:\n\s+mood: 5\n\s+text: Smoother than expected/.test(t2), "done state and review saved");

		// Plan B: add one to the deadline, switch to it
		type("Pilot interviews 1 Feb – 28 Feb #data");
		const pilot = proj().items.find((i: any) => i.title === "Pilot interviews");
		board["select"](pilot.id, true, "planb");
		(document.querySelector(".sg-planb-add") as HTMLButtonElement).click();
		check(pilot.planB?.by === pilot.end, "Plan B defaults to deciding on the planned end date");
		const then = [...document.querySelectorAll(".sg-planb input[type=text]")][0] as HTMLInputElement;
		then.dispatchEvent(new Event("focus"));
		then.value = "Run an online survey instead";
		then.dispatchEvent(new Event("input"));
		check(document.querySelector('.sg-item[data-kind="decision"]'), "decision point drawn on the chart");
		board.switchToPlanB(pilot);
		const alt = proj().items.find((i: any) => i.title === "Run an online survey instead");
		check(pilot.dropped && pilot.planB.status === "active" && alt?.type === "task", "switching creates the Plan B task and fades the original");
		await sleep(600);
		const t3 = await read();
		check(t3.includes("status: active") && t3.includes("dropped: true") && t3.includes("title: Run an online survey instead"), "Plan B switch saved");

		// Ripple: push everything after an item by a week
		const before2 = proj().items.map((i: any) => [i.id, i.start]);
		board["select"](alt.id, true);
		const plusWeek = [...document.querySelectorAll(".sg-slip-chip")].find((b) => b.textContent === "+1 week") as HTMLButtonElement;
		plusWeek.click();
		const movedIds = proj().items.filter((i: any) => before2.find(([id, s]: any) => id === i.id && s !== i.start)).map((i: any) => i.id);
		check(movedIds.includes(alt.id) && !movedIds.includes(task.id), `'+1 week' pushes this and later items (${movedIds.length} moved), not finished ones`);

		// Journal panel and check-in rhythm
		key("j");
		check(document.querySelector(".sg-panel.is-open .sg-composer"), "J opens the journal");
		const sel = document.querySelector(".sg-rhythm select") as HTMLSelectElement;
		sel.value = "weekly";
		sel.dispatchEvent(new Event("change"));
		check(proj().checkin === "weekly" && document.querySelector('.sg-labels-svg [data-lane="journal"]'), "check-ins turn on the journal lane");
		await board["exportJournal"]();
		const md = app.vault.data.get("Gantt/Renamed in editor journal.md") as string;
		check(md?.includes("Great supervisor meeting today") && md.includes("Smoother than expected"), "journal saves as a Markdown note");
		await sleep(600);
		check((await read()).includes("checkin: weekly"), "check-in rhythm saved");

		// ── 0.3: links, folding, buffers, keyboard, help, spacing ──
		key("Escape");
		type("Draft chapter 3 1 Mar – 31 Mar #teach");
		type("Edit chapter 3 1 Apr – 20 Apr #teach");
		const draft = proj().items.find((i: any) => i.title === "Draft chapter 3");
		const edit = proj().items.find((i: any) => i.title === "Edit chapter 3");
		board.linkItems(draft.id, edit.id);
		check(edit.after?.includes(draft.id) && document.querySelector(".sg-link"), "linking draws an arrow");
		board["select"](draft.id);
		const editStart = edit.start;
		key("ArrowRight", { shiftKey: true });
		key("ArrowRight", { shiftKey: true });
		key("ArrowRight", { shiftKey: true });
		check(draft.start.endsWith("-22") || draft.start > "2027-03-21", `Shift+→ moves a week at a time (${draft.start})`);
		check(edit.start > editStart, `moving a task pushes what's linked after it (${editStart} → ${edit.start})`);
		await sleep(600);
		check(new RegExp(`after:\\n\\s+- ${draft.id}`).test(await read()), "links saved in the note");

		type("~ 21 Apr – 4 May #teach");
		const buf = proj().items.find((i: any) => i.buffer);
		check(buf?.title === "Buffer" && buf.type === "task", "'~' quick-adds buffer time");

		const teach = proj().phases.find((ph: any) => ph.name === "Teaching");
		(document.querySelector(`.sg-lane-label[data-lane="${teach.id}"] .sg-lane-hitbox`) as SVGElement)
			.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		check(teach.collapsed === true && document.querySelector('.sg-item[data-kind="summary"]'), "clicking a phase folds it into a summary bar");
		(document.querySelector('.sg-item[data-kind="summary"]') as SVGElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
		check(!teach.collapsed, "clicking the summary unfolds it");
		key("f");
		check(proj().phases.every((ph: any) => ph.collapsed), "F folds every phase");
		key("f");

		(document.querySelector(`.sg-lane-label[data-lane="${teach.id}"] .sg-lane-add`) as SVGElement)
			.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		check(input.value === ` #${teach.id}` && document.activeElement === input, "a row's + sets up quick add for that phase");
		input.value = "";

		key("?");
		check(document.querySelector(".sg-help .sg-help-row"), "? opens the how-to card");
		key("Escape");

		board["openProjectPanel"]();
		([...document.querySelectorAll(".sg-seg-wide button")].find((b) => b.textContent === "Compact") as HTMLButtonElement).click();
		await sleep(600);
		check((await read()).includes("density: compact"), "spacing preference saved");
		log.push(`notices: ${JSON.stringify(notices)}`);
		(window as any).__note = await app.vault.read(file);
	} catch (e) {
		(window as any).__failed = true;
		log.push(`✗ crashed: ${(e as Error).stack}`);
	}
	(window as any).__log = log;
	(window as any).__ready = true;
})();
