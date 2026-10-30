// Renders the README hero images (docs/images/hero-light.png and hero-dark.png):
// the board in its own window, floating on a soft gradient.
//   node dev/build-preview.mjs && node dev/hero.mjs
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { chromium } = createRequire(import.meta.url)("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const browser = await chromium.launch();

for (const theme of ["light", "dark"]) {
	// 1. The board itself.
	const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
	await page.goto(`file://${here}/preview.html?mode=board&theme=${theme}`);
	await page.waitForFunction(() => window.__ready === true);
	await page.evaluate(() => {
		for (let i = 0; i < 6; i++) document.querySelector('.sg-nudge [aria-label="Dismiss"]')?.click();
	});
	await page.waitForTimeout(400);
	const shot = path.join(here, "out", `hero-board-${theme}.png`);
	await page.screenshot({ path: shot });
	await page.close();

	// 2. The board in a window on a gradient.
	const dark = theme === "dark";
	const html = `<!doctype html><html><head><meta charset="utf-8"><style>
		html, body { margin: 0; }
		body { width: 1600px; height: 900px; display: grid; place-items: center; overflow: hidden;
			background:
				radial-gradient(900px 500px at 12% 8%, ${dark ? "rgba(124,92,255,.35)" : "rgba(124,92,255,.22)"}, transparent 60%),
				radial-gradient(800px 520px at 92% 96%, ${dark ? "rgba(32,180,140,.25)" : "rgba(32,180,140,.18)"}, transparent 60%),
				${dark ? "#121016" : "#f6f4fb"}; }
		.win { width: 1440px; border-radius: 14px; overflow: hidden; transform: translateY(26px);
			box-shadow: 0 40px 90px ${dark ? "rgba(0,0,0,.6)" : "rgba(40,30,90,.22)"}, 0 0 0 1px ${dark ? "rgba(255,255,255,.08)" : "rgba(20,10,60,.08)"}; }
		.bar { height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: ${dark ? "#25232b" : "#ece9f3"}; }
		.bar i { width: 12px; height: 12px; border-radius: 50%; display: block; }
		.win img { display: block; width: 1440px; }
	</style></head><body><div class="win"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
	<img src="file://${shot}"></div></body></html>`;
	const file = path.join(here, "out", `hero-${theme}.html`);
	fs.writeFileSync(file, html);
	const p2 = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.25 });
	await p2.goto(`file://${file}`);
	await p2.waitForTimeout(300);
	await p2.screenshot({ path: path.join(root, "docs/images", `hero-${theme}.png`) });
	await p2.close();
	console.log(`saved docs/images/hero-${theme}.png`);
}
await browser.close();
