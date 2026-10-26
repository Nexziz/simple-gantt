import { createRequire } from "module";
import path from "path";
// The preinstalled Playwright resolves through require(), not ESM import.
const { chromium } = createRequire(import.meta.url)("playwright");
import { fileURLToPath } from "url";

// Usage: node dev/screenshot.mjs <query> <out.png> [width] [height] [selector]
const here = path.dirname(fileURLToPath(import.meta.url));
const [query = "mode=export", out = "docs/images/shot.png", width = "1500", height = "900", selector = ""] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +width, height: +height }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("page error:", e.message));
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
await page.goto(`file://${here}/preview.html?${query}`);
await page.waitForFunction(() => window.__ready === true);
await page.waitForTimeout(400);
if (selector) await page.locator(selector).screenshot({ path: out });
else await page.screenshot({ path: out });
await browser.close();
console.log("saved", out);
