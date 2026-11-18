import { describe, expect, it } from "vitest";
import { LazyOcr, modelFetchPrelude, OcrEngine, UNUSED_LANG_PATH, workerSourceWithModel, type BlobUrls, type CreateWorker, type EngineAssets, type EngineLike, type IdleTimers, type TesseractWorkerLike } from "./ocr-engine";
import { ReaderUnsupportedError } from "./wasm-simd";

const enc = new TextEncoder();
const assets: EngineAssets = { worker: enc.encode("/* worker */ self.onmessage = () => {};"), core: enc.encode("/* core */"), model: Uint8Array.from([1, 2, 3, 4]) };

/** Blob URLs that remember what they were made from and what was released. */
function fakeBlobs() {
	const made: { url: string; data: Uint8Array | string; type: string }[] = [];
	const revoked: string[] = [];
	const blobs: BlobUrls = {
		make: (data, type) => {
			const url = `blob:fake/${made.length}`;
			made.push({ url, data, type });
			return url;
		},
		revoke: (u) => revoked.push(u),
	};
	return { blobs, made, revoked };
}

function fakeWorker(lines: { text: string; y0: number; y1: number }[] = []) {
	const calls: string[] = [];
	const params: Record<string, string>[] = [];
	let terminated = 0;
	const worker: TesseractWorkerLike = {
		setParameters: async (p) => void params.push(p),
		recognize: async () => {
			calls.push("recognize");
			return { data: { lines: lines.map((l) => ({ text: l.text, bbox: { y0: l.y0, y1: l.y1 } })) } };
		},
		terminate: async () => void terminated++,
	};
	return { worker, calls, params, terminated: () => terminated };
}

describe("workerSourceWithModel / modelFetchPrelude", () => {
	it("puts the prelude, with the model's address, at the top of the worker script and keeps the script after it", () => {
		const src = workerSourceWithModel("WORKER_SCRIPT();", "blob:x/model");
		expect(src.endsWith("\nWORKER_SCRIPT();")).toBe(true);
		expect(src).toContain('"blob:x/model"');
		expect(src.startsWith("(")).toBe(true);
	});
	it("answers a request for the English model from the model's address and leaves every other request alone", () => {
		const asked: unknown[][] = [];
		const scope = {
			fetch(input: string, init?: unknown): unknown {
				asked.push([input, init]);
				return "response";
			},
		};
		modelFetchPrelude(scope, "blob:x/model");
		expect(scope.fetch("https://anywhere/4.0.0/eng.traineddata", { a: 1 })).toBe("response");
		expect(scope.fetch("https://anywhere/other.json")).toBe("response");
		expect(asked).toEqual([
			["blob:x/model", { a: 1 }],
			["https://anywhere/other.json", undefined],
		]);
	});
});

describe("OcrEngine.start", () => {
	it("hands Tesseract.js the worker, the core and the model as Blob URLs, from memory, with no cache and no real address", async () => {
		const { blobs, made } = fakeBlobs();
		const w = fakeWorker();
		let seen: { lang: string; oem: number; options: Record<string, unknown> } | null = null;
		const createWorker: CreateWorker = async (lang, oem, options) => {
			seen = { lang, oem, options };
			return w.worker;
		};
		await OcrEngine.start(assets, createWorker, blobs);
		expect(seen!.lang).toBe("eng");
		expect(seen!.oem).toBe(1);
		const o = seen!.options;
		expect(o.workerBlobURL).toBe(false);
		expect(o.gzip).toBe(false);
		expect(o.cacheMethod).toBe("none");
		expect(o.langPath).toBe(UNUSED_LANG_PATH);
		expect(String(o.langPath)).toContain(".invalid");
		const byUrl = (u: string) => made.find((m) => m.url === u)!;
		expect(String(o.corePath).endsWith("#core.js")).toBe(true);
		expect(byUrl(String(o.corePath).replace("#core.js", "")).data).toBe(assets.core);
		expect(byUrl(String(o.corePath).replace("#core.js", "")).type).toBe("text/javascript");
		const workerBlob = byUrl(String(o.workerPath));
		expect(workerBlob.type).toBe("text/javascript");
		expect(String(workerBlob.data)).toContain("self.onmessage");
		const model = made.find((m) => m.data === assets.model)!;
		expect(model.type).toBe("application/octet-stream");
		expect(String(workerBlob.data)).toContain(JSON.stringify(model.url)); // the worker's prelude points at the model
	});

	it("refuses at once, before decoding or creating anything, on a device that cannot run WebAssembly SIMD", async () => {
		const { blobs, made } = fakeBlobs();
		let workers = 0;
		const createWorker: CreateWorker = async () => {
			workers++;
			return fakeWorker().worker;
		};
		await expect(OcrEngine.start(assets, createWorker, blobs, () => false)).rejects.toBeInstanceOf(ReaderUnsupportedError);
		expect(made).toHaveLength(0);
		expect(workers).toBe(0);
		// the same call on a device that can run it starts as always
		await OcrEngine.start(assets, createWorker, blobs, () => true);
		expect(workers).toBe(1);
	});

	it("checks this machine's own engine by default (node has SIMD, so it starts)", async () => {
		const { blobs } = fakeBlobs();
		const engine = await OcrEngine.start(assets, async () => fakeWorker().worker, blobs);
		await engine.stop();
	});

	it("releases every Blob URL and rethrows when the worker cannot start", async () => {
		const { blobs, made, revoked } = fakeBlobs();
		await expect(OcrEngine.start(assets, async () => Promise.reject(new Error("no wasm")), blobs)).rejects.toThrow("no wasm");
		expect(made).toHaveLength(3);
		expect(revoked.sort()).toEqual(made.map((m) => m.url).sort());
	});
});

