// @vitest-environment jsdom
/// <reference lib="es2021.weakref" />
// What happens to a scanned PHOTO (decided 2026-11-16: it is let go once its reading ends, so that nothing is weighed down).
// The plugin never writes a photo anywhere (no file, no cache, no data.json): it lives in memory. These tests make sure it does not stay there longer than its reading: the real list of
// scanned cards (scan-queue.ts) runs the real reading panel (card-scan.ts, with the photo shown in it, scan-photo-preview.ts) with a fake engine, and once a reading has ended the file
// and the decoded pixels must be collectable by the garbage collector although the list, its items and their blocks are all still alive on screen.
import * as v8 from "node:v8";
import * as vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import type { ScryfallCard } from "../../api/scryfall";
import { parseCatalogue } from "../catalogue";
import type { PhotoSource } from "../photo-input";
import type { Photo, ScanResult } from "../scan";
import { startCardScan, type CardScanDeps } from "./card-scan";
import { ScanQueue } from "./scan-queue";

// `gc` is made available at run time, with no flag on the command line, so that `npm test` and the CI run these tests as they are
v8.setFlagsFromString("--expose-gc");
const collect = vm.runInNewContext("gc") as () => void;

beforeEach(() => {
	// the helpers Obsidian adds to HTMLElement that the files use, on jsdom
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	const make = function (this: HTMLElement, tag: string, o?: { cls?: string; text?: string }) {
		const e = document.createElement(tag);
		if (o?.cls) e.className = o.cls;
		if (o?.text) e.textContent = o.text;
		this.appendChild(e);
		return e;
	};
	proto.createEl = make;
	proto.createDiv = function (this: HTMLElement, o?: { cls?: string; text?: string }) {
		return make.call(this, "div", o);
	};
	proto.createSpan = function (this: HTMLElement, o?: { cls?: string; text?: string }) {
		return make.call(this, "span", o);
	};
	proto.addClass = function (this: HTMLElement, c: string) {
		this.classList.add(c);
	};
	proto.removeClass = function (this: HTMLElement, c: string) {
		this.classList.remove(c);
	};
	proto.empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
	proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
	};
	// jsdom has no 2D canvas
	(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ({
		createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
		putImageData: () => {},
	});
	document.body.innerHTML = "";
});

const ROWS = parseCatalogue("Scald\t");
const SCALD = { id: "sc-fut", name: "Scald", lang: "en", set: "fut", collector_number: "10" } as unknown as ScryfallCard;
const EMPTY_RESULT: ScanResult = { quad: null, decision: null, proposals: [], reads: 0, stoppedBy: "plan", finder: null, printed: null, shortcut: null };
const FOUND: ScanResult = { ...EMPTY_RESULT, proposals: [{ owner: 0, key: "scald", evidence: 1.5, reads: 3 }], quad: [[100, 100], [900, 100], [900, 1100], [100, 1100]] };
const NO_CARD: ScanResult = { ...EMPTY_RESULT, stoppedBy: "no-card" };

/** What the test keeps WEAKLY of a photo, so that holding the reference here does not itself keep it alive. */
interface Trace {
	file: WeakRef<Blob>;
	pixels: WeakRef<ArrayLike<number>> | null;
}

interface Options {
	/** the engine throws (the reader could not run) */
	fails?: boolean;
	/** the first reading does not end until `release()` is called: the photos after it wait */
	holdFirst?: boolean;
	/** something outside keeps every photo it is shown: a control, to see that the tests below really can fail */
	keep?: unknown[];
}

/** A queue that reads with the REAL panel; the engine answers `scanResult` and every photo is a 1600 x 1200 picture (7.7 MB of pixels, as a phone's), traced. */
function setup(scanResult: ScanResult, options: Options = {}) {
	const list = document.body.appendChild(document.createElement("div"));
	const traces: Trace[] = [];
	const traceOf = new WeakMap<PhotoSource, Trace>();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let readings = 0;
	const deps: CardScanDeps = {
		recognition: () => ({
			catalogueDate: "2026-11-06",
			scan: async (_photo, opts) => {
				if (options.holdFirst && readings++ === 0) await gate;
				if (options.fails) throw new Error("the reader could not run");
				if (scanResult.quad) opts.onQuad?.(scanResult.quad);
				return { result: scanResult, rows: ROWS };
			},
		}),
		lookupPrintings: async () => [SCALD],
		lookupExact: async () => null,
		lookupCards: async () => new Map(),
		readPhoto: async (file) => {
			const photo: Photo = { rgba: new Uint8ClampedArray(1600 * 1200 * 4), w: 1600, h: 1200 };
			const trace = traceOf.get(file);
			if (trace) trace.pixels = new WeakRef(photo.rgba);
			options.keep?.push(photo);
			return photo;
		},
		onRetry: () => {},
	};
	const queue = new ScanQueue(list, {
		start: (el, file, onRetry) => startCardScan(el, file, { ...deps, onRetry }),
		renderCards: (el, outcome) => el.createDiv({ cls: "mtg-scan-block", text: outcome.note }),
		onRetake: () => {},
	});
	/** Adds a photo and traces it; nothing of it is kept here. */
	const add = (): void => {
		const file = new Blob([new Uint8Array(1024)], { type: "image/jpeg" });
		const trace: Trace = { file: new WeakRef(file), pixels: null };
		traceOf.set(file, trace);
		traces.push(trace);
		queue.add(file);
	};
	return { queue, list, traces, add, release };
}

