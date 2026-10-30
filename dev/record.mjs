// Records the animated GIFs in docs/gifs by driving the preview harness like a person would:
// a visible cursor, click ripples, the keys being pressed and a short caption.
// Frames come from Chrome's screencast (real time), ffmpeg turns them into GIFs.
//   node dev/build-preview.mjs && node dev/record.mjs [name-filter]
import { createRequire } from "module";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const only = process.argv[2];
const VIEW = { width: 1280, height: 800 };
const SCALE = 1.5;
const OUT_W = 1000;

/** Cursor, click ripple, key badge and caption, drawn inside the page so the screencast sees them. */
const OVERLAY = `
(() => {
	const css = document.createElement("style");
	css.textContent = \`
		#demo-cursor { position: fixed; left: 0; top: 0; z-index: 99999; pointer-events: none; width: 26px; height: 26px;
			transform: translate(-100px, -100px); filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); transition: scale .12s; }
		#demo-cursor.is-down { scale: .86; }
		.demo-ripple { position: fixed; z-index: 99998; pointer-events: none; width: 36px; height: 36px; margin: -18px 0 0 -18px;
			border-radius: 50%; background: rgba(124, 92, 255, .35); animation: demo-ripple .5s ease-out forwards; }
		@keyframes demo-ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
		#demo-keys { position: fixed; left: 50%; bottom: 74px; z-index: 99999; pointer-events: none; display: flex; gap: 6px;
			transform: translateX(-50%); transition: opacity .25s; opacity: 0; }
		#demo-keys.is-on { opacity: 1; }
		#demo-keys kbd { min-width: 34px; padding: 7px 11px; border-radius: 9px; background: rgba(20,20,24,.86); color: #fff; text-align: center;
			font: 600 17px/1 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
		#demo-caption { position: fixed; left: 50%; bottom: 18px; z-index: 99999; pointer-events: none; transform: translateX(-50%);
			padding: 10px 18px; border-radius: 999px; background: #7c5cff; color: #fff; white-space: nowrap;
			font: 600 17px/1.2 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; box-shadow: 0 6px 20px rgba(124,92,255,.35);
			transition: opacity .3s, transform .3s; }
		#demo-caption.is-hidden { opacity: 0; transform: translate(-50%, 8px); }
	\`;
	document.head.appendChild(css);
	const cur = document.createElement("div");
	cur.id = "demo-cursor";
	cur.innerHTML = '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M4 2.5v18.2l4.6-4.4 3 6.6 3.2-1.5-3-6.4h6.4z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
	document.body.appendChild(cur);
	const keys = Object.assign(document.createElement("div"), { id: "demo-keys" });
	const cap = Object.assign(document.createElement("div"), { id: "demo-caption", className: "is-hidden" });
	document.body.append(keys, cap);
	const move = (e) => (cur.style.transform = "translate(" + (e.clientX - 3) + "px," + (e.clientY - 2) + "px)");
	document.addEventListener("pointermove", move, true);
	document.addEventListener("mousemove", move, true);
	document.addEventListener("pointerdown", (e) => {
		cur.classList.add("is-down");
		const r = document.body.appendChild(Object.assign(document.createElement("div"), { className: "demo-ripple" }));
		r.style.left = e.clientX + "px";
		r.style.top = e.clientY + "px";
		setTimeout(() => r.remove(), 600);
	}, true);
	document.addEventListener("pointerup", () => cur.classList.remove("is-down"), true);
	let keyTimer = 0;
	window.__keys = (list) => {
		keys.replaceChildren(...list.map((k) => Object.assign(document.createElement("kbd"), { textContent: k })));
		keys.classList.add("is-on");
		clearTimeout(keyTimer);
		keyTimer = setTimeout(() => keys.classList.remove("is-on"), 1100);
	};
	window.__caption = (text, lift) => {
		if (!text) return cap.classList.add("is-hidden");
		cap.style.bottom = 18 + (lift || 0) + "px";
		cap.textContent = text;
		cap.classList.remove("is-hidden");
	};
})();
`;