describe("OcrEngine.recognize and stop", () => {
	it("sets the page segmentation mode only when it changes, and answers the lines read with their heights", async () => {
		const { blobs } = fakeBlobs();
		const w = fakeWorker([
			{ text: "  Soul Burn \n", y0: 10, y1: 80 },
			{ text: "   ", y0: 0, y1: 5 },
			{ text: "small print", y0: 90, y1: 110 },
		]);
		const engine = await OcrEngine.start(assets, async () => w.worker, blobs);
		const bmp = Uint8Array.from([66, 77]);
		const lines = await engine.recognize(bmp, 11);
		expect(lines).toEqual([
			{ text: "Soul Burn", y0: 10, y1: 80 },
			{ text: "small print", y0: 90, y1: 110 },
		]);
		await engine.recognize(bmp, 11);
		await engine.recognize(bmp, 7);
		await engine.recognize(bmp, 7);
		await engine.recognize(bmp, 11);
		expect(w.params.map((p) => p.tessedit_pageseg_mode)).toEqual(["11", "7", "11"]);
		expect(w.calls).toHaveLength(5);
	});

	it("copes with a reading that has no lines", async () => {
		const { blobs } = fakeBlobs();
		const w = fakeWorker();
		const engine = await OcrEngine.start(assets, async () => ({ ...w.worker, recognize: async () => ({ data: {} }) }), blobs);
		expect(await engine.recognize(Uint8Array.from([1]), 7)).toEqual([]);
	});

	it("stop ends the worker and releases every URL once, and a stopped engine refuses to read", async () => {
		const { blobs, made, revoked } = fakeBlobs();
		const w = fakeWorker();
		const engine = await OcrEngine.start(assets, async () => w.worker, blobs);
		await engine.stop();
		await engine.stop();
		expect(w.terminated()).toBe(1);
		expect(revoked.sort()).toEqual(made.map((m) => m.url).sort());
		await expect(engine.recognize(Uint8Array.from([1]), 7)).rejects.toThrow("stopped");
	});

	it("releases the URLs even when ending the worker fails", async () => {
		const { blobs, made, revoked } = fakeBlobs();
		const w = fakeWorker();
		const engine = await OcrEngine.start(assets, async () => ({ ...w.worker, terminate: async () => Promise.reject(new Error("stuck")) }), blobs);
		await expect(engine.stop()).rejects.toThrow("stuck");
		expect(revoked).toHaveLength(made.length);
	});
});

/** Timers the test drives by hand. */
function manualTimers() {
	let next = 1;
	const pending = new Map<number, { fn: () => void; ms: number }>();
	const timers: IdleTimers = {
		setTimeout: (fn, ms) => {
			pending.set(next, { fn, ms });
			return next++;
		},
		clearTimeout: (id) => void pending.delete(id as number),
	};
	return { timers, pending, fire: () => [...pending.values()].forEach((t) => t.fn()) };
}

function fakeEngine(): EngineLike & { reads: number; stopped: number } {
	const e = {
		reads: 0,
		stopped: 0,
		recognize: async () => {
			e.reads++;
			return [{ text: "x", y0: 0, y1: 60 }];
		},
		stop: async () => void e.stopped++,
	};
	return e;
}

