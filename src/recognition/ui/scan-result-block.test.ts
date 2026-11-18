// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScryfallCard } from "../../api/scryfall";
import { BLOCK_MAX_EDITIONS, renderScanResultBlock, type ScanBlockDeps } from "./scan-result-block";

vi.mock("obsidian", () => ({ setIcon: (el: HTMLElement, name: string) => el.setAttribute("data-icon", name), requestUrl: vi.fn() }));
vi.mock("../../ui/option-icons", () => ({ createLanguageIcon: (el: HTMLElement, code: string) => el.setAttribute("data-flag", code) }));

// The helpers Obsidian adds to HTMLElement that the file uses, on jsdom.
beforeEach(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createEl = function (this: HTMLElement, tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }) {
		const e = document.createElement(tag);
		if (o?.cls) e.className = o.cls;
		if (o?.text) e.textContent = o.text;
		for (const [k, v] of Object.entries(o?.attr ?? {})) e.setAttribute(k, v);
		this.appendChild(e);
		return e;
	};
	const create = (tag: string) =>
		function (this: HTMLElement, o?: { cls?: string; text?: string; attr?: Record<string, string> }) {
			return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl(tag, o);
		};
	proto.createDiv = create("div");
	proto.createSpan = create("span");
	proto.addClass = function (this: HTMLElement, c: string) {
		this.classList.add(c);
	};
	proto.removeClass = function (this: HTMLElement, c: string) {
		this.classList.remove(c);
	};
	proto.hasClass = function (this: HTMLElement, c: string) {
		return this.classList.contains(c);
	};
	proto.toggleClass = function (this: HTMLElement, c: string, on: boolean) {
		this.classList.toggle(c, on);
	};
	proto.setText = function (this: HTMLElement, t: string) {
		this.textContent = t;
	};
	proto.empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
	document.body.innerHTML = "";
});

const card = (id: string, over: Partial<ScryfallCard> = {}): ScryfallCard =>
	({
		id,
		name: "Air Elemental",
		set: "lea",
		set_name: "Limited Edition Alpha",
		collector_number: id.replace(/\D/g, "") || "1",
		lang: "en",
		image_uris: { normal: `https://img/${id}.jpg`, small: `https://img/${id}-s.jpg` },
		prices: { usd: "106.39" },
		...over,
	}) as unknown as ScryfallCard;

function setup(cards: ScryfallCard[], over: Partial<ScanBlockDeps> = {}) {
	const host = document.body.appendChild(document.createElement("div"));
	const controls: { card: ScryfallCard; host: HTMLElement; remove: ReturnType<typeof vi.fn>; onAddedChange: (added: boolean) => void }[] = [];
	const onDismiss = vi.fn();
	const deps: ScanBlockDeps = {
		plugin: { settings: { priceCurrency: "usd" } } as unknown as ScanBlockDeps["plugin"],
		renderAddControl: (_block, controlHost, c, onAddedChange) => {
			const button = controlHost.createEl("button", { cls: "fake-add", text: `add ${c.id}` });
			const remove = vi.fn(() => button.remove());
			controls.push({ card: c, host: controlHost, remove, onAddedChange });
			return remove;
		},
		onDismiss,
		...over,
	};
	const block = renderScanResultBlock(host, { cards, note: "Two editions. Pick one." }, deps);
	return { host, block, controls, onDismiss };
}
const text = (host: HTMLElement, cls: string) => host.querySelector(cls)?.textContent;
const meta = (host: HTMLElement) => [text(host, ".mtg-scan-block-set"), text(host, ".mtg-scan-block-number")];

