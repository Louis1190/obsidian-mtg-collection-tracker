// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScryfallCard } from "../../api/scryfall";
import type { PhotoSource } from "../photo-input";
import type { CardScanHandle, ScanOutcome } from "./card-scan";
import { ScanQueue, type CardsOutcome, type QueueItem, type ScanQueueDeps } from "./scan-queue";

// The helpers Obsidian adds to HTMLElement that the file uses, on jsdom.
beforeEach(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createDiv = function (this: HTMLElement, o?: { cls?: string; text?: string }) {
		return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl("div", o);
	};
	proto.createSpan = function (this: HTMLElement, o?: { cls?: string; text?: string }) {
		return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl("span", o);
	};
	proto.createEl = function (this: HTMLElement, tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }) {
		const e = document.createElement(tag);
		if (o?.cls) e.className = o.cls;
		if (o?.text) e.textContent = o.text;
		for (const [k, v] of Object.entries(o?.attr ?? {})) e.setAttribute(k, v);
		this.appendChild(e);
		return e;
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
	document.body.innerHTML = "";
});

const card = (id: string): ScryfallCard => ({ id, name: id, set: "lea", collector_number: "1", lang: "en" }) as unknown as ScryfallCard;
const cardsOutcome = (id: string): CardsOutcome => ({ kind: "cards", cards: [card(id)], note: `note ${id}`, match: "none" });

interface Reading {
	el: HTMLElement;
	file: PhotoSource;
	onRetry: () => void;
	cancel: ReturnType<typeof vi.fn>;
	finish: (outcome: ScanOutcome) => void;
}

