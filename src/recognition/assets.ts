// The files main.js carries for the recognition: the OCR engine (the worker script and the core, JavaScript + WebAssembly, from the pinned npm packages), the
// English model and the catalogue snapshot. The `embed:` plugin of esbuild.config.mjs gzips them at build time and puts them in the bundle as base64; this file
// decodes them on first use, not at startup. NOT imported by the tests (they need the build's plugin): they hand the other modules fake bytes.

import catalogueGz from "embed:src/recognition/assets/catalogue-snapshot.tsv.gz";
import modelGz from "embed:src/recognition/assets/eng.traineddata.gz";
import coreGz from "embed:tesseract.js-core/tesseract-core-simd-lstm.wasm.js";
import workerGz from "embed:tesseract.js/dist/worker.min.js";
import { gunzipBytes } from "../api/github";
import { base64ToBytes } from "./bytes";
import type { EngineAssets } from "./ocr-engine";

// The most each file may unpack to (a corrupt or swapped file must not fill the memory): about twice what the real ones are (0.12 MB, 3.9 MB, 4.1 MB, 1.3 MB).
const MAX_WORKER = 1 << 20;
const MAX_CORE = 8 << 20;
const MAX_MODEL = 8 << 20;
const MAX_CATALOGUE = 8 << 20;

/** The decoded OCR engine: about 8 MB in memory while it is held. */
export async function loadEngineAssets(): Promise<EngineAssets> {
	const [worker, core, model] = await Promise.all([
		gunzipBytes(base64ToBytes(workerGz), MAX_WORKER),
		gunzipBytes(base64ToBytes(coreGz), MAX_CORE),
		gunzipBytes(base64ToBytes(modelGz), MAX_MODEL),
	]);
	return { worker, core, model };
}

/** The catalogue snapshot as text (tab-separated, see catalogue.ts). */
export async function loadCatalogueText(): Promise<string> {
	return new TextDecoder().decode(await gunzipBytes(base64ToBytes(catalogueGz), MAX_CATALOGUE));
}
