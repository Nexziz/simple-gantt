/* End-to-end test of the real plugin code against the in-memory Obsidian mock. Runs in Chromium. */
import { App, notices } from "obsidian";
import SimpleGanttPlugin from "../src/main";
import { isOn } from "../src/core/features";

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

		// ── Feature switches ──
		const sw = (label: string) => document.querySelector(`.sg-switch[aria-label="${label}"]`) as HTMLInputElement;
		sw("Locations").checked = false;
		sw("Locations").dispatchEvent(new Event("change"));
		check(!document.querySelector('.sg-labels-svg [data-lane="locations"]') && getComputedStyle(document.querySelector(".sg-chips .sg-chip-location")!).display === "none", "switching Locations off hides its row and button");
		sw("Journal").checked = false;
		sw("Journal").dispatchEvent(new Event("change"));
		check(getComputedStyle(document.querySelector(".sg-journal-btn")!).display === "none" && !document.querySelector('.sg-labels-svg [data-lane="journal"]'), "switching Journal off hides the journal");
		input.value = "@Lisbon 1 Mar – 5 Mar";
		input.dispatchEvent(new Event("input"));
		check(!document.querySelector(".sg-quick-preview .sg-chip-location"), "'@' no longer makes a location when locations are off");
		input.value = "";
		([...document.querySelectorAll(".sg-preset")].find((b) => b.textContent?.startsWith("Essentials")) as HTMLButtonElement).click();
		check(!isOn(proj(), "planb") && isOn(proj(), "links"), "Essentials preset switches off the extras");
		([...document.querySelectorAll(".sg-preset")].find((b) => b.textContent?.startsWith("Everything")) as HTMLButtonElement).click();
		check(proj().off === undefined && document.querySelector('.sg-labels-svg [data-lane="locations"]'), "Everything brings it all back, data intact");
		await sleep(600);
		check(!(await read()).includes("off:"), "feature choices saved in the note");

		// ── Deleting journal notes and skipping check-ins ──
		board.openJournal();
		const feedDel = document.querySelector(".sg-feed-entry .sg-feed-del") as HTMLButtonElement;
		check(feedDel && getComputedStyle(feedDel).opacity !== "0", "journal notes have a visible delete button");
		const entriesBefore = proj().journal?.length ?? 0;
		feedDel.click();
		check((proj().journal?.length ?? 0) === entriesBefore - 1, "deleting a journal note from the feed works");
		type("> Note to delete from the editor");
		board.openJournal();
		(document.querySelector(".sg-feed-entry") as HTMLElement).click();
		(document.querySelector('[aria-label="Delete this entry"]') as HTMLButtonElement).click();
		check(!(proj().journal ?? []).some((e: any) => e.text === "Note to delete from the editor"), "a note opened for editing can be deleted");
		const reviewDel = document.querySelector(".sg-feed-review .sg-feed-del") as HTMLButtonElement;
		reviewDel?.click();
		check(!proj().items.some((i: any) => i.review?.text === "Smoother than expected"), "a 'how did it go' reflection can be removed");
		const missed = [...document.querySelectorAll(".sg-rhythm .sg-link")].find((b) => b.textContent?.startsWith("Skip")) as HTMLButtonElement | undefined;
		if (missed) {
			missed.click();
			check(proj().skippedCheckins?.length > 0, "missed check-ins can be skipped");
		}
		await sleep(600);
		check(!(await read()).includes("Note to delete from the editor"), "deletions are saved to the note");
		// ── Box select, moving several at once, detaching links ──
		key("Escape");
		key("Escape");
		const bodyEl = document.querySelector(".sg-body") as HTMLElement;
		const markOf = (id: string) => document.querySelector(`.sg-item[data-id="${id}"] .sg-mark`) as SVGGraphicsElement;
		const pe = (type: string, el: Element, x: number, y: number, extra: PointerEventInit = {}) =>
			el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, pointerType: "mouse", ...extra }));
		const picked = () => board["selectedIds"] as Set<string>;
		key("v");
		check(root.classList.contains("is-select-tool"), "V switches on the select tool");
		const ra = markOf(draft.id).getBoundingClientRect(), rb = markOf(edit.id).getBoundingClientRect();
		const laneHit = document.querySelector(".sg-lane-hit")!;
		pe("pointerdown", laneHit, Math.min(ra.left, rb.left) - 4, Math.min(ra.top, rb.top) - 3);
		pe("pointermove", bodyEl, (ra.left + rb.right) / 2, (ra.top + rb.bottom) / 2);
		check(document.querySelector(".sg-marquee"), "dragging on empty space draws a selection box");
		pe("pointermove", bodyEl, Math.max(ra.right, rb.right) + 2, Math.max(ra.bottom, rb.bottom) + 3);
		pe("pointerup", bodyEl, Math.max(ra.right, rb.right) + 2, Math.max(ra.bottom, rb.bottom) + 3);
		check(picked().has(draft.id) && picked().has(edit.id), `the box selects every item it touches (${picked().size})`);
		check(document.querySelector(".sg-selbar.is-visible")?.textContent?.includes(`${picked().size} selected`), "a selection bar shows what's selected");
		check(!document.querySelector(".sg-panel.is-open"), "no single-item panel while several are selected");

		const startsBefore = new Map([...picked()].map((id) => [id, proj().items.find((i: any) => i.id === id).start as string]));
		const ppd2 = board["ppd"] as number;
		const cx = ra.left + ra.width / 2, cy = ra.top + ra.height / 2;
		pe("pointerdown", markOf(draft.id), cx, cy);
		pe("pointermove", bodyEl, cx + ppd2 * 4, cy);
		pe("pointermove", bodyEl, cx + ppd2 * 7, cy);
		pe("pointerup", bodyEl, cx + ppd2 * 7, cy);
		const shifts = [...startsBefore].map(([id, s0]) => (Date.parse(proj().items.find((i: any) => i.id === id).start) - Date.parse(s0)) / 864e5);
		check(shifts.length > 1 && shifts.every((d) => d === 7), `dragging one selected item moves them all together (${shifts.join(", ")})`);
		key("ArrowLeft", { shiftKey: true });
		check(proj().items.find((i: any) => i.id === edit.id).start === startsBefore.get(edit.id), "Shift+← moves the whole selection back a week");

		const er = markOf(edit.id).getBoundingClientRect();
		pe("pointerdown", markOf(edit.id), er.left + 3, er.top + 3, { shiftKey: true });
		pe("pointerup", bodyEl, er.left + 3, er.top + 3, { shiftKey: true });
		check(!picked().has(edit.id) && picked().has(draft.id), "Shift-click takes an item out of the selection");
		key("a", { ctrlKey: true });
		check(picked().size === board["layout"].placed.filter((p: any) => p.kind === "item").length, "Ctrl+A selects everything");
		key("Escape");
		check(picked().size === 0, "Esc clears the selection");
		key("v");
		check(!root.classList.contains("is-select-tool"), "V switches the select tool off again");

		const linkHit = () => document.querySelector(`.sg-link[data-link="${draft.id} ${edit.id}"] .sg-link-hit`);
		check(linkHit(), "links have a wide, clickable hit area");
		pe("pointerdown", linkHit()!, 0, 0);
		check(board["selectedLink"] === `${draft.id} ${edit.id}` && document.querySelector(".sg-link.is-selected"), "clicking a link selects it");
		const unlinkBtn = document.querySelector(".sg-unlink");
		check(unlinkBtn, "a selected link shows a detach button");
		unlinkBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		check(!edit.after?.includes(draft.id) && !proj().items.find((i: any) => i.id === edit.id).after?.includes(draft.id), "the detach button unlinks them");
		key("z", { ctrlKey: true });
		check(proj().items.find((i: any) => i.id === edit.id).after?.includes(draft.id), "Ctrl+Z brings the link back");
		pe("pointerdown", linkHit()!, 0, 0);
		key("Delete");
		check(!proj().items.find((i: any) => i.id === edit.id).after?.includes(draft.id), "Delete unlinks a selected link");

		board["setSelection"]([draft.id, edit.id]);
		const count = proj().items.length;
		key("Delete");
		check(proj().items.length === count - 2, "Delete removes every selected item");
		key("z", { ctrlKey: true });
		check(proj().items.length === count, "…and Ctrl+Z brings them all back");
		await sleep(600);
		check((await read()).includes("title: Draft chapter 3"), "group edits are saved to the note");
		// ── Critical path, saved plan, right-click, rename, duplicate, table export ──
		const item = (id: string) => proj().items.find((i: any) => i.id === id);
		key("Escape");
		board.linkItems(draft.id, edit.id);
		type("!Chapter 3 hand-in 15 May");
		const handIn = proj().items.find((i: any) => i.title === "Chapter 3 hand-in");
		board.linkItems(edit.id, handIn.id);
		key("c");
		check(document.querySelector(`.sg-item.is-critical[data-id="${edit.id}"]`) && document.querySelector(".sg-item.is-dimmed"), "C highlights the critical path and dims the rest");
		check(board["slack"].get(draft.id)?.limit.id === handIn.id, "slack is measured up to the linked deadline");
		key("c");
		check(!document.querySelector(".sg-item.is-dimmed"), "C again switches it off");

		board["openProjectPanel"]();
		([...document.querySelectorAll(".sg-plan-sec .sg-btn")].find((b) => b.textContent?.includes("Save the current plan")) as HTMLButtonElement).click();
		check(proj().baseline?.items[draft.id], "the current plan can be saved");
		key("Escape");
		board["select"](draft.id);
		key("ArrowRight", { shiftKey: true });
		key("b");
		check(document.querySelector(`.sg-item[data-id="${draft.id}"] .sg-planned`), "B shows where an item was planned");
		check(document.querySelector(".sg-tooltip") && board["driftLine"](item(draft.id))?.textContent?.includes("later than planned"), "the drift is described in words");
		key("b");
		check(!document.querySelector(".sg-planned"), "B again hides the saved plan");
		await sleep(600);
		check(new RegExp(`baseline:\\n\\s+saved: '?\\d{4}-\\d{2}-\\d{2}'?\\n\\s+items:`).test(await read()), "the saved plan is stored in the note");

		const dm = markOf(draft.id).getBoundingClientRect();
		markOf(draft.id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: dm.left + 3, clientY: dm.top + 3 }));
		const menuTexts = [...document.querySelectorAll(".sg-menu .sg-menu-item")].map((b) => b.textContent ?? "");
		check(menuTexts.some((t) => t.startsWith("Rename")) && menuTexts.some((t) => t.startsWith("Duplicate")), "right-click on an item opens its menu");
		key("Escape");
		check(!document.querySelector(".sg-menu"), "Esc closes the menu");
		const laneHit2 = document.querySelector('.sg-lane-hit[data-lane="locations"]')!;
		laneHit2.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: dm.left, clientY: dm.top }));
		check([...document.querySelectorAll(".sg-menu .sg-menu-item")].some((b) => b.textContent?.includes("Add a place here")), "right-click on an empty row offers to add something there");
		key("Escape");

		key("Escape");
		const click = (id: string) => {
			const r = markOf(id).getBoundingClientRect();
			pe("pointerdown", markOf(id), r.left + 3, r.top + 3);
			pe("pointerup", bodyEl, r.left + 3, r.top + 3);
		};
		click(draft.id);
		click(draft.id);
		const ri = document.querySelector(".sg-rename") as HTMLInputElement;
		check(ri && document.activeElement === ri, "double-clicking an item opens a rename field over it");
		ri.value = "Draft chapter three";
		ri.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		check(item(draft.id).title === "Draft chapter three" && !document.querySelector(".sg-rename"), "Enter saves the new name");
		key("F2");
		(document.querySelector(".sg-rename") as HTMLInputElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		check(item(draft.id).title === "Draft chapter three", "F2 renames too, and Esc cancels");

		board["setSelection"]([draft.id, edit.id]);
		const countBeforeDup = proj().items.length;
		key("d", { ctrlKey: true });
		const copies = proj().items.filter((i: any) => i.title.endsWith("(copy)"));
		const copyEdit = copies.find((i: any) => i.title.startsWith("Edit"));
		const copyDraft = copies.find((i: any) => i.title.startsWith("Draft"));
		check(proj().items.length === countBeforeDup + 2 && copyEdit?.after?.includes(copyDraft?.id), "Ctrl+D duplicates the selection, links between them included");
		check(picked().has(copyEdit?.id) && picked().size === 2, "the copies end up selected");

		await board.exportTable();
		const csv = app.vault.data.get("Gantt/Renamed in editor.csv") as string;
		check(csv?.startsWith("Phase,Item,Type,Start,End") && csv.includes("Draft chapter three"), "the plan exports as CSV");
		await board.copyTable();
		check(notices.some((n: string) => n.includes("Markdown table")) || app.vault.data.has("Gantt/Renamed in editor table.md"), "the plan copies as a Markdown table");
		log.push(`notices: ${JSON.stringify(notices)}`);
		(window as any).__note = await app.vault.read(file);
	} catch (e) {
		(window as any).__failed = true;
		log.push(`✗ crashed: ${(e as Error).stack}`);
	}
	(window as any).__log = log;
	(window as any).__ready = true;
})();
