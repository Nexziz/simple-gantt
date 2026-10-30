// Renders the README / progress screenshots by driving the preview harness like a user would.
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];

/** Select tool on, then drag a box from an empty spot (top right) over the data-collection and analysis items. */
async function boxSelect(page, release) {
	await page.click('[data-tool="select"]');
	await page.mouse.move(0, 0);
	const a = await page.locator('.sg-item[data-id="c1"] rect.sg-mark').boundingBox();
	const b = await page.locator('.sg-item[data-id="d2"] rect.sg-mark').boundingBox();
	const [x0, y0, x1, y1] = [a.x + a.width + 470, a.y - 12, a.x + 60, b.y + b.height - 6];
	await page.mouse.move(x0, y0);
	await page.mouse.down();
	for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + (x1 - x0) * (i / 10), y0 + (y1 - y0) * (i / 10));
	if (release) await page.mouse.up();
}

const scenes = {
	async "02-board-light"(page) {},
	async "03-quick-add"(page) {
		await page.click(".sg-quick-input");
		await page.keyboard.type("Draft Chapter 4 15 Jun – 20 Jul #writ 10%", { delay: 8 });
		await page.waitForTimeout(350);
	},
	async "04-edit-panel"(page) {
		await page.click('.sg-item[data-id="a2"] rect.sg-mark');
		await page.waitForTimeout(500);
		await page.locator(".sg-panel .sg-input").first().evaluate((el) => el.blur());
		const box = await page.locator('.sg-item[data-id="b2"] rect.sg-mark').boundingBox();
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.waitForTimeout(250);
	},
	async "05-dark-quarter"(page) {
		await page.click('.sg-seg[aria-label="Zoom"] button:nth-child(2)');
		await page.waitForTimeout(500);
	},
	async "06-project-panel"(page) {
		await page.click('[aria-label="Project settings"]');
		await page.waitForTimeout(500);
	},
	async "07-empty"(page) {},
	async "09-mobile"(page) {},
	async "10-reached-confetti"(page) {
		await page.click('.sg-pager button[aria-label="Next"]');
		await page.waitForTimeout(250);
		await page.click(".sg-nudge .sg-btn.sg-primary");
		await page.waitForTimeout(380);
	},
	async "11-review"(page) {
		await page.click('.sg-pager button[aria-label="Next"]');
		await page.waitForTimeout(250);
		await page.click(".sg-nudge .sg-btn.sg-primary");
		await page.waitForTimeout(500);
		await page.click('.sg-review .sg-mood[aria-label="Good"]');
		await page.locator(".sg-review textarea").fill("Took two extra meetings, but the question is much sharper now: focusing on rural cooperatives.");
		await page.waitForTimeout(2200);
	},
	async "12-plan-b"(page) {
		await page.click('.sg-item[data-kind="ghost"] .sg-mark');
		await page.waitForTimeout(600);
		await page.locator(".sg-panel .sg-form").evaluate((el) => el.scrollTo(0, 400));
		await page.waitForTimeout(200);
	},
	async "13-journal"(page) {
		await page.click(".sg-journal-btn");
		await page.waitForTimeout(400);
		await page.click('.sg-composer .sg-mood[aria-label="Good"]');
		await page.locator(".sg-composer textarea").fill("Narrowed the question down to rural energy cooperatives. Feels doable!");
		await page.waitForTimeout(300);
	},
	async "15-folded"(page) {
		await page.click('.sg-lane-label[data-lane="literature"] .sg-lane-hitbox');
		await page.click('.sg-lane-label[data-lane="methodology"] .sg-lane-hitbox');
		await page.waitForTimeout(300);
	},
	async "16-help"(page) {
		await page.click('[aria-label="How to use (?)"]');
		await page.waitForTimeout(300);
	},
	async "17-link-drag"(page) {
		const bar = page.locator('.sg-item[data-id="d1"] rect.sg-mark');
		await bar.hover();
		const dot = await page.locator('.sg-item[data-id="d1"] .sg-connector circle').first().boundingBox();
		const target = await page.locator('.sg-item[data-id="e2"] rect.sg-mark').boundingBox();
		await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
		await page.mouse.down();
		for (let i = 1; i <= 10; i++) await page.mouse.move(dot.x + (target.x + 30 - dot.x) * (i / 10), dot.y + (target.y + 10 - dot.y) * (i / 10));
		await page.waitForTimeout(150);
	},
	async "18-sparse-dark"(page) {
		await page.click(".sg-template");
		await page.waitForTimeout(200);
		for (const line of ["Research automotive software landscape 5 Nov – 30 Nov #lit", "Reverse engineer an automotive ECU 1 Dec – 15 Jan #data", "!Dissertation proposal 9 Nov"]) {
			await page.fill(".sg-quick-input", line);
			await page.press(".sg-quick-input", "Enter");
		}
		await page.click('.sg-seg[aria-label="Zoom"] button:nth-child(2)');
		await page.waitForTimeout(500);
		const lane = await page.locator('.sg-lane-hit[data-lane="analysis"]').boundingBox();
		await page.mouse.move(lane.x + 500, lane.y + lane.height / 2);
		await page.waitForTimeout(300);
	},
	async "19-features"(page) {
		await page.click('[aria-label="Project settings"]');
		await page.waitForTimeout(300);
		await page.locator(".sg-panel .sg-form").evaluate((el) => el.scrollTo(0, el.scrollHeight));
		await page.click('.sg-switch[aria-label="Locations"]');
		await page.waitForTimeout(400);
		await page.locator(".sg-panel .sg-form").evaluate((el) => {
			const t = [...el.querySelectorAll(".sg-section-title")].find((x) => x.textContent === "Features");
			el.scrollTo(0, t.offsetTop - 20);
		});
		await page.waitForTimeout(300);
	},
	async "20-box-select"(page) {
		await boxSelect(page, false);
		await page.waitForTimeout(150);
	},
	async "21-group-move"(page) {
		await boxSelect(page, true);
		const c = await page.locator('.sg-item[data-id="c2"] rect.sg-mark').boundingBox();
		await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
		await page.mouse.down();
		for (let i = 1; i <= 8; i++) await page.mouse.move(c.x + c.width / 2 + i * 5, c.y + c.height / 2);
		await page.waitForTimeout(150);
	},
	async "22-unlink"(page) {
		const pt = await page.locator('.sg-link[data-link="c2 d2"] .sg-link-hit').evaluate((el) => {
			const p = el.getPointAtLength(el.getTotalLength() * 0.3);
			const r = el.ownerSVGElement.getBoundingClientRect();
			return { x: r.left + p.x, y: r.top + p.y };
		});
		await page.mouse.move(pt.x, pt.y);
		await page.waitForTimeout(150);
		await page.mouse.down();
		await page.mouse.up();
		await page.waitForTimeout(150);
		await page.locator(".sg-unlink").waitFor();
		await page.mouse.move(pt.x, pt.y + 1);
		await page.waitForTimeout(150);
	},
	async "23-sidebar"(page) {
		for (let i = 0; i < 6; i++) await page.evaluate(() => document.querySelector('.sg-nudge [aria-label="Dismiss"]')?.click());
		await page.waitForTimeout(400);
	},
	async "14-ripple"(page) {
		const box = await page.locator('.sg-item[data-id="b3"] rect.sg-mark').boundingBox();
		const y = box.y + box.height / 2;
		await page.mouse.move(box.x + box.width / 2, y);
		await page.mouse.down();
		await page.keyboard.down("Shift");
		for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width / 2 + i * 8, y);
		await page.waitForTimeout(150);
	},
};
const viewports = { "09-mobile": { width: 390, height: 780 } };
const query = { "23-sidebar": "sidebar=1", "05-dark-quarter": "theme=dark", "07-empty": "empty=1", "18-sparse-dark": "theme=dark&empty=1" };

const browser = await chromium.launch();
for (const [name, act] of Object.entries(scenes)) {
	if (only && !name.includes(only)) continue;
	const page = await browser.newPage({ viewport: viewports[name] ?? { width: 1600, height: 920 }, deviceScaleFactor: 2 });
	page.on("pageerror", (e) => console.error(name, "page error:", e.message));
	page.on("console", (m) => m.type() === "error" && console.error(name, "console:", m.text()));
	await page.goto(`file://${here}/preview.html?mode=board&${query[name] ?? ""}`);
	await page.waitForFunction(() => window.__ready === true);
	await page.waitForTimeout(200);
	await act(page);
	await page.screenshot({ path: `docs/images/${name}.png` });
	console.log("saved", name);
	await page.close();
}
await browser.close();
