// The OCR engine (Tesseract.js) run from bytes held in memory. The plugin carries its engine INSIDE main.js: the directory's policies forbid a plugin to
// install its own dependencies, so nothing here is ever downloaded. The pieces are handed in as bytes (assets.ts decodes what the build embedded) and
// reach Tesseract.js as Blob URLs; this file only knows how to wire them, so a test can hand it fake bytes and a fake `createWorker`.
// Proven in Chromium with the real engine (tools/android/probes/card-scan/embed/ocr-embed.html; docs/history/card-recognition-spike.md).
//
//  - worker script: a Blob URL (`workerBlobURL: false`: Tesseract.js must not wrap it in another);
//  - core (JavaScript + WebAssembly in one file): a Blob URL ending in "#core.js": Tesseract.js appends a file name to a path that does not end in ".js",
//    and the fragment does not change what the URL loads;
//  - the English model: also a Blob URL, and a small prelude at the top of the worker script makes the worker's `fetch` of ".../eng.traineddata" answer
//    from it (Tesseract.js has no way to take a model from memory); `langPath` is an address that does not exist, so a request that escaped would fail;
//  - the picture: an uncompressed BMP in memory (strips.ts `encodeBmp`), never a canvas (`toBlob` costs 4 s on a phone WebView).

import type { ReadLine } from "./reading";
import type { OcrReader } from "./scan";
import { ReaderUnsupportedError, wasmSimdSupported } from "./wasm-simd";

/** The three pieces of the engine, decoded: the worker script, the core, the model. */
export interface EngineAssets {
	worker: Uint8Array;
	core: Uint8Array;
	model: Uint8Array;
}

/** The part of a Tesseract.js worker this file uses. */
export interface TesseractWorkerLike {
	setParameters(params: Record<string, string>): Promise<unknown>;
	recognize(image: Uint8Array): Promise<{ data: { lines?: { text: string; bbox: { y0: number; y1: number } }[] } }>;
	terminate(): Promise<unknown>;
}
export type CreateWorker = (lang: string, oem: number, options: Record<string, unknown>) => Promise<TesseractWorkerLike>;

/** Blob URLs, behind an interface so a test can see what is made and that every one is released. */
export interface BlobUrls {
	make(data: Uint8Array | string, type: string): string;
	revoke(url: string): void;
}
export const browserBlobUrls: BlobUrls = {
	make: (data, type) => URL.createObjectURL(new Blob([data as BlobPart], { type })),
	revoke: (url) => URL.revokeObjectURL(url),
};

/** An address that exists nowhere: the model is never asked of it. */
export const UNUSED_LANG_PATH = "https://tessdata.invalid/not-used";

/**
 * Runs INSIDE the worker, before Tesseract.js's own code: answers a request for the English model from `modelUrl` and leaves every other request alone.
 * It is sent as text (`toString`), so it must not use anything outside itself.
 */
export function modelFetchPrelude(scope: { fetch: (input: string, init?: unknown) => unknown }, modelUrl: string): void {
	const original = scope.fetch;
	scope.fetch = function (input: string, init?: unknown) {
		return original.call(scope, /eng\.traineddata/.test(String(input)) ? modelUrl : input, init);
	};
}

/** The worker script with the model prelude at its top. */
export function workerSourceWithModel(workerScript: string, modelUrl: string): string {
	return `(${modelFetchPrelude.toString()})(self, ${JSON.stringify(modelUrl)});\n${workerScript}`;
}

export interface EngineLike extends OcrReader {
	stop(): Promise<void>;
}

/** A running engine: one Tesseract.js worker (about 80 MB of memory while it lives: stop it when it is not needed). */
export class OcrEngine implements EngineLike {
	private psm = "";
	private stopped = false;

	private constructor(
		private readonly worker: TesseractWorkerLike,
		private readonly urls: string[],
		private readonly blobs: BlobUrls,
	) {}

