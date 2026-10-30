// Renders docs/images/buy-me-a-coffee.png, the support button used in the README
// (kept in the repo so it always shows, whatever is reachable).
//   node dev/coffee.mjs
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
	html, body { margin: 0; background: transparent; }
	.btn { display: inline-flex; align-items: center; gap: 10px; height: 52px; padding: 0 22px 0 16px; border-radius: 12px;
		background: #ffdd00; color: #000; font: 700 20px/1 "Inter", sans-serif; letter-spacing: -0.01em;
		box-shadow: inset 0 0 0 1.5px rgba(0,0,0,.85); }
	svg { width: 30px; height: 30px; }
</style></head><body><div class="btn" id="b">
	<svg viewBox="0 0 32 32" fill="none" stroke="#000" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
		<path d="M7 9h18l-2.2 18.2a2 2 0 0 1-2 1.8h-9.6a2 2 0 0 1-2-1.8z" fill="#fff"/>
		<path d="M8.4 15.5h15.2l-1 8.3H9.4z" fill="#ff813f" stroke="none"/>
		<path d="M6 9h20M8.5 9l1-4h13l1 4"/>
	</svg>
	Buy me a coffee
</div></body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 3 });
await page.setContent(html);
await page.locator("#b").screenshot({ path: path.join(root, "docs/images/buy-me-a-coffee.png"), omitBackground: true });
await browser.close();
console.log("saved docs/images/buy-me-a-coffee.png");
