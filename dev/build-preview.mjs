import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["dev/preview.ts"],
	bundle: true,
	format: "iife",
	target: "es2020",
	outfile: "dev/out/preview.js",
	// The sidebar overview is an Obsidian view; the preview runs it against the in-memory mock.
	alias: { obsidian: "./dev/obsidian-mock.ts" },
	logLevel: "warning",
});
console.log("Built dev/out/preview.js — open dev/preview.html");