describe("LazyOcr", () => {
	const bmp = Uint8Array.from([1]);

	it("starts nothing until the first reading, and starts once for readings that arrive together", async () => {
		let starts = 0;
		const engine = fakeEngine();
		const lazy = new LazyOcr(async () => {
			starts++;
			return engine;
		}, 1000, manualTimers().timers);
		expect(lazy.running).toBe(false);
		expect(starts).toBe(0);
		await Promise.all([lazy.recognize(bmp, 7), lazy.recognize(bmp, 7), lazy.recognize(bmp, 11)]);
		expect(starts).toBe(1);
		expect(engine.reads).toBe(3);
		expect(lazy.running).toBe(true);
	});

	it("passes a start that was refused (no WebAssembly SIMD) on to the reading, keeps nothing, and asks again at the next reading", async () => {
		let starts = 0;
		const lazy = new LazyOcr(async () => {
			starts++;
			if (starts === 1) throw new ReaderUnsupportedError();
			return fakeEngine();
		}, 1000, manualTimers().timers);
		await expect(lazy.recognize(bmp, 7)).rejects.toBeInstanceOf(ReaderUnsupportedError);
		expect(lazy.running).toBe(false);
		await lazy.recognize(bmp, 7);
		expect(starts).toBe(2);
	});

	it("stops the engine after the idle time without a reading, and starts a new one on the next reading", async () => {
		const m = manualTimers();
		const engines: ReturnType<typeof fakeEngine>[] = [];
		const lazy = new LazyOcr(async () => {
			const e = fakeEngine();
			engines.push(e);
			return e;
		}, 60_000, m.timers);
		await lazy.recognize(bmp, 7);
		expect([...m.pending.values()].map((t) => t.ms)).toEqual([60_000]);
		m.fire();
		await new Promise((r) => setTimeout(r, 0));
		expect(engines[0].stopped).toBe(1);
		expect(lazy.running).toBe(false);
		await lazy.recognize(bmp, 7);
		expect(engines).toHaveLength(2);
	});

	it("restarts the idle countdown at every reading (one timer pending at a time)", async () => {
		const m = manualTimers();
		const lazy = new LazyOcr(async () => fakeEngine(), 1000, m.timers);
		await lazy.recognize(bmp, 7);
		await lazy.recognize(bmp, 7);
		await lazy.recognize(bmp, 7);
		expect(m.pending.size).toBe(1);
	});

	it("tries again after a start that failed", async () => {
		let starts = 0;
		const lazy = new LazyOcr(async () => {
			starts++;
			if (starts === 1) throw new Error("no wasm");
			return fakeEngine();
		}, 1000, manualTimers().timers);
		await expect(lazy.recognize(bmp, 7)).rejects.toThrow("no wasm");
		expect(lazy.running).toBe(false);
		await expect(lazy.recognize(bmp, 7)).resolves.toHaveLength(1);
		expect(starts).toBe(2);
	});

	it("stop ends a running engine now, and does nothing when nothing runs", async () => {
		const engine = fakeEngine();
		const m = manualTimers();
		const lazy = new LazyOcr(async () => engine, 1000, m.timers);
		await lazy.stop();
		await lazy.recognize(bmp, 7);
		await lazy.stop();
		expect(engine.stopped).toBe(1);
		expect(m.pending.size).toBe(0);
		await lazy.stop();
		expect(engine.stopped).toBe(1);
	});

	it("warm starts the engine without a reading, once, and a reading then uses it", async () => {
		let starts = 0;
		const engine = fakeEngine();
		const lazy = new LazyOcr(async () => {
			starts++;
			return engine;
		}, 1000, manualTimers().timers);
		await Promise.all([lazy.warm(), lazy.warm()]);
		expect(starts).toBe(1);
		expect(lazy.running).toBe(true);
		expect(engine.reads).toBe(0);
		await lazy.recognize(bmp, 7);
		expect(starts).toBe(1);
		expect(engine.reads).toBe(1);
	});

	it("a warmed engine nobody reads with stops after the idle time", async () => {
		const m = manualTimers();
		const engine = fakeEngine();
		const lazy = new LazyOcr(async () => engine, 5000, m.timers);
		await lazy.warm();
		expect([...m.pending.values()].map((t) => t.ms)).toEqual([5000]);
		m.fire();
		await new Promise((r) => setTimeout(r, 0));
		expect(engine.stopped).toBe(1);
		expect(lazy.running).toBe(false);
	});

	it("a failed warm-up rejects, is not kept, and the next reading tries again", async () => {
		let starts = 0;
		const lazy = new LazyOcr(async () => {
			starts++;
			if (starts === 1) throw new Error("no wasm");
			return fakeEngine();
		}, 1000, manualTimers().timers);
		await expect(lazy.warm()).rejects.toThrow("no wasm");
		expect(lazy.running).toBe(false);
		await expect(lazy.recognize(bmp, 7)).resolves.toHaveLength(1);
		expect(starts).toBe(2);
	});

	it("a pinned engine waits the long idle time between readings, and goes back to the short one when unpinned", async () => {
		const m = manualTimers();
		const lazy = new LazyOcr(async () => fakeEngine(), 60_000, m.timers, 600_000);
		lazy.pin();
		await lazy.recognize(bmp, 7);
		expect([...m.pending.values()].map((t) => t.ms)).toEqual([600_000]);
		lazy.unpin();
		expect([...m.pending.values()].map((t) => t.ms)).toEqual([60_000]); // re-armed, not stacked
		lazy.pin();
		expect([...m.pending.values()].map((t) => t.ms)).toEqual([600_000]);
	});

	it("pin and unpin before anything runs start nothing and arm no timer", () => {
		const m = manualTimers();
		const lazy = new LazyOcr(async () => fakeEngine(), 1000, m.timers);
		lazy.pin();
		lazy.unpin();
		expect(lazy.running).toBe(false);
		expect(m.pending.size).toBe(0);
	});

	it("a pinned, warmed engine uses the long idle time from the start", async () => {
		const m = manualTimers();
		const lazy = new LazyOcr(async () => fakeEngine(), 60_000, m.timers, 600_000);
		lazy.pin();
		await lazy.warm();
		expect([...m.pending.values()].map((t) => t.ms)).toEqual([600_000]);
	});
});
