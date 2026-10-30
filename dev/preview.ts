import "./obsidian-dom";
import { DARK_THEME, PRINT_THEME } from "../src/core/theme";
import { renderExportSvg } from "../src/core/render";
import { toDay } from "../src/core/dates";
import { createFromTemplate } from "../src/core/templates";
import { cloneProject, type Project } from "../src/core/types";
import { GanttBoard } from "../src/ui/board";
import { RIBBON_ICON_SVG, icon } from "../src/ui/icons";
import { SAMPLE } from "./sample";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "board";
const dark = params.get("theme") === "dark";
const TODAY = "2026-10-26";
document.body.classList.add(dark ? "theme-dark" : "theme-light");

if (mode === "export") {
	const svg = renderExportSvg(SAMPLE, { theme: dark ? DARK_THEME : PRINT_THEME, includeToday: true, today: toDay(TODAY), compare: params.has("compare") });
	svg.id = "shot";
	document.body.appendChild(svg);
} else {
	// A stand-in for Obsidian's workspace: ribbon on the left, one tab with the board.
	document.body.innerHTML = `
	<div class="mock-app">
		<div class="mock-ribbon">
			<span>${icon("note", 18).outerHTML}</span><span>${icon("today", 18).outerHTML}</span>
			<span class="is-active" title="Open timeline"><svg viewBox="0 0 100 100" width="18" height="18">${RIBBON_ICON_SVG}</svg></span>
			<span>${icon("settings", 18).outerHTML}</span>
		</div>
		<div class="mock-main">
			<div class="mock-tabs"><div class="mock-tab"><svg viewBox="0 0 100 100" width="14" height="14">${RIBBON_ICON_SVG}</svg>Simple Gantt</div></div>
			<div class="mock-content simple-gantt-view view-content" id="host"></div>
		</div>
	</div>`;
	const projects: Record<string, Project> = { sample: cloneProject(SAMPLE) };
	let current = params.get("empty") ? null : "sample";
	const board = new GanttBoard(document.getElementById("host")!, {
		save: (p) => (projects[current!] = p),
		today: () => TODAY,
		listProjects: () => Object.entries(projects).map(([id, p]) => ({ id, title: p.title })),
		switchProject: (id) => {
			current = id;
			board.setProject(projects[id], id);
		},
		createProject: (t) => {
			const id = `p${Object.keys(projects).length}`;
			projects[id] = createFromTemplate(t, t === "dissertation" ? "My dissertation" : "New project", TODAY);
			current = id;
			board.setProject(projects[id], id);
		},
		exportFile: async (name, data) => {
			const blob = typeof data === "string" ? new Blob([data], { type: "image/svg+xml" }) : data;
			const a = document.createElement("a");
			a.href = URL.createObjectURL(blob);
			a.download = name;
			a.click();
		},
		notify: (m) => {
			console.log("notice:", m);
			const box = document.querySelector(".mock-notices") ?? document.body.appendChild(Object.assign(document.createElement("div"), { className: "mock-notices" }));
			const n = box.appendChild(Object.assign(document.createElement("div"), { className: "mock-notice", textContent: m }));
			setTimeout(() => n.classList.add("is-out"), 3200);
			setTimeout(() => n.remove(), 3600);
		},
		openNote: (n) => console.log("open note", n),
		suggestNotes: (q) => ["Chapters/Chapter 2 - Literature", "Chapters/Chapter 3 - Methods", "Ethics/Application form", "Meetings/Supervisor"].filter((n) => n.toLowerCase().includes(q.toLowerCase())),
	});
	board.setProject(current ? projects[current] : null, current);
	(window as any).board = board;
	(window as any).projects = projects;
}
(window as any).__ready = true;
