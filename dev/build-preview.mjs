import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["dev/preview.ts"],
	bundle: true,
	format: "iife",
	target: "es2020",
	outfile: "dev/out/preview.js",
	logLevel: "warning",
});
console.log("Built dev/out/preview.js — open dev/preview.html");