const settle = async () => {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Until every reading of the list has ended (each one waits for the next paint, which takes a frame or so). */
async function untilDone(queue: ScanQueue): Promise<void> {
	await settle();
	for (let i = 0; i < 500 && queue.busy; i++) await new Promise((resolve) => setTimeout(resolve, 20));
	await settle();
}

/** A collection frees one layer of references at a time, and a WeakRef's target lives until the end of the job that made or read it: several collections, each in a job of its own. */
async function collectAll(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		collect();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("a scanned photo is let go once its reading has ended", () => {
	it("a card found: the file and the decoded pixels are collectable while the list, the item and its block are still there", async () => {
		const { queue, list, traces, add } = setup(FOUND);
		add();
		await settle();
		expect(list.querySelector(".mtg-scan-block")).not.toBeNull(); // the reading ended with a block on screen
		await collectAll();
		expect(traces[0].pixels).not.toBeNull(); // the photo was really decoded
		expect(traces[0].pixels!.deref()).toBeUndefined();
		expect(traces[0].file.deref()).toBeUndefined();
		expect(queue.size).toBe(1); // the item is still in the list: only what belongs to the photo went
	});

	it("a reading that failed: the failure stays on screen, the photo does not stay in memory", async () => {
		const { queue, list, traces, add } = setup(FOUND, { fails: true });
		add();
		await settle();
		expect(list.querySelector(".mtg-scan-panel.is-failed")).not.toBeNull();
		await collectAll();
		expect(traces[0].pixels!.deref()).toBeUndefined();
		expect(traces[0].file.deref()).toBeUndefined();
		expect(queue.size).toBe(1);
	});

	it("a photo no card was found in: the same", async () => {
		const { list, traces, add } = setup(NO_CARD);
		add();
		await settle();
		expect(list.querySelector(".mtg-scan-panel.is-failed")).not.toBeNull();
		await collectAll();
		expect(traces[0].pixels!.deref()).toBeUndefined();
		expect(traces[0].file.deref()).toBeUndefined();
	});

	it("fifteen photos in a row: none of them is kept", async () => {
		const { queue, traces, add } = setup(FOUND);
		for (let i = 0; i < 15; i++) add();
		await untilDone(queue);
		expect(queue.busy).toBe(false);
		expect(queue.size).toBe(15);
		await collectAll();
		expect(traces).toHaveLength(15);
		expect(traces.every((t) => t.pixels !== null)).toBe(true);
		expect(traces.filter((t) => t.pixels!.deref() !== undefined)).toHaveLength(0);
		expect(traces.filter((t) => t.file.deref() !== undefined)).toHaveLength(0);
	});

	it("a photo still waiting for its turn is kept (it has not been read yet), and let go when the list is closed", async () => {
		const { queue, traces, add, release } = setup(FOUND, { holdFirst: true });
		add();
		add();
		await settle();
		await collectAll();
		expect(traces[1].file.deref()).toBeDefined(); // waiting: its photo is still needed
		queue.destroy();
		release();
		await settle();
		await collectAll();
		expect(traces[1].file.deref()).toBeUndefined();
		expect(traces[0].file.deref()).toBeUndefined();
	});

	it("an item taken away (×) lets its photo go at once", async () => {
		const { queue, list, traces, add } = setup(FOUND, { holdFirst: true });
		add();
		add();
		await settle();
		// the second photo is waiting: its × takes it away
		(list.querySelector(".mtg-scan-item.is-waiting .mtg-scan-item-dismiss") as HTMLElement).click();
		await collectAll();
		expect(queue.size).toBe(1);
		expect(traces[1].file.deref()).toBeUndefined();
	});
});

describe("the tests above can fail", () => {
	it("a photo that something still holds is still there after the collections (the control)", async () => {
		const held: unknown[] = [];
		const { traces, add } = setup(FOUND, { keep: held });
		add();
		await settle();
		await collectAll();
		expect(held).toHaveLength(1);
		expect(traces[0].pixels!.deref()).toBeDefined();
	});
});