function demo(page) {
	let pos = { x: VIEW.width / 2, y: VIEW.height / 2 };
	const api = {
		page,
		wait: (ms) => page.waitForTimeout(ms),
		caption: (t, lift = 0) => page.evaluate(([t, lift]) => window.__caption(t, lift), [t, lift]),
		/** Glide the cursor with an ease-in-out curve. */
		async move(x, y, ms) {
			const dist = Math.hypot(x - pos.x, y - pos.y);
			const steps = Math.max(6, Math.min(40, Math.round(dist / 22)));
			const from = pos;
			for (let i = 1; i <= steps; i++) {
				const t = i / steps;
				const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
				await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
				if (ms) await page.waitForTimeout(ms / steps);
			}
			pos = { x, y };
		},
		async box(sel) {
			const b = await page.locator(sel).first().boundingBox();
			if (!b) throw new Error(`not found: ${sel}`);
			return { ...b, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
		},
		async click(sel, dx = 0, dy = 0) {
			const b = await api.box(sel);
			await api.move(b.cx + dx, b.cy + dy);
			await api.wait(120);
			await page.mouse.down();
			await api.wait(70);
			await page.mouse.up();
		},
		async drag(from, to, opts = {}) {
			await api.move(from.x, from.y);
			await api.wait(200);
			if (opts.shift) await page.keyboard.down("Shift");
			await page.mouse.down();
			await api.wait(120);
			await api.move(to.x, to.y, opts.ms ?? 700);
			await api.wait(opts.hold ?? 350);
			await page.mouse.up();
			if (opts.shift) await page.keyboard.up("Shift");
		},
		/** A point on a row's empty space (nothing drawn there for `room` px to the right). */
		async emptySpot(lane, room = 160) {
			return page.evaluate(([lane, room]) => {
				const r = document.querySelector(`.sg-lane-hit[data-lane="${lane}"]`).getBoundingClientRect();
				const sc = document.querySelector(".sg-scroller").getBoundingClientRect();
				for (let y = r.top + 10; y < r.bottom - 6; y += 6)
					for (let x = Math.max(r.left, sc.left + 260); x < Math.min(r.right, sc.right) - room; x += 12) {
						const ok = [0, room / 3, (2 * room) / 3, room].every((dx) => document.elementFromPoint(x + dx, y)?.classList.contains("sg-lane-hit"));
						if (ok) return { x, y };
					}
				return null;
			}, [lane, room]);
		},
		async key(combo, shown) {
			await page.evaluate((k) => window.__keys(k), shown ?? combo.split("+").map((k) => (k === "Control" ? "Ctrl" : k)));
			await api.wait(160);
			await page.keyboard.press(combo);
		},
		async type(text) {
			await page.keyboard.type(text, { delay: 55 });
		},
	};
	return api;
}

/** Each scene: prep (not recorded) and play (recorded). */
const scenes = {
	async pan(d) {
		await d.caption("Drag empty space to move around, like on a Canvas");
		const a = await d.emptySpot("methodology", 40);
		await d.drag({ x: a.x + 300, y: a.y + 60 }, { x: a.x - 220, y: a.y - 180 }, { ms: 1400, hold: 300 });
		await d.wait(600);
		await d.drag({ x: a.x + 60, y: a.y - 100 }, { x: a.x + 260, y: a.y - 40 }, { ms: 1100, hold: 300 });
		await d.wait(700);
		await d.caption("The tools in the corner change what a drag does: ✚ draws tasks");
		await d.click('[data-tool="draw"]');
		await d.wait(700);
		const spot = await d.emptySpot("data", 200);
		await d.drag({ x: spot.x, y: spot.y }, { x: spot.x + 170, y: spot.y }, { ms: 900, hold: 300 });
		await d.wait(500);
		await d.type("Transcribe pilot interviews");
		await d.key("Enter", ["↵ Enter"]);
		await d.wait(900);
		await d.caption("✋ (or H) to move around again");
		await d.click('.sg-panel [aria-label="Close"]');
		await d.wait(300);
		await d.click('[data-tool="hand"]');
		await d.wait(500);
		const e2 = await d.emptySpot("analysis", 20);
		await d.drag({ x: e2.x, y: e2.y }, { x: e2.x - 260, y: e2.y + 70 }, { ms: 1000, hold: 300 });
		await d.wait(1000);
	},
	async sidebar(d) {
		await d.caption("A panel in your sidebar: what's on now and what's coming up");
		await d.wait(800);
		await d.move(160, 330, 700);
		await d.wait(700);
		await d.caption("Click anything to jump to it on the timeline");
		await d.click('.sg-ov-row[aria-label$="Systematic literature review"]');
		await d.wait(1600);
		await d.click('.sg-ov-row[aria-label$="Ethics application"]');
		await d.wait(1600);
		await d.caption("Drag its icon to any tab group in the sidebars");
		const tab = await d.box(".mock-side-tabs .is-active");
		await d.move(tab.cx, tab.cy, 800);
		await d.wait(1800);
	},
	async "quick-add"(d) {
		await d.caption("Type one line: dates, phases and types are understood");
		await d.click(".sg-quick-input");
		await d.wait(300);
		await d.type("Pilot interviews 3 May – 28 May #data 20%");
		await d.wait(900);
		await d.key("Enter", ["↵ Enter"]);
		await d.wait(1100);
		await d.type("!Ethics resubmission 14 May");
		await d.wait(800);
		await d.key("Enter", ["↵ Enter"]);
		await d.wait(1800);
	},
	async drag(d) {
		const c3 = await d.box('.sg-item[data-id="c3"] rect.sg-mark');
		await d.caption("Drag a bar to move it, with date guides");
		await d.drag({ x: c3.cx, y: c3.cy }, { x: c3.cx + 70, y: c3.cy }, { ms: 900, hold: 600 });
		await d.wait(500);
		const c2 = await d.box('.sg-item[data-id="c2"] rect.sg-mark');
		await d.caption("Drag an edge to change how long it takes");
		await d.drag({ x: c2.x + c2.width - 3, y: c2.cy }, { x: c2.x + c2.width + 45, y: c2.cy }, { ms: 700, hold: 600 });
		await d.wait(500);
		const b3 = await d.box('.sg-item[data-id="b3"] rect.sg-mark');
		await d.caption("Hold Shift to move everything after it too");
		await d.drag({ x: b3.cx, y: b3.cy }, { x: b3.cx + 60, y: b3.cy }, { shift: true, ms: 1000, hold: 900 });
		await d.wait(1200);
	},
	async link(d) {
		const c1 = await d.box('.sg-item[data-id="c1"] rect.sg-mark');
		const c3 = await d.box('.sg-item[data-id="c3"] rect.sg-mark');
		await d.caption("Drag the dot at the end of a bar onto what comes next");
		await d.move(c1.cx, c1.cy, 500);
		await d.wait(400);
		const dot = await d.box('.sg-item[data-id="c1"] .sg-connector circle');
		await d.drag({ x: dot.cx, y: dot.cy }, { x: c3.cx, y: c3.cy }, { ms: 1000, hold: 700 });
		await d.wait(1200);
		await d.caption("Linked items keep their order: move one and the next follows");
		const moved = await d.box('.sg-item[data-id="c1"] rect.sg-mark');
		await d.drag({ x: moved.cx, y: moved.cy }, { x: moved.cx + 75, y: moved.cy }, { ms: 1200, hold: 900 });
		await d.wait(1200);
		await d.caption("Click a line to select it, then × to detach it");
		const pt = await d.page.locator('.sg-link[data-link="c1 c3"] .sg-link-hit').evaluate((el) => {
			const p = el.getPointAtLength(el.getTotalLength() * 0.5);
			const r = el.ownerSVGElement.getBoundingClientRect();
			return { x: r.left + p.x, y: r.top + p.y };
		});
		await d.move(pt.x - 6, pt.y, 600);
		await d.wait(600);
		await d.page.mouse.down();
		await d.page.mouse.up();
		await d.wait(900);
		await d.click(".sg-unlink");
		await d.wait(1800);
	},
	async select(d) {
		await d.caption("Select tool (V): drag a box over several items");
		await d.click('[data-tool="select"]');
		await d.wait(500);
		const c1 = await d.box('.sg-item[data-id="c1"] rect.sg-mark');
		const d2 = await d.box('.sg-item[data-id="d2"] rect.sg-mark');
		await d.drag({ x: c1.x + c1.width + 330, y: c1.y - 12 }, { x: c1.x + 40, y: d2.y + d2.height - 4 }, { ms: 1000, hold: 500 });
		await d.wait(700);
		await d.caption("Drag one of them and they all move together", 64);
		const c2 = await d.box('.sg-item[data-id="c2"] rect.sg-mark');
		await d.drag({ x: c2.cx, y: c2.cy }, { x: c2.cx + 80, y: c2.cy }, { ms: 1000, hold: 700 });
		await d.wait(600);
		await d.caption("…or use the bar below: link them, tick them off, delete", 64);
		await d.move(VIEW.width / 2 - 40, VIEW.height - 130, 700);
		await d.wait(1600);
		await d.key("Escape", ["Esc"]);
		await d.wait(800);
	},
	async done(d) {
		await d.caption("Tick things off, with confetti and a quick “How did it go?”");
		await d.click('.sg-item[data-id="a0"] .sg-mark');
		await d.wait(700);
		await d.key(" ", ["Space"]);
		await d.wait(1300);
		await d.click('.sg-review .sg-mood[aria-label="Good"]');
		await d.wait(300);
		await d.click(".sg-review textarea");
		await d.type("Took two extra meetings, but much sharper now.");
		await d.wait(1600);
	},
	async "zoom-fold"(d) {
		await d.caption("Year, quarter or month: zoom smoothly");
		await d.click('.sg-seg[aria-label="Zoom"] button:nth-child(2)');
		await d.wait(1100);
		await d.click('.sg-seg[aria-label="Zoom"] button:nth-child(3)');
		await d.wait(1100);
		await d.click('.sg-seg[aria-label="Zoom"] button:nth-child(1)');
		await d.wait(1000);
		await d.caption("Click a phase to fold it into one summary bar");
		await d.click('.sg-lane-label[data-lane="literature"] .sg-lane-hitbox');
		await d.wait(700);
		await d.click('.sg-lane-label[data-lane="methodology"] .sg-lane-hitbox');
		await d.wait(900);
		await d.caption("F folds everything, for a one-glance overview");
		await d.key("f", ["F"]);
		await d.wait(1500);
		await d.key("f", ["F"]);
		await d.wait(800);
	},
	async insights(d) {
		await d.caption("Critical path (C): the chain with the least slack before a deadline");
		await d.click('[aria-label^="Critical path"]');
		await d.wait(900);
		const f1 = await d.box('.sg-item[data-id="f1"] rect.sg-mark');
		await d.move(f1.cx, f1.cy, 800);
		await d.wait(1800);
		await d.click('[aria-label^="Critical path"]');
		await d.wait(500);
		await d.caption("Saved plan (B): see what moved since you made the plan");
		await d.click('[aria-label^="Compare with the saved plan"]');
		await d.wait(900);
		const c1 = await d.box('.sg-item[data-id="c1"] rect.sg-mark');
		await d.move(c1.cx, c1.cy, 800);
		await d.wait(2200);
	},
	async "menu-rename"(d) {
		await d.caption("Right-click anything for its menu");
		const c3 = await d.box('.sg-item[data-id="c3"] rect.sg-mark');
		await d.move(c3.cx, c3.cy, 600);
		await d.wait(300);
		await d.page.mouse.click(c3.cx, c3.cy, { button: "right" });
		await d.wait(1300);
		await d.caption("Rename right on the chart (or double-click it)");
		const rename = d.page.locator(".sg-menu .sg-menu-item", { hasText: "Rename" });
		const rb = await rename.boundingBox();
		await d.move(rb.x + 40, rb.y + rb.height / 2, 500);
		await d.wait(250);
		await rename.click();
		await d.wait(400);
		await d.type("Follow-up interviews");
		await d.wait(400);
		await d.key("Enter", ["↵ Enter"]);
		await d.wait(900);
		await d.caption("…or add something exactly where you click");
		await d.page.mouse.click(c3.x + 180, c3.cy + 46, { button: "right" });
		await d.move(c3.x + 180, c3.cy + 46, 300);
		await d.wait(1000);
		const add = d.page.locator(".sg-menu .sg-menu-item", { hasText: "Add a milestone here" });
		const ab = await add.boundingBox();
		await d.move(ab.x + 60, ab.y + ab.height / 2, 500);
		await d.wait(200);
		await add.click();
		await d.wait(500);
		await d.type("Data collection complete");
		await d.key("Enter", ["↵ Enter"]);
		await d.wait(1600);
	},
};

/** Per scene: query, scroll and setup before recording starts. */
const setup = {
	pan: { zoom: 2 },
	sidebar: { query: "sidebar=1" },
	link: { scrollTop: 330 },
	select: { scrollTop: 330 },
	"menu-rename": { scrollTop: 330 },
	insights: { scrollTop: 330, query: "theme=dark" },
	drag: { scrollTop: 170 },
	"quick-add": { scrollTop: 0 },
};

const browser = await chromium.launch();
fs.mkdirSync(path.join(root, "docs/gifs"), { recursive: true });
for (const [name, play] of Object.entries(scenes)) {
	if (only && !name.includes(only)) continue;
	const cfg = setup[name] ?? {};
	const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: SCALE });
	page.on("pageerror", (e) => console.error(name, "page error:", e.message));
	await page.goto(`file://${here}/preview.html?mode=board&${cfg.query ?? ""}`);
	await page.waitForFunction(() => window.__ready === true);
	await page.evaluate(OVERLAY);
	// A calm start: no nudges, chart scrolled to the part the scene is about.
	await page.evaluate((top) => {
		for (let i = 0; i < 6; i++) document.querySelector('.sg-nudge [aria-label="Dismiss"]')?.click();
		const sc = document.querySelector(".sg-scroller");
		if (sc && top) sc.scrollTop = top;
	}, cfg.scrollTop ?? 0);
	if (cfg.zoom) await page.click(`.sg-seg[aria-label="Zoom"] button:nth-child(${cfg.zoom})`);
	await page.waitForTimeout(500);

	const frames = [];
	const cdp = await page.context().newCDPSession(page);
	cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
		frames.push({ data, t: metadata.timestamp });
		await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
	});
	await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
	await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
	await page.waitForTimeout(400);
	const d = demo(page);
	await play(d);
	await d.caption("");
	await page.waitForTimeout(500);
	await cdp.send("Page.stopScreencast");
	await page.close();

	const dir = path.join(here, "out/frames", name);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const list = [];
	frames.forEach((f, i) => {
		const file = path.join(dir, `${String(i).padStart(5, "0")}.png`);
		fs.writeFileSync(file, Buffer.from(f.data, "base64"));
		const next = frames[i + 1]?.t ?? f.t + 1.2;
		list.push(`file '${file}'`, `duration ${Math.max(0.02, next - f.t).toFixed(3)}`);
	});
	list.push(`file '${path.join(dir, `${String(frames.length - 1).padStart(5, "0")}.png`)}'`);
	fs.writeFileSync(path.join(dir, "list.txt"), list.join("\n"));
	const out = path.join(root, "docs/gifs", `${name}.gif`);
	execFileSync("ffmpeg", [
		"-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"),
		"-vf", `fps=18,scale=${OUT_W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
		"-loop", "0", out,
	]);
	console.log(`saved docs/gifs/${name}.gif  ${frames.length} frames  ${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB`);
}
await browser.close();