	/** `canRunWasmSimd`: asked before anything is made; false throws `ReaderUnsupportedError` (the engine would not compile on this device). */
	static async start(assets: EngineAssets, createWorker: CreateWorker, blobs: BlobUrls = browserBlobUrls, canRunWasmSimd: () => boolean = wasmSimdSupported): Promise<OcrEngine> {
		if (!canRunWasmSimd()) throw new ReaderUnsupportedError();
		const urls: string[] = [];
		const make = (data: Uint8Array | string, type: string): string => {
			const url = blobs.make(data, type);
			urls.push(url);
			return url;
		};
		try {
			const modelUrl = make(assets.model, "application/octet-stream");
			const coreUrl = make(assets.core, "text/javascript");
			const workerUrl = make(workerSourceWithModel(new TextDecoder().decode(assets.worker), modelUrl), "text/javascript");
			const worker = await createWorker("eng", 1, {
				workerPath: workerUrl,
				corePath: `${coreUrl}#core.js`,
				langPath: UNUSED_LANG_PATH,
				workerBlobURL: false,
				gzip: false,
				cacheMethod: "none",
			});
			return new OcrEngine(worker, urls, blobs);
		} catch (e) {
			for (const u of urls) blobs.revoke(u);
			throw e;
		}
	}

	async recognize(bmp: Uint8Array, psm: 6 | 7 | 11): Promise<ReadLine[]> {
		if (this.stopped) throw new Error("The OCR engine was stopped.");
		const mode = String(psm);
		if (mode !== this.psm) {
			await this.worker.setParameters({ tessedit_pageseg_mode: mode });
			this.psm = mode;
		}
		const { data } = await this.worker.recognize(bmp);
		const lines: ReadLine[] = [];
		for (const l of data.lines ?? []) {
			const text = l.text.trim();
			if (text) lines.push({ text, y0: l.bbox.y0, y1: l.bbox.y1 });
		}
		return lines;
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		try {
			await this.worker.terminate();
		} finally {
			for (const u of this.urls) this.blobs.revoke(u);
		}
	}
}

export interface IdleTimers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(id: unknown): void;
}
const windowTimers: IdleTimers = {
	setTimeout: (fn, ms) => window.setTimeout(fn, ms),
	clearTimeout: (id) => window.clearTimeout(id as number),
};

/**
 * The engine started on first use and stopped after a while without a reading (it holds about 80 MB), so that a plugin whose feature nobody uses costs
 * nothing, and one that is used does not keep a worker alive for hours. Concurrent first calls share one start; a start that failed is tried again.
 */
export class LazyOcr implements OcrReader {
	private engine: Promise<EngineLike> | null = null;
	private timer: unknown = null;
	private pinned = false;

	constructor(
		private readonly start: () => Promise<EngineLike>,
		private readonly idleMs = 60_000,
		private readonly timers: IdleTimers = windowTimers,
		/** how long a PINNED engine waits for a reading before it stops anyway (the person left the window open and walked away) */
		private readonly pinnedIdleMs = 600_000,
	) {}

	get running(): boolean {
		return this.engine !== null;
	}

	private ensureStarted(): Promise<EngineLike> {
		if (!this.engine) {
			const started = this.start();
			this.engine = started;
			started.catch(() => {
				if (this.engine === started) this.engine = null;
			});
		}
		return this.engine;
	}

	async recognize(bmp: Uint8Array, psm: 6 | 7 | 11): Promise<ReadLine[]> {
		this.cancelIdle();
		try {
			return await (await this.ensureStarted()).recognize(bmp, psm);
		} finally {
			this.armIdle();
		}
	}

	/**
	 * Starts the engine now, without a reading: the person is about to take a photo, and the engine (seconds to start on a phone) comes up while they do. Resolves when it is up,
	 * rejects when it cannot start (not kept: the next reading tries again). An engine nobody reads with stops after the idle time as ever.
	 */
	async warm(): Promise<void> {
		this.cancelIdle();
		try {
			await this.ensureStarted();
		} finally {
			this.armIdle();
		}
	}

	/** While pinned (a window that scans is open) the engine waits `pinnedIdleMs`, not `idleMs`, between readings: the pauses of a person taking photos of cards are longer than a minute. */
	pin(): void {
		this.pinned = true;
		if (this.engine) this.armIdle();
	}

	unpin(): void {
		this.pinned = false;
		if (this.engine) this.armIdle();
	}

	/** Stops the engine now (the person left the window, the plugin unloads). Safe to call when nothing runs. */
	async stop(): Promise<void> {
		this.cancelIdle();
		const running = this.engine;
		this.engine = null;
		if (running) await (await running.catch(() => null))?.stop();
	}

	private armIdle(): void {
		this.cancelIdle();
		if (this.engine) this.timer = this.timers.setTimeout(() => void this.stop(), this.pinned ? this.pinnedIdleMs : this.idleMs);
	}

	private cancelIdle(): void {
		if (this.timer !== null) this.timers.clearTimeout(this.timer);
		this.timer = null;
	}
}
