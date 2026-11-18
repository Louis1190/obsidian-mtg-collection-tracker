// Modules the build creates (esbuild.config.mjs, the `embed` plugin) and the one npm file the engine is imported from.

/** The file's bytes, gzipped (unless it already was), as base64: `embed:src/...` or `embed:<package>/<file>`. */
declare module "embed:*" {
	const base64: string;
	export default base64;
}

/** Tesseract.js's self-contained ESM build (its worker is NOT used from here: the plugin hands it its own, from main.js). */
declare module "tesseract.js/dist/tesseract.esm.min.js" {
	const Tesseract: { createWorker: import("./ocr-engine").CreateWorker };
	export default Tesseract;
}
