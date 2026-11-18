// @vitest-environment jsdom
// The scan of one "Add cards" window, now its own class (docs/history/public-stubs-plan.md, phase 2). It used to be ~230 lines inside AddCardsModal; these tests pin what that code did,
// with the queue, the reading panel and the engine faked (their own files have tests): when the camera button exists, what a tap prepares, what a photo shows, what closing lets go.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddCardsScanHost } from "../../card-recognition-types";
import type { ScryfallCard } from "../../api/scryfall";

const h = vi.hoisted(() => ({
	// the tests below are about a phone or tablet unless they say otherwise; a computer has the feature only where a webcam is found (availability.ts)
	platform: { isMobile: true, isMobileApp: true },
	webcamWindows: [] as Array<{ app: unknown; options: { onPhoto(p: unknown): void; onChooseFile(): void }; open: ReturnType<typeof vi.fn> }>,
	queues: [] as Array<{ list: HTMLElement; deps: Record<string, (...a: unknown[]) => unknown>; size: number; busy: boolean; add: ReturnType<typeof vi.fn>; dismiss: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>,
	prepareShared: vi.fn(),
	releaseShared: vi.fn(),
	prepareFingerprint: vi.fn(),
	releaseFingerprint: vi.fn(),
	fingerprintEnabled: vi.fn(),
	fingerprintDeps: vi.fn(),
	startCardScan: vi.fn(),
	renderScanResultBlock: vi.fn(),
	engine: { name: "engine" },
}));

vi.mock("obsidian", () => ({ Platform: h.platform, setIcon: (el: HTMLElement, name: string) => el.setAttribute("data-icon", name), requestUrl: vi.fn() }));
vi.mock("../shared", () => ({ prepareSharedCardRecognition: h.prepareShared, releaseSharedCardRecognition: h.releaseShared, sharedCardRecognition: () => h.engine }));
vi.mock("./fingerprint-base", () => ({
	fingerprintEnabled: h.fingerprintEnabled,
	prepareFingerprint: h.prepareFingerprint,
	releaseFingerprint: h.releaseFingerprint,
	fingerprintDeps: h.fingerprintDeps,
}));
vi.mock("./card-scan", () => ({ startCardScan: h.startCardScan }));
vi.mock("./webcam-capture", () => ({
	WebcamCaptureModal: class {
		open = vi.fn();
		constructor(
			public app: unknown,
			public options: { onPhoto(p: unknown): void; onChooseFile(): void },
		) {
			h.webcamWindows.push(this as never);
		}
	},
}));
vi.mock("./scan-result-block", () => ({ renderScanResultBlock: h.renderScanResultBlock }));
vi.mock("./scan-queue", () => ({
	ScanQueue: class {
		size = 0;
		busy = false;
		add = vi.fn(() => {
			this.size++;
			this.deps.onChange();
		});
		dismiss = vi.fn();
		destroy = vi.fn();
		constructor(
			public list: HTMLElement,
			public deps: Record<string, (...a: unknown[]) => unknown>,
		) {
			h.queues.push(this as never);
		}
	},
}));

import { lookForWebcam, resetWebcamForTests } from "../availability";
import { AddCardsScan } from "./add-cards-scan";

// The helpers Obsidian adds to HTMLElement that the file uses, on jsdom.
beforeEach(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createEl = function (this: HTMLElement, tag: string, o?: { cls?: string; text?: string; type?: string; attr?: Record<string, string> }) {
		const e = document.createElement(tag);
		if (o?.cls) e.className = o.cls;
		if (o?.text) e.textContent = o.text;
		if (o?.type) (e as HTMLInputElement).type = o.type;
		for (const [k, v] of Object.entries(o?.attr ?? {})) e.setAttribute(k, v);
		this.appendChild(e);
		return e;
	};
	const create = (tag: string) =>
		function (this: HTMLElement, o?: { cls?: string; text?: string }) {
			return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl(tag, o);
		};
	proto.createDiv = create("div");
	proto.createSpan = create("span");
	proto.addClass = function (this: HTMLElement, c: string) {
		for (const part of c.split(" ")) this.classList.add(part);
	};
	proto.removeClass = function (this: HTMLElement, c: string) {
		this.classList.remove(c);
	};
	proto.toggleClass = function (this: HTMLElement, c: string, on: boolean) {
		this.classList.toggle(c, on);
	};
	proto.setText = function (this: HTMLElement, t: string) {
		this.textContent = t;
	};
	h.queues.length = 0;
	h.webcamWindows.length = 0;
	resetWebcamForTests();
	h.platform.isMobile = true;
	h.platform.isMobileApp = true;
	for (const fn of [h.prepareShared, h.releaseShared, h.prepareFingerprint, h.releaseFingerprint, h.fingerprintEnabled, h.fingerprintDeps, h.startCardScan, h.renderScanResultBlock]) fn.mockReset();
	h.fingerprintEnabled.mockReturnValue(false);
});