describe("renderScanResultBlock", () => {
	it("shows the most probable printing: picture, name, set, number and price, its note, and the add control for that card", () => {
		const { host, controls } = setup([card("lea46")]);
		expect(text(host, ".mtg-scan-block-name-text")).toBe("Air Elemental");
		expect(meta(host)).toEqual(["Limited Edition Alpha", "LEA #46 · $106.39"]);
		expect(host.querySelector(".mtg-scan-block-image")!.getAttribute("src")).toBe("https://img/lea46.jpg");
		expect(text(host, ".mtg-scan-block-note")).toBe("Two editions. Pick one.");
		expect(controls.map((c) => c.card.id)).toEqual(["lea46"]);
		expect(host.querySelector(".mtg-scan-block-add .fake-add")).not.toBeNull(); // the control is in the block's own slot
		expect(host.querySelector(".mtg-scan-block-editions")).toBeNull(); // one printing: nothing to choose
		expect(host.querySelector(".mtg-scan-block-strip")).toBeNull();
	});

	it("leaves the price out when the card has none, and falls back to the set code when it has no set name", () => {
		const { host } = setup([card("lea46", { prices: {} as ScryfallCard["prices"], set_name: "" })]);
		expect(meta(host)).toEqual(["LEA", "LEA #46"]);
	});

	it("shows a placeholder for a card with no picture", () => {
		const { host } = setup([card("lea46", { image_uris: undefined })]);
		expect(host.querySelector(".mtg-scan-block-image.mtg-no-image")).not.toBeNull();
	});

	it("shows the flag and the printed name of a card read in another language", () => {
		const { host } = setup([card("lea46", { lang: "fr", printed_name: "Élémentaire d'air" })]);
		const flag = host.querySelector<HTMLElement>(".mtg-scan-block-lang")!;
		expect(flag.getAttribute("data-flag")).toBe("fr");
		expect(flag.getAttribute("title")).toContain("Élémentaire d'air");
		expect(flag.classList.contains("mtg-hidden")).toBe(false);
		expect(host.querySelector(".mtg-scan-block-name-text")!.getAttribute("title")).toBe("Élémentaire d'air");
	});

	it("offers the editions in a row that opens and closes, the first one selected", () => {
		const { host } = setup([card("lea46"), card("leb46", { set: "leb" }), card("2ed46", { set: "2ed", collector_number: "46" })]);
		const button = host.querySelector<HTMLElement>(".mtg-scan-block-editions")!;
		const strip = host.querySelector<HTMLElement>(".mtg-scan-block-strip")!;
		expect(button.textContent).toContain("3 editions");
		expect(strip.classList.contains("mtg-hidden")).toBe(true);
		button.click();
		expect(strip.classList.contains("mtg-hidden")).toBe(false);
		expect(button.getAttribute("aria-expanded")).toBe("true");
		expect(Array.from(strip.querySelectorAll(".mtg-scan-edition-label")).map((e) => e.textContent)).toEqual(["LEA 46", "LEB 46", "2ED 46"]);
		expect(Array.from(strip.querySelectorAll(".mtg-scan-edition")).map((e) => e.classList.contains("is-selected"))).toEqual([true, false, false]);
		button.click();
		expect(strip.classList.contains("mtg-hidden")).toBe(true);
	});

	it("changes the block to the edition chosen, and gives it its own add control, taking the first one's away", () => {
		const { host, block, controls } = setup([card("lea46"), card("leb47", { set: "leb", set_name: "Limited Edition Beta", prices: { usd: "55.00" } })]);
		host.querySelectorAll<HTMLElement>(".mtg-scan-edition")[1].click();
		expect(block.selected()).toBe(1);
		expect(meta(host)).toEqual(["Limited Edition Beta", "LEB #47 · $55.00"]);
		expect(host.querySelector(".mtg-scan-block-image")!.getAttribute("src")).toBe("https://img/leb47.jpg");
		expect(controls.map((c) => c.card.id)).toEqual(["lea46", "leb47"]);
		expect(controls[0].remove).toHaveBeenCalledTimes(1);
		expect(host.querySelectorAll(".fake-add")).toHaveLength(1);
		expect(host.querySelector(".fake-add")!.textContent).toBe("add leb47");
		expect(Array.from(host.querySelectorAll(".mtg-scan-edition")).map((e) => e.classList.contains("is-selected"))).toEqual([false, true]);
	});

	it("ignores a choice of the edition already shown or out of range", () => {
		const { block, controls } = setup([card("lea46"), card("leb47")]);
		block.select(0);
		block.select(5);
		block.select(-1);
		expect(controls).toHaveLength(1);
		expect(block.selected()).toBe(0);
	});

	it("takes the editions away once the card is added, and gives them back when it is undone; a choice meanwhile changes nothing", () => {
		const { host, block, controls } = setup([card("lea46"), card("leb47")]);
		const button = host.querySelector<HTMLElement>(".mtg-scan-block-editions")!;
		button.click();
		controls[0].onAddedChange(true);
		expect(button.classList.contains("mtg-hidden")).toBe(true);
		expect(host.querySelector(".mtg-scan-block-strip")!.classList.contains("mtg-hidden")).toBe(true);
		block.select(1);
		expect(block.selected()).toBe(0);
		expect(controls).toHaveLength(1);
		controls[0].onAddedChange(false);
		expect(button.classList.contains("mtg-hidden")).toBe(false);
		block.select(1);
		expect(block.selected()).toBe(1);
	});

	it("shows at most BLOCK_MAX_EDITIONS editions", () => {
		const many = Array.from({ length: BLOCK_MAX_EDITIONS + 6 }, (_, i) => card(`set${i}-${i + 1}`));
		const { host } = setup(many);
		expect(host.querySelectorAll(".mtg-scan-edition")).toHaveLength(BLOCK_MAX_EDITIONS);
		expect(text(host, ".mtg-scan-block-editions")).toContain(`${BLOCK_MAX_EDITIONS} editions`);
	});

	it("calls onDismiss from the ×, without the click reaching the block (which opens the card's window once it is added)", () => {
		const { host, onDismiss } = setup([card("lea46")]);
		const reached = vi.fn();
		host.querySelector(".mtg-scan-block")!.addEventListener("click", reached);
		host.querySelector<HTMLElement>(".mtg-scan-block-dismiss")!.click();
		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(reached).not.toHaveBeenCalled();
	});

	it("does not let a click on an edition reach the block either", () => {
		const { host } = setup([card("lea46"), card("leb47")]);
		const reached = vi.fn();
		host.querySelector(".mtg-scan-block")!.addEventListener("click", reached);
		host.querySelector<HTMLElement>(".mtg-scan-block-editions")!.click();
		host.querySelectorAll<HTMLElement>(".mtg-scan-edition")[1].click();
		expect(reached).not.toHaveBeenCalled();
	});
});
