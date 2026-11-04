import esbuild from "esbuild";
import { execFileSync } from "child_process";

for (const name of ["parse", "nudges"]) {
	await esbuild.build({ entryPoints: [`dev/${name}.test.ts`], bundle: true, platform: "node", format: "esm", outfile: `dev/out/${name}.test.mjs`, logLevel: "warning" });
	execFileSync(process.execPath, [`dev/out/${name}.test.mjs`], { stdio: "inherit" });
}