/** A queue whose readings are played by the test: `readings[i]` is the i-th reading started, finished when the test says so. */
function setup(over: Partial<ScanQueueDeps> = {}) {
	const list = document.body.appendChild(document.createElement("div"));
	const readings: Reading[] = [];
	const rendered: { el: HTMLElement; outcome: CardsOutcome; item: QueueItem }[] = [];
	const changes = vi.fn();
	const onRetake = vi.fn();
	const deps: ScanQueueDeps = {
		start: (el, file, onRetry) => {
			let resolve!: (o: ScanOutcome) => void;
			const done = new Promise<ScanOutcome>((r) => (resolve = r));
			const cancel = vi.fn(() => resolve({ kind: "cancelled" }));
			el.createDiv({ cls: "mtg-scan-panel", text: `reading ${readings.length + 1}` });
			readings.push({ el, file, onRetry, cancel, finish: resolve });
			return { cancel, done } as CardScanHandle;
		},
		renderCards: (el, outcome, item) => {
			rendered.push({ el, outcome, item });
			el.createDiv({ cls: "mtg-scan-block", text: outcome.note });
		},
		onRetake,
		onChange: changes,
		...over,
	};
	const queue = new ScanQueue(list, deps);
	return { queue, list, readings, rendered, changes, onRetake };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const files = (n: number) => Array.from({ length: n }, (_, i) => new Blob([`photo ${i + 1}`]));
const itemTexts = (list: HTMLElement) => Array.from(list.querySelectorAll(".mtg-scan-item")).map((e) => e.textContent);

describe("ScanQueue", () => {
	it("reads one photo at a time, the oldest first, and shows the newest at the top of the list", async () => {
		const { queue, list, readings } = setup();
		const [a, b, c] = files(3);
		queue.add(a);
		queue.add(b);
		queue.add(c);
		expect(readings).toHaveLength(1); // the others wait
		expect(readings[0].file).toBe(a);
		expect(itemTexts(list)).toEqual(["Waiting for the previous photo…×", "Waiting for the previous photo…×", "reading 1"]); // newest first
		readings[0].finish(cardsOutcome("A"));
		await flush();
		expect(readings).toHaveLength(2);
		expect(readings[1].file).toBe(b);
		readings[1].finish(cardsOutcome("B"));
		await flush();
		expect(readings).toHaveLength(3);
		expect(readings[2].file).toBe(c);
	});

	it("draws what a reading found into the item, emptied, and marks it done", async () => {
		const { queue, list, readings, rendered } = setup();
		const item = queue.add(files(1)[0]);
		readings[0].finish(cardsOutcome("A"));
		await flush();
		expect(rendered).toHaveLength(1);
		expect(rendered[0].item).toBe(item);
		expect(item.state).toBe("cards");
		const el = list.querySelector(".mtg-scan-item")!;
		expect(el.classList.contains("is-done")).toBe(true);
		expect(el.classList.contains("is-reading")).toBe(false);
		expect(el.querySelector(".mtg-scan-panel")).toBeNull(); // the reading panel is gone
		expect(el.querySelector(".mtg-scan-block")!.textContent).toBe("note A");
	});

	it("keeps the failure panel and adds a × that removes the item, and the next photo still starts", async () => {
		const { queue, list, readings } = setup();
		const [a, b] = files(2);
		const first = queue.add(a);
		queue.add(b);
		readings[0].finish({ kind: "failed", reason: "no-card" });
		await flush();
		expect(first.state).toBe("failed");
		const el = list.querySelectorAll(".mtg-scan-item")[1]; // the older one is below
		expect(el.classList.contains("is-failed")).toBe(true);
		expect(el.querySelector(".mtg-scan-panel")).not.toBeNull();
		expect(readings).toHaveLength(2); // the second photo started
		el.querySelector<HTMLButtonElement>(".mtg-scan-item-dismiss")!.click();
		expect(queue.size).toBe(1);
		expect(list.querySelectorAll(".mtg-scan-item")).toHaveLength(1);
	});

	it("never starts a photo that was removed while it waited, and goes on with the next", async () => {
		const { queue, list, readings } = setup();
		const [a, b, c] = files(3);
		queue.add(a);
		queue.add(b);
		queue.add(c);
		// the waiting row of b is the middle one: its × removes it
		list.querySelectorAll(".mtg-scan-item")[1].querySelector<HTMLButtonElement>(".mtg-scan-item-dismiss")!.click();
		expect(queue.size).toBe(2);
		readings[0].finish(cardsOutcome("A"));
		await flush();
		expect(readings.map((r) => r.file)).toEqual([a, c]);
	});

	it("stops the reading of a photo that is removed, and starts the next one", async () => {
		const { queue, readings } = setup();
		const [a, b] = files(2);
		const first = queue.add(a);
		queue.add(b);
		queue.dismiss(first);
		expect(readings[0].cancel).toHaveBeenCalledTimes(1);
		await flush();
		expect(readings).toHaveLength(2);
		expect(readings[1].file).toBe(b);
		expect(queue.size).toBe(1);
	});

	it("leaves nothing behind when a reading is cancelled from its own panel, and starts the next", async () => {
		const { queue, list, readings } = setup();
		const [a, b] = files(2);
		queue.add(a);
		queue.add(b);
		readings[0].finish({ kind: "cancelled" });
		await flush();
		expect(queue.size).toBe(1);
		expect(list.querySelectorAll(".mtg-scan-item")).toHaveLength(1);
		expect(readings).toHaveLength(2);
	});

	it("drops the item and asks the window to open the camera when the panel's Retake or Try another photo is used", async () => {
		const { queue, list, readings, onRetake } = setup();
		queue.add(files(1)[0]);
		readings[0].onRetry();
		expect(queue.size).toBe(0);
		expect(list.querySelectorAll(".mtg-scan-item")).toHaveLength(0);
		expect(readings[0].cancel).toHaveBeenCalledTimes(1);
		expect(onRetake).toHaveBeenCalledTimes(1);
	});

	it("says whether something is still waiting or being read, and how many items there are", async () => {
		const { queue, readings } = setup();
		expect([queue.size, queue.busy]).toEqual([0, false]);
		queue.add(files(1)[0]);
		expect([queue.size, queue.busy]).toEqual([1, true]);
		readings[0].finish(cardsOutcome("A"));
		await flush();
		expect([queue.size, queue.busy]).toEqual([1, false]); // the block stays until it is removed
	});

	it("tells the window about every change of the list", async () => {
		const { queue, readings, changes } = setup();
		const item = queue.add(files(1)[0]);
		const afterAdd = changes.mock.calls.length;
		expect(afterAdd).toBeGreaterThanOrEqual(2); // came, then started
		readings[0].finish(cardsOutcome("A"));
		await flush();
		expect(changes.mock.calls.length).toBeGreaterThan(afterAdd);
		const before = changes.mock.calls.length;
		queue.dismiss(item);
		expect(changes.mock.calls.length).toBeGreaterThan(before);
	});

	it("stops the reading and starts nothing more once destroyed, even when a reading finishes late", async () => {
		const { queue, readings, rendered } = setup();
		queue.add(files(1)[0]);
		queue.add(files(1)[0]);
		queue.destroy();
		expect(readings[0].cancel).toHaveBeenCalledTimes(1);
		readings[0].finish(cardsOutcome("A"));
		await flush();
		expect(readings).toHaveLength(1);
		expect(rendered).toHaveLength(0);
		expect(queue.size).toBe(0);
	});
});