function setup(enabled: boolean) {
	const topSection = document.createElement("div");
	const resultsBlock = topSection.appendChild(document.createElement("div"));
	const searchBarRow = topSection.appendChild(document.createElement("div"));
	const renderAddControl = vi.fn(() => () => {});
	const host = {
		plugin: { app: { name: "app" }, settings: { cardRecognitionEnabled: enabled } },
		topSection,
		resultsBlock,
		renderAddControl,
		updateAddAllButtonState: vi.fn(),
	} as unknown as AddCardsScanHost;
	const scan = new AddCardsScan(host);
	return { scan, host, topSection, resultsBlock, searchBarRow, renderAddControl };
}

const file = () => new Blob(["x"], { type: "image/jpeg" });
const choose = (input: HTMLInputElement, f: Blob) => {
	Object.defineProperty(input, "files", { value: [f], configurable: true });
	input.dispatchEvent(new Event("change"));
};

describe("the camera button", () => {
	it("is not drawn while the setting is off", () => {
		const { scan, searchBarRow } = setup(false);
		scan.mountCameraButton(searchBarRow);
		expect(searchBarRow.children.length).toBe(0);
		expect(searchBarRow.classList.contains("has-scan-btn")).toBe(false);
	});

	it("is an image file input then a camera button when it is on, and the input asks for the rear camera", () => {
		const { scan, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		expect(searchBarRow.classList.contains("has-scan-btn")).toBe(true);
		const [input, button] = Array.from(searchBarRow.children) as [HTMLInputElement, HTMLButtonElement];
		expect(input.tagName).toBe("INPUT");
		expect(input.type).toBe("file");
		expect(input.getAttribute("accept")).toBe("image/*");
		expect(input.getAttribute("capture")).toBe("environment");
		expect(button.tagName).toBe("BUTTON");
		expect(button.getAttribute("data-icon")).toBe("camera");
		expect(button.getAttribute("aria-label")).toBe("Add a card from a photo (beta)");
	});

	it("is not drawn on a computer where no webcam is found, even with the setting on there", () => {
		h.platform.isMobileApp = false;
		h.platform.isMobile = false;
		const { scan, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		expect(searchBarRow.children.length).toBe(0);
		expect(searchBarRow.classList.contains("has-scan-btn")).toBe(false);
	});

	it("is not drawn in a computer's mobile emulation without a webcam either: it is still a computer", () => {
		h.platform.isMobileApp = false;
		h.platform.isMobile = true;
		const { scan, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		expect(searchBarRow.children.length).toBe(0);
	});

	it("is drawn on a computer where a webcam is found, once the setting is on", async () => {
		h.platform.isMobileApp = false;
		h.platform.isMobile = false;
		await lookForWebcam({ enumerateDevices: async () => [{ kind: "videoinput" }] });
		const off = setup(false);
		off.scan.mountCameraButton(off.searchBarRow);
		expect(off.searchBarRow.children.length).toBe(0);
		const on = setup(true);
		on.scan.mountCameraButton(on.searchBarRow);
		expect(on.searchBarRow.classList.contains("has-scan-btn")).toBe(true);
		expect((on.searchBarRow.lastElementChild as HTMLElement).getAttribute("data-icon")).toBe("camera");
	});
});

describe("the camera button on a computer with a webcam", () => {
	async function computer() {
		h.platform.isMobileApp = false;
		h.platform.isMobile = false;
		await lookForWebcam({ enumerateDevices: async () => [{ kind: "videoinput" }] });
		const ctx = setup(true);
		ctx.scan.mountCameraButton(ctx.searchBarRow);
		const input = ctx.searchBarRow.firstElementChild as HTMLInputElement;
		const click = vi.spyOn(input, "click").mockImplementation(() => {});
		return { ...ctx, input, click, button: ctx.searchBarRow.lastElementChild as HTMLElement };
	}

	it("opens the webcam window, not the file chooser, and warms the reader as on a phone", async () => {
		const { button, click } = await computer();
		button.click();
		expect(h.webcamWindows).toHaveLength(1);
		expect(h.webcamWindows[0].open).toHaveBeenCalledTimes(1);
		expect(h.webcamWindows[0].app).toEqual({ name: "app" });
		expect(click).not.toHaveBeenCalled();
		expect(h.prepareShared).toHaveBeenCalledTimes(1);
	});

	it("a photo from the webcam goes into the list of scanned cards as it is: pixels, nothing to decode", async () => {
		const { button, scan } = await computer();
		button.click();
		const photo = { rgba: new Uint8ClampedArray(16), w: 2, h: 2 };
		h.webcamWindows[0].options.onPhoto(photo);
		expect(h.queues).toHaveLength(1);
		expect(h.queues[0].add).toHaveBeenCalledWith(photo);
		expect(scan.isShowingScan()).toBe(true);
	});

	it("\"Choose a photo…\" in that window opens the file chooser", async () => {
		const { button, click } = await computer();
		button.click();
		h.webcamWindows[0].options.onChooseFile();
		expect(click).toHaveBeenCalledTimes(1);
	});

	it("a file chosen that way is read like a photo from a phone", async () => {
		const { button, input } = await computer();
		button.click();
		const f = file();
		choose(input, f);
		expect(h.queues[0].add).toHaveBeenCalledWith(f);
	});

	it("\"Next photo\" and \"Retake\" open the webcam window again", async () => {
		const { button, topSection } = await computer();
		button.click();
		h.webcamWindows[0].options.onPhoto({ rgba: new Uint8ClampedArray(4), w: 1, h: 1 });
		(topSection.querySelector(".mtg-scan-queue-next") as HTMLElement).click();
		h.queues[0].deps.onRetake();
		expect(h.webcamWindows).toHaveLength(3);
		expect(h.prepareShared).toHaveBeenCalledTimes(3);
	});

	it("a photo that arrives after this window closed is let go", async () => {
		const { button, scan } = await computer();
		button.click();
		scan.close();
		h.webcamWindows[0].options.onPhoto({ rgba: new Uint8ClampedArray(4), w: 1, h: 1 });
		expect(h.queues).toHaveLength(0);
	});

	it("a phone or tablet never opens the webcam window: its button hands over to the system's camera", () => {
		const { scan, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		const click = vi.spyOn(searchBarRow.firstElementChild as HTMLInputElement, "click").mockImplementation(() => {});
		(searchBarRow.lastElementChild as HTMLElement).click();
		expect(click).toHaveBeenCalledTimes(1);
		expect(h.webcamWindows).toHaveLength(0);
	});
});

describe("starting a reading", () => {
	it("a tap warms the title reader at once when the fingerprint is off, and opens the photo chooser", () => {
		const { scan, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		const input = searchBarRow.firstElementChild as HTMLInputElement;
		const click = vi.spyOn(input, "click").mockImplementation(() => {});
		(searchBarRow.lastElementChild as HTMLElement).click();
		expect(h.prepareShared).toHaveBeenCalledTimes(1);
		expect(h.prepareFingerprint).not.toHaveBeenCalled();
		expect(click).toHaveBeenCalledTimes(1);
	});

	it("with the fingerprint on, the base loads first and the title reader is warmed only when there is no base", async () => {
		h.fingerprintEnabled.mockReturnValue(true);
		const { scan, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		vi.spyOn(searchBarRow.firstElementChild as HTMLInputElement, "click").mockImplementation(() => {});
		h.prepareFingerprint.mockResolvedValueOnce(true);
		(searchBarRow.lastElementChild as HTMLElement).click();
		await Promise.resolve();
		await Promise.resolve();
		expect(h.prepareFingerprint).toHaveBeenCalledTimes(1);
		expect(h.prepareShared).not.toHaveBeenCalled();
		h.prepareFingerprint.mockResolvedValueOnce(false);
		(searchBarRow.lastElementChild as HTMLElement).click();
		await Promise.resolve();
		await Promise.resolve();
		expect(h.prepareShared).toHaveBeenCalledTimes(1);
	});

	it("a base that answers after the window closed does not warm the title reader (nothing would release it)", async () => {
		h.fingerprintEnabled.mockReturnValue(true);
		const { scan, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		vi.spyOn(searchBarRow.firstElementChild as HTMLInputElement, "click").mockImplementation(() => {});
		let answer: (ready: boolean) => void = () => {};
		h.prepareFingerprint.mockReturnValueOnce(new Promise<boolean>((resolve) => (answer = resolve)));
		(searchBarRow.lastElementChild as HTMLElement).click();
		scan.close();
		answer(false);
		await Promise.resolve();
		await Promise.resolve();
		expect(h.prepareShared).not.toHaveBeenCalled();
	});
});

describe("the list of scanned cards", () => {
	it("is not built before the first photo, then replaces the carousel and tells \"Add all\"", () => {
		const { scan, host, topSection, resultsBlock, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		expect(h.queues.length).toBe(0);
		expect(scan.isShowingScan()).toBe(false);
		const input = searchBarRow.firstElementChild as HTMLInputElement;
		const f = file();
		choose(input, f);
		expect(h.queues.length).toBe(1);
		expect(h.queues[0].add).toHaveBeenCalledWith(f);
		expect(input.value).toBe("");
		expect(scan.isShowingScan()).toBe(true);
		expect(resultsBlock.classList.contains("mtg-hidden")).toBe(true);
		const panel = topSection.querySelector(".mtg-scan-queue") as HTMLElement;
		expect(panel.classList.contains("mtg-hidden")).toBe(false);
		expect(panel.querySelector(".mtg-scan-queue-title")?.textContent).toBe("Scanned cards");
		expect(panel.querySelector(".mtg-scan-queue-next")?.textContent).toBe("Next photo");
		expect(host.updateAddAllButtonState).toHaveBeenCalled();
		// the pill sits right before the carousel's block, hidden while the list shows
		const pill = topSection.querySelector(".mtg-scan-switch") as HTMLElement;
		expect(pill.nextElementSibling).toBe(resultsBlock);
		expect(pill.classList.contains("mtg-hidden")).toBe(true);
	});

	it("a typed search brings the carousel back and the pill offers the list again, with its count and a mark while a reading runs", () => {
		const { scan, host, topSection, resultsBlock, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		choose(searchBarRow.firstElementChild as HTMLInputElement, file());
		h.queues[0].busy = true;
		(host.updateAddAllButtonState as ReturnType<typeof vi.fn>).mockClear();
		scan.showSearchView();
		expect(scan.isShowingScan()).toBe(false);
		expect(resultsBlock.classList.contains("mtg-hidden")).toBe(false);
		expect((topSection.querySelector(".mtg-scan-queue") as HTMLElement).classList.contains("mtg-hidden")).toBe(true);
		const pill = topSection.querySelector(".mtg-scan-switch") as HTMLElement;
		expect(pill.classList.contains("mtg-hidden")).toBe(false);
		expect(pill.textContent).toBe("Scanned cards (1) …");
		expect(host.updateAddAllButtonState).toHaveBeenCalledTimes(1);
		(pill.querySelector("button") as HTMLElement).click();
		expect(scan.isShowingScan()).toBe(true);
	});

	it("does nothing before any photo (a window that never scans carries none of it)", () => {
		const { scan, host } = setup(true);
		scan.showSearchView();
		expect(host.updateAddAllButtonState).not.toHaveBeenCalled();
		expect(scan.isShowingScan()).toBe(false);
	});

	it("the last block taken away sends the person back to the search", () => {
		const { scan, resultsBlock, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		choose(searchBarRow.firstElementChild as HTMLInputElement, file());
		const queue = h.queues[0];
		queue.size = 0;
		queue.deps.onChange();
		expect(scan.isShowingScan()).toBe(false);
		expect(resultsBlock.classList.contains("mtg-hidden")).toBe(false);
	});

	it("\"Next photo\" and \"Retake\" prepare the reader and reopen the chooser", () => {
		const { scan, topSection, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		const input = searchBarRow.firstElementChild as HTMLInputElement;
		const click = vi.spyOn(input, "click").mockImplementation(() => {});
		choose(input, file());
		(topSection.querySelector(".mtg-scan-queue-next") as HTMLElement).click();
		h.queues[0].deps.onRetake();
		expect(click).toHaveBeenCalledTimes(2);
		expect(h.prepareShared).toHaveBeenCalledTimes(2);
	});
});

describe("what the queue is given", () => {
	it("starts a reading with the engine, the Scryfall lookups, the fingerprint and the item's retry", () => {
		const fp = { database: vi.fn() };
		h.fingerprintDeps.mockReturnValue(fp);
		const { scan, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		choose(searchBarRow.firstElementChild as HTMLInputElement, file());
		const el = document.createElement("div");
		const f = file();
		const onRetry = vi.fn();
		h.queues[0].deps.start(el, f, onRetry);
		expect(h.startCardScan).toHaveBeenCalledTimes(1);
		const [calledEl, calledFile, deps] = h.startCardScan.mock.calls[0];
		expect(calledEl).toBe(el);
		expect(calledFile).toBe(f);
		expect(deps.recognition()).toBe(h.engine);
		expect(deps.fingerprint).toBe(fp);
		expect(h.fingerprintDeps.mock.calls[0][1]()).toBe(h.engine); // the title reader's engine is handed to the fingerprint, for the corner of a photo it is not sure of
		expect(deps.onRetry).toBe(onRetry);
		for (const lookup of ["lookupPrintings", "lookupExact", "lookupCards", "lookupSetCards"]) expect(typeof deps[lookup]).toBe("function");
	});

	it("draws a result block whose add control is the window's own, compact and left out of \"Add all\"", () => {
		const { scan, host, searchBarRow, renderAddControl } = setup(true);
		scan.mountCameraButton(searchBarRow);
		choose(searchBarRow.firstElementChild as HTMLInputElement, file());
		const el = document.createElement("div");
		const outcome = { kind: "cards" };
		const item = { id: 1 };
		h.queues[0].deps.renderCards(el, outcome, item);
		const [calledEl, calledOutcome, deps] = h.renderScanResultBlock.mock.calls[0];
		expect(calledEl).toBe(el);
		expect(calledOutcome).toBe(outcome);
		expect(deps.plugin).toBe(host.plugin);
		const block = document.createElement("div");
		const hostEl = document.createElement("div");
		const card = { id: "c" } as ScryfallCard;
		const onAddedChange = vi.fn();
		deps.renderAddControl(block, hostEl, card, onAddedChange);
		expect(renderAddControl).toHaveBeenCalledWith(block, card, { host: hostEl, compact: true, track: false, onAddedChange });
		deps.onDismiss();
		expect(h.queues[0].dismiss).toHaveBeenCalledWith(item);
	});
});

describe("closing the window", () => {
	it("stops the readings and lets go of the reader and the base", () => {
		const { scan, searchBarRow } = setup(true);
		scan.mountCameraButton(searchBarRow);
		choose(searchBarRow.firstElementChild as HTMLInputElement, file());
		scan.close();
		expect(h.queues[0].destroy).toHaveBeenCalledTimes(1);
		expect(h.releaseShared).toHaveBeenCalledTimes(1);
		expect(h.releaseFingerprint).toHaveBeenCalledTimes(1);
		// the queue is gone: a late change of the list does not touch the dead window
		expect(() => h.queues[0].deps.onChange()).not.toThrow();
	});

	it("lets go of the reader and the base even when nothing was ever scanned (as the window always did)", () => {
		const { scan } = setup(false);
		scan.close();
		expect(h.releaseShared).toHaveBeenCalledTimes(1);
		expect(h.releaseFingerprint).toHaveBeenCalledTimes(1);
	});
});
