import esbuild from "esbuild";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
await esbuild.build({
	entryPoints: ["dev/integration.ts"],
	bundle: true,
	format: "iife",
	outfile: "dev/out/integration.js",
	alias: { obsidian: "./dev/obsidian-mock.ts" },
	logLevel: "warning",
});
const { chromium } = createRequire(import.meta.url)("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.goto(`file://${here}/integration.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
const log = await page.evaluate(() => window.__log);
console.log(log.join("\n"));
if (process.env.SHOW_NOTE) console.log("\n" + (await page.evaluate(() => window.__note)));
if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
const failed = await page.evaluate(() => window.__failed);
await browser.close();
process.exit(failed ? 1 : 0);
