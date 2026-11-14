import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// `import data from "embed:<file>"` gives a file's bytes as a base64 string, gzipped at build time (a file that already ends in .gz is embedded as it is).
// <file> is a path in the repository ("src/...") or a file of an installed package ("tesseract.js/dist/worker.min.js"). Used by src/recognition/assets.ts:
// the plugin's OCR engine has to live INSIDE main.js (the directory's policies forbid a plugin to install its own dependencies), and gzip keeps the 4 MB of
// WebAssembly to about 1.5 MB; src/recognition/embed.d.ts declares the module. The gzip header carries no date, so the build is reproducible.
// A file of its own because every bundle of the plugin's code needs it: the build (esbuild.config.mjs), the browser-pane harness and its A/B benches.
export const embedPlugin = {
	name: "embed",
	setup(build) {
		const base = build.initialOptions.absWorkingDir ?? process.cwd();
		build.onResolve({ filter: /^embed:/ }, (args) => ({ path: join(base, /^(src|tools)\//.test(args.path.slice(6)) ? "" : "node_modules", args.path.slice(6)), namespace: "embed" }));
		build.onLoad({ filter: /.*/, namespace: "embed" }, (args) => {
			const bytes = readFileSync(args.path);
			const packed = args.path.endsWith(".gz") ? bytes : gzipSync(bytes, { level: 9 });
			return { contents: `export default "${packed.toString("base64")}";`, loader: "js", watchFiles: [args.path] };
		});
	},
};
