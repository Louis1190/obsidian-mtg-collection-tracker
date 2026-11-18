// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScryfallCard } from "../../api/scryfall";
import { parseCatalogue } from "../catalogue";
import { readWithFingerprint, type FingerprintDeps } from "../fingerprint/scan-fingerprint";
import type { PrintedInfo } from "../printed";
import type { Proposal } from "../reading";
import type { Quad } from "../card-finder";
import type { Photo, RecognitionScanOptions, ScanProgress, ScanResult } from "../scan";
import { ReaderUnsupportedError } from "../wasm-simd";
import { buildScanCards, failureMessage, lookupSetCode, MAX_SHOWN_PRINTINGS, PROPOSAL_MIN_EVIDENCE, PROPOSAL_MIN_SHARE, SCAN_TIME_LIMIT_MS, startCardScan, STRONG_TITLE_EVIDENCE, worthShowing, type CardScanDeps, type ScanRecognition } from "./card-scan";

// The image fingerprint's own tests are in src/recognition/fingerprint/: here only how the panel uses its answer.
vi.mock("../fingerprint/scan-fingerprint", () => ({ readWithFingerprint: vi.fn() }));

// The helpers Obsidian adds to HTMLElement that the file uses, on jsdom.
beforeEach(() => {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createDiv = function (this: HTMLElement, o?: { cls?: string; text?: string }) {
		const d = document.createElement("div");
		if (o?.cls) d.className = o.cls;
		if (o?.text) d.textContent = o.text;
		this.appendChild(d);
		return d;
	};
	proto.createEl = function (this: HTMLElement, tag: string, o?: { cls?: string; text?: string }) {
		const e = document.createElement(tag);
		if (o?.cls) e.className = o.cls;
		if (o?.text) e.textContent = o.text;
		this.appendChild(e);
		return e;
	};
	proto.addClass = function (this: HTMLElement, c: string) {
		this.classList.add(c);
	};
	proto.removeClass = function (this: HTMLElement, c: string) {
		this.classList.remove(c);
	};
	proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
	};
	// jsdom has no 2D canvas: a fake one that remembers what was painted, for the photo shown in the panel
	paintedPhotos.length = 0;
	(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = function (this: HTMLCanvasElement) {
		const canvas = this;
		return {
			createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
			putImageData: (image: { width: number; height: number }) => paintedPhotos.push({ canvas, w: image.width, h: image.height }),
		};
	};
	document.body.innerHTML = "";
});
const paintedPhotos: { canvas: HTMLCanvasElement; w: number; h: number }[] = [];

const ROWS = parseCatalogue(["Soul Burn\tBrûlure des âmes", "Scald\t", "Fire // Ice\tFeu // Glace"].join("\n"));
const card = (id: string, name: string, set = "xxx", collector_number = "1"): ScryfallCard => ({ id, name, lang: "en", set, collector_number }) as unknown as ScryfallCard;
// The printings of Soul Burn as Scryfall gives them, newest first: the plugin used to show the first, the card in the hand is the second
const SOUL_BURN = [card("sb-msc", "Soul Burn", "msc", "807"), card("sb-spm", "Soul Burn", "spm", "82"), card("sb-om1", "Soul Burn", "om1", "96")];
const SCALD = [card("sc-fut", "Scald", "fut", "10")];
const PRINTINGS = [...SOUL_BURN, ...SCALD];
// The token and the card that share a number in the Spider-Man set: the token is in TSPM, the card in SPM (seen on the second real phone test)
const HUMAN_CITIZEN = card("tok-citizen", "Human Citizen", "tspm", "4");
const CITY_PIGEON = card("pigeon", "City Pigeon", "spm", "4");
const EXACT_ONLY = [HUMAN_CITIZEN, CITY_PIGEON];
const printedOf = (number: string | null, set: string | null, lang: string | null = "fr", rarity: string | null = null): PrintedInfo => ({ number, set, lang, rarity });
const proposal = (owner: number, key: string, evidence: number): Proposal => ({ owner, key, evidence, reads: 2 });
const PHOTO: Photo = { rgba: new Uint8ClampedArray(4), w: 1, h: 1 };
const FRENCH_SOUL_BURN = proposal(0, "brulure des ames", 1.7);
const SCALD_PROPOSAL = proposal(1, "scald", 1.1);

function result(over: Partial<ScanResult>): ScanResult {
	return { quad: null, decision: null, proposals: [], reads: 0, stoppedBy: "plan", finder: null, printed: null, shortcut: null, ...over };
}

/** A recognition that answers `scanResult`, calling onProgress with `progress` first. */
function fakeRecognition(scanResult: ScanResult, progress: ScanProgress[] = [], duringScan?: (opts: RecognitionScanOptions) => Promise<void>) {
	const seen: RecognitionScanOptions[] = [];
	const recognition: ScanRecognition = {
		catalogueDate: "2026-11-06",
		scan: async (_photo, opts) => {
			seen.push(opts);
			for (const p of progress) opts.onProgress?.(p);
			await duringScan?.(opts);
			return { result: scanResult, rows: ROWS };
		},
	};
	return { recognition, seen };
}

function setup(scanResult: ScanResult, over: Partial<CardScanDeps> = {}, progress: ScanProgress[] = [], duringScan?: (opts: RecognitionScanOptions) => Promise<void>) {
	const panelEl = document.body.appendChild(document.createElement("div"));
	const { recognition, seen } = fakeRecognition(scanResult, progress, duringScan);
	const asked = { printings: [] as string[][], exact: [] as [string, string][], byName: [] as string[][] };
	const retry = vi.fn();
	const deps: CardScanDeps = {
		recognition: () => recognition,
		lookupPrintings: async (names) => {
			asked.printings.push(names);
			return PRINTINGS.filter((c) => names.includes(c.name));
		},
		lookupExact: async (set, number) => {
			asked.exact.push([set, number]);
			return [...PRINTINGS, ...EXACT_ONLY].find((c) => c.set === set && c.collector_number === number) ?? null;
		},
		lookupCards: async (names) => {
			asked.byName.push(names);
			return new Map(names.map((n) => [n.toLowerCase(), PRINTINGS.find((c) => c.name === n)!]));
		},
		readPhoto: async () => PHOTO,
		onRetry: retry,
		...over,
	};
	const handle = startCardScan(panelEl, new Blob(["x"]), deps);
	return { panelEl, handle, asked, retry, seen };
}

describe("buildScanCards: a card found by its title among the cards of the printed set", () => {
	const rows = [...ROWS, { english: "Shock", names: { fr: "Choc" } }];
	const SHOCK = [card("shock-spm", "Shock", "spm", "88"), card("shock-m21", "Shock", "m21", "159")];
	const RENDEZVOUS = card("rendezvous", "Romantic Rendezvous", "spm", "86"); // what the number the corner read (86 for 88) points at
	const choc = proposal(3, "choc", 2);

	it("puts the closest edition of the card the title says first, and the card at the misread number last", () => {
		const shown = buildScanCards([choc], rows, SHOCK, RENDEZVOUS, printedOf("86", "spm"));
		expect(shown.cards.map((c) => c.id)).toEqual(["shock-spm", "shock-m21", "rendezvous"]);
		expect(shown.match).toBe("close");
		expect(shown.note).toBe("The number printed on your card looked like 86: the closest edition is shown first. Check it against your card.");
		// the title was read in French: the tiles carry the language and the name printed in it
		expect(shown.cards[0]).toMatchObject({ lang: "fr", printed_name: "Choc" });
	});
});

describe("worthShowing", () => {
	it("keeps the best card always, and the others only when their evidence is a fair share of the best's and not tiny", () => {
		const best = 1.5;
		const kept = worthShowing([proposal(0, "a", best), proposal(1, "b", best * PROPOSAL_MIN_SHARE), proposal(2, "c", best * PROPOSAL_MIN_SHARE - 0.01), proposal(3, "d", 0.2)]);
		expect(kept.map((p) => p.owner)).toEqual([0, 1]);
	});
	it("keeps the best card even when its own evidence is below the floor, and nothing for no proposal", () => {
		expect(worthShowing([proposal(0, "a", PROPOSAL_MIN_EVIDENCE / 2)]).map((p) => p.owner)).toEqual([0]);
		expect(worthShowing([])).toEqual([]);
	});
	it("drops a card under the evidence floor even when it is a fair share of a weak best", () => {
		const kept = worthShowing([proposal(0, "a", 0.5), proposal(1, "b", PROPOSAL_MIN_EVIDENCE - 0.05)]);
		expect(kept.map((p) => p.owner)).toEqual([0]);
	});
});

describe("lookupSetCode", () => {
	it("is the set code read, and t + it for a token (the first letter of TSPM is the one lost most often)", () => {
		expect(lookupSetCode(printedOf("4", "spm"))).toBe("spm");
		expect(lookupSetCode(printedOf("4", "spm", "fr", "T"))).toBe("tspm");
		expect(lookupSetCode(printedOf("4", "tspm", "fr", "T"))).toBe("tspm");
		expect(lookupSetCode(printedOf("4", "spm", "fr", "C"))).toBe("spm");
	});
	it("is null for no set code or one read with too few letters, a token's included", () => {
		expect(lookupSetCode(null)).toBeNull();
		expect(lookupSetCode(printedOf("4", null))).toBeNull();
		expect(lookupSetCode(printedOf("4", "pm"))).toBeNull();
		expect(lookupSetCode(printedOf("4", "pm", "fr", "T"))).toBeNull();
	});
});

describe("buildScanCards", () => {
	it("puts the printing the card carries first and the other printings after it in Scryfall's order, and says how it was chosen", () => {
		const r = buildScanCards([FRENCH_SOUL_BURN], ROWS, SOUL_BURN, null, printedOf("82", "spm"));
		expect(r.cards.map((c) => c.id)).toEqual(["sb-spm", "sb-msc", "sb-om1"]);
		expect(r.match).toBe("exact");
		expect(r.note).toBe("Matched by the number printed on your card (SPM 82). Other editions follow.");
	});

	it("shows the printings in Scryfall's order when nothing was read, and counts them", () => {
		const r = buildScanCards([FRENCH_SOUL_BURN], ROWS, SOUL_BURN, null, null);
		expect(r.cards.map((c) => c.id)).toEqual(["sb-msc", "sb-spm", "sb-om1"]);
		expect(r.match).toBe("none");
		expect(r.note).toBe("3 editions of the possible cards from your photo. Pick the one that matches your card.");
		expect(buildScanCards([FRENCH_SOUL_BURN], ROWS, [SOUL_BURN[0]], null, null).note).toBe("1 possible card from your photo");
	});

	it("says the name was only partly read when the reader was not sure of it, and only then", () => {
		const weakOne = buildScanCards([proposal(0, "soul burn", 0.6)], ROWS, [SOUL_BURN[0]], null, null, false, true);
		expect(weakOne.note).toBe("1 possible card from your photo, but its name was only partly read. Check it against your card.");
		const weakMany = buildScanCards([proposal(0, "soul burn", 0.6)], ROWS, SOUL_BURN, null, null, false, true);
		expect(weakMany.note).toBe("3 editions of the possible cards from your photo, but the name was only partly read. Check them against your card.");
		expect(buildScanCards([proposal(0, "soul burn", 0.6)], ROWS, SOUL_BURN, null, null).note).toBe("3 editions of the possible cards from your photo. Pick the one that matches your card.");
	});

	it("keeps the corner's own note when the number matched, whatever the title", () => {
		const r = buildScanCards([proposal(0, "soul burn", 0.6)], ROWS, SOUL_BURN, null, printedOf("82", "spm"), false, true);
		expect(r.note).toBe("Matched by the number printed on your card (SPM 82). Other editions follow.");
	});

	it("says so when only the number matched, and when the number looked one digit away", () => {
		expect(buildScanCards([FRENCH_SOUL_BURN], ROWS, SOUL_BURN, null, printedOf("82", "zzz")).note).toBe("The number printed on your card (82) matches the first edition shown. Check it against your card.");
		const close = buildScanCards([FRENCH_SOUL_BURN], ROWS, SOUL_BURN, null, printedOf("83", "spm"));
		expect(close.match).toBe("close");
		expect(close.cards[0].id).toBe("sb-spm");
		expect(close.note).toBe("The number printed on your card looked like 83: the closest edition is shown first. Check it against your card.");
	});

	it("gives every printing of a card read in French the language and the printed name, and keeps an English match English", () => {
		const r = buildScanCards([FRENCH_SOUL_BURN, proposal(1, "scald", 1.1)], ROWS, PRINTINGS, null, null);
		const soul = r.cards.filter((c) => c.name === "Soul Burn");
		expect(soul).toHaveLength(3);
		expect(soul.every((c) => c.lang === "fr" && c.printed_name === "Brûlure des âmes")).toBe(true);
		const scald = r.cards.find((c) => c.name === "Scald")!;
		expect(scald.lang).toBe("en");
		expect(scald.printed_name).toBeUndefined();
	});

	it("takes the language printed on the card for an English-read title, but never for a card whose title was read in French", () => {
		const r = buildScanCards([SCALD_PROPOSAL, FRENCH_SOUL_BURN], ROWS, PRINTINGS, null, printedOf("12", null, "de"));
		expect(r.cards.find((c) => c.name === "Scald")?.lang).toBe("de");
		expect(r.cards.find((c) => c.name === "Soul Burn")?.lang).toBe("fr");
		const english = buildScanCards([SCALD_PROPOSAL], ROWS, SCALD, null, printedOf("12", null, "en"));
		expect(english.cards[0].lang).toBe("en");
	});

	it("ignores a language read with no number next to it: noise from the table or the art is not the card's language (a photo of an English card showed 13 Italian editions)", () => {
		const noise = buildScanCards([SCALD_PROPOSAL], ROWS, SCALD, null, printedOf(null, null, "it"));
		expect(noise.cards.every((c) => c.lang === "en")).toBe(true);
		const real = buildScanCards([SCALD_PROPOSAL], ROWS, SCALD, null, printedOf("12", null, "it"));
		expect(real.cards.every((c) => c.lang === "it")).toBe(true);
	});

	it("adds the printing the set code and number point at when the search did not have it, first, once", () => {
		const exact = card("sb-exact", "Soul Burn", "spm", "82");
		const r = buildScanCards([FRENCH_SOUL_BURN], ROWS, [SOUL_BURN[0], SOUL_BURN[2]], exact, printedOf("82", "spm"));
		expect(r.cards.map((c) => c.id)).toEqual(["sb-exact", "sb-msc", "sb-om1"]);
		const twice = buildScanCards([FRENCH_SOUL_BURN], ROWS, SOUL_BURN, SOUL_BURN[1], printedOf("82", "spm"));
		expect(twice.cards.map((c) => c.id)).toEqual(["sb-spm", "sb-msc", "sb-om1"]);
	});

	it("shows a printing of a card the title did not propose FIRST when the title is weak, with the language printed on the card and a note that the title does not confirm it", () => {
		const other = card("other", "Shock", "spm", "500");
		const weak = proposal(0, "brulure des ames", 0.2);
		const r = buildScanCards([weak], ROWS, SOUL_BURN, other, printedOf("500", "spm", "fr"));
		expect(r.cards[0].id).toBe("other");
		expect(r.cards[0].lang).toBe("fr");
		expect(r.cards[0].printed_name).toBeUndefined();
		expect(r.note).toBe("Matched by the number printed on your card (SPM 500), but the title does not confirm it. Check it against your card.");
		// then the printings of the proposed name: the one of the set that was read before the others
		expect(r.cards.slice(1).map((c) => c.id)).toEqual(["sb-spm", "sb-msc", "sb-om1"]);
	});

	it("puts that printing AFTER the proposed card's printings when the title is sure: a number read one digit wrong points at an unrelated card", () => {
		const other = card("other", "Shock", "spm", "500");
		const r = buildScanCards([FRENCH_SOUL_BURN], ROWS, SOUL_BURN, other, printedOf("500", "spm", "fr"));
		expect(r.cards.map((c) => c.id)).toEqual(["sb-spm", "sb-msc", "sb-om1", "other"]);
		expect(r.cards[3].lang).toBe("fr");
		expect(r.match).toBe("set");
		const exactlyAt = buildScanCards([proposal(0, "brulure des ames", STRONG_TITLE_EVIDENCE)], ROWS, SOUL_BURN, other, printedOf("500", "spm"));
		expect(exactlyAt.cards[exactlyAt.cards.length - 1].id).toBe("other"); // 1.0 is sure: the threshold is inclusive
	});

	it("shows the card at the set and number printed on it when no title was read, and says the name could not be read", () => {
		const token = card("tok", "Spider-Man", "tspm", "3");
		const r = buildScanCards([], ROWS, [], token, printedOf("3", "tspm", "fr"));
		expect(r.cards.map((c) => c.id)).toEqual(["tok"]);
		expect(r.cards[0].lang).toBe("fr");
		expect(r.match).toBe("exact");
		expect(r.note).toBe("The name could not be read: this is the card at the number printed on yours (TSPM 3). Check it against your card.");
	});

	it("finds the printings of a double-faced or split card by its whole name", () => {
		const fire = [card("fi", "Fire // Ice", "mh2", "290"), card("fi2", "Fire // Ice", "apc", "128")];
		const r = buildScanCards([proposal(2, "feu glace", 1.2)], ROWS, fire, null, printedOf("128", "apc"));
		expect(r.cards.map((c) => c.id)).toEqual(["fi2", "fi"]);
		expect(r.cards.every((c) => c.lang === "fr")).toBe(true);
	});

	it("shows at most MAX_SHOWN_PRINTINGS, the matching one among them even when it came last", () => {
		const many = Array.from({ length: 40 }, (_, i) => card(`p${i}`, "Soul Burn", "set" + (i % 9), String(100 + i)));
		many.push(card("mine", "Soul Burn", "spm", "82"));
		const r = buildScanCards([FRENCH_SOUL_BURN], ROWS, many, null, printedOf("82", "spm"));
		expect(r.cards).toHaveLength(MAX_SHOWN_PRINTINGS);
		expect(r.cards[0].id).toBe("mine");
	});

	it("does not change the cards it was given, and has nothing to show for no printing", () => {
		buildScanCards([FRENCH_SOUL_BURN], ROWS, SOUL_BURN, null, null);
		expect(SOUL_BURN[0].lang).toBe("en");
		expect(buildScanCards([FRENCH_SOUL_BURN], ROWS, [], null, null).cards).toEqual([]);
	});
});

describe("startCardScan", () => {
	it("draws a panel that waits for the reader, then follows the readings, then hands over the editions found", async () => {
		const { panelEl, handle, asked, seen } = setup(
			result({ stoppedBy: "sure", reads: 3, proposals: [FRENCH_SOUL_BURN, SCALD_PROPOSAL], printed: printedOf("82", "spm") }),
			{},
			[
				{ reads: 1, planned: 70, elapsedMs: 300, proposals: [] },
				{ reads: 35, planned: 70, elapsedMs: 9000, proposals: [] },
			],
		);
		const bar = panelEl.querySelector<HTMLElement>(".mtg-scan-bar")!;
		expect(bar.classList.contains("is-waiting")).toBe(true);
		expect(panelEl.querySelector(".mtg-scan-status")!.textContent).toBe("Starting the reader…");
		const outcome = await handle.done;
		expect(outcome.kind).toBe("cards");
		if (outcome.kind !== "cards") return;
		expect(outcome.cards.map((c) => c.id)).toEqual(["sb-spm", "sb-msc", "sb-om1", "sc-fut"]);
		expect(outcome.cards[0].lang).toBe("fr");
		expect(outcome.match).toBe("exact");
		expect(outcome.note).toContain("SPM 82");
		expect(asked.printings).toEqual([["Soul Burn", "Scald"]]);
		expect(asked.exact).toEqual([["spm", "82"]]);
		expect(asked.byName).toEqual([]); // the printings came back: no need of the way back
		expect(bar.classList.contains("is-waiting")).toBe(false);
		expect(bar.getAttribute("aria-valuenow")).toBe("100"); // the last thing it showed: every reading done, now looking the editions up
		expect(seen[0].signal).toBeDefined();
		expect(panelEl.querySelector(".mtg-scan-status")!.textContent).toBe("Looking up the editions…");
	});

	it("tells the person the name was only partly read when the reader ended with no decision, and not when it decided", async () => {
		const guess = setup(result({ stoppedBy: "plan", reads: 70, decision: null, proposals: [FRENCH_SOUL_BURN] }), {}, []);
		const weak = await guess.handle.done;
		expect(weak.kind === "cards" && weak.note).toContain("only partly read");
		const sure = setup(result({ stoppedBy: "sure", reads: 3, decision: { ...FRENCH_SOUL_BURN, sure: true }, proposals: [FRENCH_SOUL_BURN] }), {}, []);
		const decided = await sure.handle.done;
		expect(decided.kind === "cards" && decided.note).not.toContain("only partly read");
	});

	it("gives the scan the time the person is willing to wait, and no more than that", async () => {
		const { handle, seen } = setup(result({ stoppedBy: "time", proposals: [FRENCH_SOUL_BURN], reads: 40 }), {}, []);
		await handle.done;
		expect(seen[0].maxMs).toBe(SCAN_TIME_LIMIT_MS);
		expect(SCAN_TIME_LIMIT_MS).toBe(25000);
	});

	it("shows what the readings had found when the time ran out, as a guess, and fails with the way out when they had found nothing", async () => {
		const guess = await setup(result({ stoppedBy: "time", decision: null, proposals: [FRENCH_SOUL_BURN], reads: 40 }), {}, []).handle.done;
		expect(guess.kind).toBe("cards");
		expect(guess.kind === "cards" && guess.note).toContain("only partly read");
		const nothing = setup(result({ stoppedBy: "time", decision: null, proposals: [], reads: 40 }), {}, []);
		expect(await nothing.handle.done).toEqual({ kind: "failed", reason: "unreadable" });
		const text = nothing.panelEl.querySelector(".mtg-scan-status")!.textContent!;
		expect(text).toContain("closer");
		expect(text).toContain("better light");
		expect(text).toContain("search for it by name");
		expect(nothing.panelEl.querySelector(".mtg-scan-retry")).not.toBeNull();
	});

	it("moves the bar with the wait when that is further along than the readings: the plan is much longer than the time allowed", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const panelEl = document.body.appendChild(document.createElement("div"));
		const recognition: ScanRecognition = {
			catalogueDate: "2026-11-06",
			scan: async (_p, opts) => {
				opts.onProgress?.({ reads: 10, planned: 160, elapsedMs: 15000, limitMs: 25000, proposals: [] }); // 6 % of the plan, 60 % of the time
				await gate;
				return { result: result({ stoppedBy: "time" }), rows: ROWS };
			},
		};
		const handle = startCardScan(panelEl, new Blob(["x"]), { recognition: () => recognition, lookupPrintings: async () => [], lookupExact: async () => null, lookupCards: async () => new Map(), readPhoto: async () => PHOTO, onRetry: () => {} });
		// the scan starts a frame after the photo is shown, not at once
		await vi.waitFor(() => expect(panelEl.querySelector<HTMLElement>(".mtg-scan-bar")!.getAttribute("aria-valuenow")).toBe("60"));
		release();
		await handle.done;
	});

	it("moves the bar with the readings done out of the readings planned", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const panelEl = document.body.appendChild(document.createElement("div"));
		const recognition: ScanRecognition = {
			catalogueDate: "2026-11-06",
			scan: async (_p, opts) => {
				opts.onProgress?.({ reads: 14, planned: 70, elapsedMs: 4000, proposals: [] });
				await gate;
				return { result: result({ stoppedBy: "plan" }), rows: ROWS };
			},
		};
		const handle = startCardScan(panelEl, new Blob(["x"]), {
			recognition: () => recognition,
			lookupPrintings: async () => [],
			lookupExact: async () => null,
			lookupCards: async () => new Map(),
			readPhoto: async () => PHOTO,
			onRetry: () => {},
		});
		const bar = panelEl.querySelector<HTMLElement>(".mtg-scan-bar")!;
		// the scan starts a frame after the photo is shown, not at once
		await vi.waitFor(() => expect(bar.getAttribute("aria-valuenow")).toBe("20"));
		expect(bar.style.getPropertyValue("--mtg-scan-progress")).toBe("20%");
		expect(panelEl.querySelector(".mtg-scan-status")!.textContent).toBe("Reading the card's name…");
		release();
		await handle.done;
	});

	it("shows only the cards worth showing and looks up only those", async () => {
		const { handle, asked } = setup(result({ stoppedBy: "sure", proposals: [proposal(0, "soul burn", 1.5), proposal(1, "scald", 0.1)] }));
		const outcome = await handle.done;
		expect(outcome.kind === "cards" && outcome.cards.map((c) => c.id)).toEqual(["sb-msc", "sb-spm", "sb-om1"]);
		expect(asked.printings).toEqual([["Soul Burn"]]);
	});

	it("asks for the card's own set and number only when both were read and the set code is not one letter short", async () => {
		for (const printed of [null, printedOf("82", null), printedOf(null, "spm"), printedOf(null, null, "fr"), printedOf("82", "pm")]) {
			const { handle, asked } = setup(result({ stoppedBy: "sure", proposals: [FRENCH_SOUL_BURN], printed }));
			await handle.done;
			expect(asked.exact).toEqual([]);
		}
	});

	it("falls back to the card's default printing by name when the printings cannot be fetched", async () => {
		const { handle, asked } = setup(result({ stoppedBy: "sure", proposals: [FRENCH_SOUL_BURN] }), { lookupPrintings: async () => [] });
		const outcome = await handle.done;
		expect(asked.byName).toEqual([["Soul Burn"]]);
		expect(outcome.kind === "cards" && outcome.cards.map((c) => c.id)).toEqual(["sb-msc"]);
		expect(outcome.kind === "cards" && outcome.cards[0].lang).toBe("fr");
	});

	it("still shows the card's own printing when only the exact lookup answered", async () => {
		const { handle } = setup(result({ stoppedBy: "sure", proposals: [FRENCH_SOUL_BURN], printed: printedOf("82", "spm") }), {
			lookupPrintings: async () => [],
			lookupCards: async () => new Map(),
		});
		const outcome = await handle.done;
		expect(outcome.kind === "cards" && outcome.cards.map((c) => c.id)).toEqual(["sb-spm"]);
	});

	it("finds a card by the set code and number printed on it when no title could be read, without asking for any printings by name", async () => {
		const { handle, asked } = setup(result({ stoppedBy: "plan", proposals: [], printed: printedOf("82", "spm") }));
		const outcome = await handle.done;
		expect(asked.printings).toEqual([]);
		expect(asked.byName).toEqual([]);
		expect(asked.exact).toEqual([["spm", "82"]]);
		expect(outcome.kind === "cards" && outcome.cards.map((c) => c.id)).toEqual(["sb-spm"]);
		expect(outcome.kind === "cards" && outcome.note).toContain("The name could not be read");
	});

	it("finds a TOKEN by its T-prefixed set code, not the card of the same number in the plain set", async () => {
		const { handle, asked } = setup(result({ stoppedBy: "plan", proposals: [], printed: printedOf("4", "spm", "fr", "T") }));
		const outcome = await handle.done;
		expect(asked.exact).toEqual([["tspm", "4"]]);
		expect(outcome.kind === "cards" && outcome.cards.map((c) => c.id)).toEqual(["tok-citizen"]);
		expect(outcome.kind === "cards" && outcome.note).toContain("TSPM 4");
	});

	it("looks a card (not a token) up by its set code as read", async () => {
		const { handle, asked } = setup(result({ stoppedBy: "plan", proposals: [], printed: printedOf("4", "spm", "fr", "C") }));
		const outcome = await handle.done;
		expect(asked.exact).toEqual([["spm", "4"]]);
		expect(outcome.kind === "cards" && outcome.cards.map((c) => c.id)).toEqual(["pigeon"]);
	});

	it("fails as unreadable when no title was read and the corner points at nothing (no card there, or a set code under three letters)", async () => {
		expect(await setup(result({ stoppedBy: "plan", proposals: [], printed: printedOf("9999", "spm") })).handle.done).toEqual({ kind: "failed", reason: "unreadable" });
		const short = setup(result({ stoppedBy: "plan", proposals: [], printed: printedOf("82", "pm") }));
		expect(await short.handle.done).toEqual({ kind: "failed", reason: "unreadable" });
		expect(short.asked.exact).toEqual([]);
		expect(await setup(result({ stoppedBy: "plan", proposals: [], printed: null })).handle.done).toEqual({ kind: "failed", reason: "unreadable" });
	});

	it("asks Scryfall for the card the corner names ONCE: the scan confirms the title with it, the tiles put that printing first", async () => {
		let name: string | null = "unset";
		const printed = printedOf("82", "spm");
		const { handle, asked } = setup(result({ stoppedBy: "sure", proposals: [FRENCH_SOUL_BURN], printed }), {}, [], async (opts) => {
			name = (await opts.exactName?.(printed)) ?? null;
		});
		const outcome = await handle.done;
		expect(name).toBe("Soul Burn");
		expect(asked.exact).toEqual([["spm", "82"]]); // not again for the tiles
		expect(outcome.kind === "cards" && outcome.cards[0].id).toBe("sb-spm");
	});

	it("answers no name for a corner that points at no card: no set code, a short one, no number, or a card Scryfall does not have", async () => {
		const names: (string | null)[] = [];
		const { handle, asked } = setup(result({ stoppedBy: "plan", proposals: [] }), {}, [], async (opts) => {
			for (const printed of [printedOf("82", null), printedOf("82", "pm"), printedOf(null, "spm"), printedOf("9999", "spm")]) names.push((await opts.exactName?.(printed)) ?? null);
		});
		await handle.done;
		expect(names).toEqual([null, null, null, null]);
		expect(asked.exact).toEqual([["spm", "9999"]]); // only the one that could be asked, and Scryfall had nothing
	});

	it("names a token by its T-prefixed set code", async () => {
		let name: string | null = null;
		const printed = printedOf("4", "spm", "fr", "T");
		const { handle, asked } = setup(result({ stoppedBy: "sure", proposals: [], printed, shortcut: "corner-only" }), {}, [], async (opts) => {
			name = (await opts.exactName?.(printed)) ?? null;
		});
		const outcome = await handle.done;
		expect(name).toBe("Human Citizen");
		expect(asked.exact).toEqual([["tspm", "4"]]);
		expect(outcome.kind === "cards" && outcome.cards.map((c) => c.id)).toEqual(["tok-citizen"]);
		// the title was never read: the note says so, instead of saying it could not be
		expect(outcome.kind === "cards" && outcome.note).toBe("Matched by the number printed on your card (TSPM 4). Its name is not in the reader's list, so the title could not confirm it. Check it against your card.");
	});

	it("hands the scan the card list of the set the corner printed (a token's is the T-prefixed set), and none for a set code that is too short to be one", async () => {
		const lists: string[] = [];
		const lookupSetCards = vi.fn(async (set: string) => (lists.push(set), ["Shock", "Choc"]));
		let answers: (string[] | null | undefined)[] = [];
		const { handle } = setup(result({ stoppedBy: "plan", proposals: [] }), { lookupSetCards }, [], async (opts) => {
			answers = await Promise.all([printedOf("86", "spm"), printedOf("4", "spm", "fr", "T"), printedOf("86", "pm"), printedOf("86", null)].map((printed) => opts.setCards?.(printed)));
		});
		await handle.done;
		expect(lists).toEqual(["spm", "tspm"]);
		expect(answers).toEqual([["Shock", "Choc"], ["Shock", "Choc"], null, null]);
	});

	it("gives the scan no card list when the dependency is absent", async () => {
		const { handle, seen } = setup(result({ stoppedBy: "plan", proposals: [] }), { lookupSetCards: undefined });
		await handle.done;
		expect(seen[0].setCards).toBeUndefined();
	});

	it("does not wait longer than the timeout for Scryfall's answer about the corner's card: the name is null, the scan reads the title the long way, the tiles still come", async () => {
		let name: string | null = "unset";
		const printed = printedOf("82", "spm");
		const started = Date.now();
		const { handle } = setup(result({ stoppedBy: "sure", proposals: [FRENCH_SOUL_BURN], printed }), { lookupExact: () => new Promise(() => {}), exactTimeoutMs: 30 }, [], async (opts) => {
			name = (await opts.exactName?.(printed)) ?? null;
		});
		const outcome = await handle.done;
		expect(name).toBeNull();
		// the tiles come without waiting for the answer, and still rank the printing the corner points at from the printings of the name
		expect(outcome.kind === "cards" && outcome.cards.map((c) => c.id)).toEqual(["sb-spm", "sb-msc", "sb-om1"]);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("fails with a message and a retry button when no card is found, without looking anything up", async () => {
		const { panelEl, handle, asked, retry } = setup(result({ stoppedBy: "no-card" }));
		expect(await handle.done).toEqual({ kind: "failed", reason: "no-card" });
		expect(asked.printings).toEqual([]);
		expect(panelEl.querySelector(".mtg-scan-status")!.textContent).toBe(failureMessage("no-card", "2026-11-06"));
		expect(panelEl.querySelector(".mtg-scan-bar")).toBeNull();
		expect(panelEl.querySelector(".mtg-scan-cancel")).toBeNull();
		panelEl.querySelector<HTMLButtonElement>(".mtg-scan-retry")!.click();
		expect(retry).toHaveBeenCalledTimes(1);
	});

	it("fails when the card was found but nothing could be read, and when Scryfall returns none of it", async () => {
		expect(await setup(result({ stoppedBy: "plan", proposals: [] })).handle.done).toEqual({ kind: "failed", reason: "unreadable" });
		const none = setup(result({ stoppedBy: "sure", proposals: [proposal(0, "soul burn", 1.5)] }), { lookupPrintings: async () => [], lookupCards: async () => new Map() });
		expect(await none.handle.done).toEqual({ kind: "failed", reason: "unknown-cards" });
		expect(none.panelEl.querySelector(".mtg-scan-status")!.textContent).toContain("2026-11-06");
	});

	it("says in plain words that reading a name is not available when the device cannot run the engine, not the browser's own message", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const noSimd = setup(result({}), {
			recognition: () => ({
				catalogueDate: "2026-11-06",
				scan: async () => {
					throw new ReaderUnsupportedError();
				},
			}),
		});
		expect(await noSimd.handle.done).toEqual({ kind: "failed", reason: "unsupported" });
		const text = noSimd.panelEl.querySelector(".mtg-scan-status")!.textContent!;
		expect(text).toBe(failureMessage("unsupported", "2026-11-06"));
		expect(text).toContain("WebAssembly SIMD");
		expect(text).toContain("Search for the card by name");
		expect(text).not.toContain("could not run");
		// the way out is the same as for every other failure
		expect(noSimd.panelEl.querySelector(".mtg-scan-retry")).not.toBeNull();
		warn.mockRestore();
	});

	it("fails with the reason when the reader cannot run or the photo cannot be read", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const broken = setup(result({}), {
			recognition: () => ({
				catalogueDate: "2026-11-06",
				scan: async () => {
					throw new Error("no wasm here");
				},
			}),
		});
		expect(await broken.handle.done).toEqual({ kind: "failed", reason: "error" });
		expect(broken.panelEl.querySelector(".mtg-scan-status")!.textContent).toBe("The card reader could not run on this device: no wasm here");
		const unreadable = setup(result({}), {
			readPhoto: async () => {
				throw new Error("not a picture");
			},
		});
		expect(await unreadable.handle.done).toEqual({ kind: "failed", reason: "error" });
		expect(unreadable.panelEl.querySelector(".mtg-scan-status")!.textContent).toContain("not a picture");
		const nothing = setup(result({}), {
			recognition: () => {
				throw new Error("cannot even be made");
			},
		});
		expect(await nothing.handle.done).toEqual({ kind: "failed", reason: "error" });
		warn.mockRestore();
	});

	it("cancel stops the reading, removes the panel and looks nothing up", async () => {
		const panelEl = document.body.appendChild(document.createElement("div"));
		let lookups = 0;
		const recognition: ScanRecognition = {
			catalogueDate: "2026-11-06",
			scan: async (_p, opts) => {
				await new Promise((r) => setTimeout(r, 0));
				return { result: result({ stoppedBy: opts.signal!.aborted ? "cancelled" : "plan" }), rows: ROWS };
			},
		};
		const count = async () => {
			lookups++;
			return [];
		};
		const handle = startCardScan(panelEl, new Blob(["x"]), {
			recognition: () => recognition,
			lookupPrintings: count,
			lookupExact: async () => null,
			lookupCards: async () => new Map(),
			readPhoto: async () => PHOTO,
			onRetry: () => {},
		});
		panelEl.querySelector<HTMLButtonElement>(".mtg-scan-cancel")!.click();
		expect(await handle.done).toEqual({ kind: "cancelled" });
		expect(panelEl.querySelector(".mtg-scan-panel")).toBeNull();
		expect(lookups).toBe(0);
	});

	it("cancel before the photo is read never reaches the reader", async () => {
		const scan = vi.fn();
		const panelEl = document.body.appendChild(document.createElement("div"));
		const handle = startCardScan(panelEl, new Blob(["x"]), {
			recognition: () => ({ catalogueDate: "", scan }),
			lookupPrintings: async () => PRINTINGS,
			lookupExact: async () => null,
			lookupCards: async () => new Map(),
			readPhoto: async () => PHOTO,
			onRetry: () => {},
		});
		handle.cancel();
		expect(await handle.done).toEqual({ kind: "cancelled" });
		expect(scan).not.toHaveBeenCalled();
	});

	it("cancel while the editions are being looked up gives them up", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const panelEl = document.body.appendChild(document.createElement("div"));
		const handle = startCardScan(panelEl, new Blob(["x"]), {
			recognition: () => fakeRecognition(result({ stoppedBy: "sure", proposals: [proposal(0, "soul burn", 1.5)] })).recognition,
			lookupPrintings: async () => {
				await gate;
				return PRINTINGS;
			},
			lookupExact: async () => null,
			lookupCards: async () => new Map(),
			readPhoto: async () => PHOTO,
			onRetry: () => {},
		});
		await new Promise((r) => setTimeout(r, 0));
		handle.cancel();
		release();
		expect(await handle.done).toEqual({ kind: "cancelled" });
	});
});

describe("startCardScan with the image fingerprint", () => {
	const fingerprint: FingerprintDeps = { database: async () => null, lookupIllustrations: async () => [] };
	const FOUND = { cards: [card("fp-1", "Soul Burn", "spm", "82"), card("fp-2", "Soul Burn", "msc", "807")], note: "2 editions of the card in your photo. Pick the one that matches your card.", weak: false };
	const readWith = vi.mocked(readWithFingerprint);
	beforeEach(() => {
		readWith.mockReset();
	});

	function withSpy(over: Partial<CardScanDeps> = {}) {
		const started = vi.fn();
		const s = setup(result({ stoppedBy: "sure", reads: 3, proposals: [FRENCH_SOUL_BURN], printed: printedOf("82", "spm") }), {
			fingerprint,
			recognition: () => {
				started();
				return fakeRecognition(result({ stoppedBy: "sure", reads: 3, proposals: [FRENCH_SOUL_BURN], printed: printedOf("82", "spm") })).recognition;
			},
			...over,
		});
		return { ...s, started };
	}

	it("hands over what the fingerprint found, with its note, and never starts the title reader", async () => {
		readWith.mockResolvedValueOnce(FOUND);
		const { handle, started, asked } = withSpy();
		const outcome = await handle.done;
		expect(outcome).toEqual({ kind: "cards", cards: FOUND.cards, note: FOUND.note, match: "none" });
		expect(started).not.toHaveBeenCalled();
		expect(asked.printings).toEqual([]); // no lookup by name: the printings came with the illustration
		expect(readWith).toHaveBeenCalledTimes(1);
		expect(readWith.mock.calls[0][0]).toBe(PHOTO);
		expect(readWith.mock.calls[0][1]).toBe(fingerprint);
	});

	it("reads the title, as before, when the fingerprint finds nothing, and the bar starts again from waiting", async () => {
		readWith.mockImplementationOnce(async (_photo, _deps, hooks) => {
			hooks?.onProgress?.(0.7);
			return null;
		});
		const { handle, started, panelEl } = withSpy();
		const outcome = await handle.done;
		expect(started).toHaveBeenCalled();
		expect(outcome.kind).toBe("cards");
		if (outcome.kind !== "cards") return;
		expect(outcome.cards.map((c) => c.id)).toEqual(["sb-spm", "sb-msc", "sb-om1"]); // the title's proposals: Soul Burn only
		expect(outcome.match).toBe("exact");
		expect(panelEl.querySelector(".mtg-scan-bar")).not.toBeNull();
	});

	it("shows the fingerprint's status and progress in the panel while it works", async () => {
		let release: () => void = () => undefined;
		readWith.mockImplementationOnce(async (_photo, _deps, hooks) => {
			hooks?.onStatus?.("Loading the card database…");
			hooks?.onProgress?.(0.2);
			await new Promise<void>((resolve) => (release = resolve));
			return FOUND;
		});
		const { handle, panelEl } = withSpy();
		await vi.waitFor(() => expect(panelEl.querySelector(".mtg-scan-status")!.textContent).toBe("Loading the card database…"));
		expect(panelEl.querySelector(".mtg-scan-bar")!.getAttribute("aria-valuenow")).toBe("20");
		release();
		const outcome = await handle.done;
		expect(outcome.kind).toBe("cards");
		expect(panelEl.querySelector(".mtg-scan-bar")!.getAttribute("aria-valuenow")).toBe("100");
	});

	it("is cancelled while the fingerprint works, without starting the title reader", async () => {
		readWith.mockImplementationOnce((_photo, _deps, hooks) => new Promise((resolve) => hooks?.signal?.addEventListener("abort", () => resolve(null))));
		const { handle, started, panelEl } = withSpy();
		await vi.waitFor(() => expect(readWith).toHaveBeenCalled());
		handle.cancel();
		expect((await handle.done).kind).toBe("cancelled");
		expect(started).not.toHaveBeenCalled();
		expect(panelEl.querySelector(".mtg-scan-panel")).toBeNull();
	});

	it("does not call the fingerprint at all when it is not passed in", async () => {
		const { handle } = setup(result({ stoppedBy: "sure", reads: 3, proposals: [FRENCH_SOUL_BURN], printed: printedOf("82", "spm") }));
		expect((await handle.done).kind).toBe("cards");
		expect(readWith).not.toHaveBeenCalled();
	});
});

describe("startCardScan: the photo and the card outlined on it", () => {
	// a portrait photo, 600 x 800, with the card found a little inside it: the picture shown is smaller than the photo (480 on its long side), the corners stay in the photo's pixels
	const BIG: Photo = { rgba: new Uint8ClampedArray(600 * 800 * 4), w: 600, h: 800 };
	const QUAD: Quad = [
		[100, 120],
		[480, 110],
		[490, 700],
		[90, 690],
	];
	const QUAD_POINTS = "100,120 480,110 490,700 90,690";
	const readWith = vi.mocked(readWithFingerprint);
	beforeEach(() => {
		readWith.mockReset();
	});
	const sure = () => result({ stoppedBy: "sure", reads: 3, proposals: [FRENCH_SOUL_BURN], printed: printedOf("82", "spm") });
	const outlineOf = (panelEl: HTMLElement) => ({
		line: panelEl.querySelector(".mtg-scan-outline-line")?.getAttribute("points") ?? null,
		shade: panelEl.querySelector(".mtg-scan-outline-shade")?.getAttribute("points") ?? null,
		viewBox: panelEl.querySelector(".mtg-scan-outline")?.getAttribute("viewBox") ?? null,
		hint: panelEl.querySelector(".mtg-scan-hint")?.textContent ?? "",
	});

	it("shows the photo in the panel as soon as it is read, smaller than the photo, with nothing outlined yet and no hint", async () => {
		let during: ReturnType<typeof outlineOf> | null = null;
		let canvasDuring: HTMLCanvasElement | null = null;
		let panelRef: HTMLElement | null = null;
		const { panelEl, handle } = setup(sure(), { readPhoto: async () => BIG }, [], async () => {
			during = outlineOf(panelRef!);
			canvasDuring = panelRef!.querySelector<HTMLCanvasElement>(".mtg-scan-preview-photo");
		});
		panelRef = panelEl;
		await handle.done;
		expect(canvasDuring).not.toBeNull();
		expect(canvasDuring!.width).toBe(360);
		expect(canvasDuring!.height).toBe(480);
		expect(paintedPhotos.map((p) => [p.w, p.h])).toEqual([[360, 480]]);
		expect(during).toEqual({ line: null, shade: null, viewBox: null, hint: "" });
		// the picture sits between the title and the progress bar
		const order = Array.from(panelEl.querySelector(".mtg-scan-panel")!.children).map((c) => c.className);
		expect(order.indexOf("mtg-scan-preview")).toBeGreaterThan(order.indexOf("mtg-scan-title"));
		expect(order.indexOf("mtg-scan-preview")).toBeLessThan(order.indexOf("mtg-scan-bar is-waiting") === -1 ? order.findIndex((c) => c.startsWith("mtg-scan-bar")) : order.indexOf("mtg-scan-bar is-waiting"));
	});

	it("outlines the card the title reader's finder found, in the photo's own pixels, while the reading goes on", async () => {
		let during: ReturnType<typeof outlineOf> | null = null;
		let panelRef: HTMLElement | null = null;
		const { panelEl, handle } = setup(sure(), { readPhoto: async () => BIG }, [], async (opts) => {
			opts.onQuad?.(QUAD);
			during = outlineOf(panelRef!);
		});
		panelRef = panelEl;
		await handle.done;
		expect(during).not.toBeNull();
		expect(during!.line).toBe(QUAD_POINTS);
		expect(during!.shade).toBe(QUAD_POINTS);
		expect(during!.viewBox).toBe("0 0 600 800"); // the photo's size, not the picture's (360 x 480)
		expect(during!.hint).toMatch(/retake/i);
		expect(panelEl.querySelector(".mtg-scan-preview")!.getAttribute("aria-label")).toBe("Your photo, with the card found outlined");
	});

	it("outlines the card the image fingerprint's finder found, before the fingerprint has answered", async () => {
		let during: ReturnType<typeof outlineOf> | null = null;
		let panelRef: HTMLElement | null = null;
		readWith.mockImplementationOnce(async (_photo, _deps, hooks) => {
			hooks?.onQuad?.(QUAD);
			during = outlineOf(panelRef!);
			return { cards: [card("fp-1", "Soul Burn", "spm", "82")], note: "1 possible card from your photo", weak: false };
		});
		const { panelEl, handle } = setup(sure(), { readPhoto: async () => BIG, fingerprint: { database: async () => null, lookupIllustrations: async () => [] } });
		panelRef = panelEl;
		expect((await handle.done).kind).toBe("cards");
		expect(during).toEqual({ line: QUAD_POINTS, shade: QUAD_POINTS, viewBox: "0 0 600 800", hint: expect.stringMatching(/retake/i) });
	});

	it("keeps the photo on screen, with no outline, when no card is found", async () => {
		const { panelEl, handle } = setup(result({ stoppedBy: "no-card" }), { readPhoto: async () => BIG });
		expect(await handle.done).toEqual({ kind: "failed", reason: "no-card" });
		expect(panelEl.querySelector(".mtg-scan-preview-photo")).not.toBeNull();
		expect(outlineOf(panelEl)).toEqual({ line: null, shade: null, viewBox: null, hint: "" });
	});

	it("keeps the photo and its outline when the card was found but could not be read", async () => {
		const { panelEl, handle } = setup(result({ stoppedBy: "plan", reads: 160 }), { readPhoto: async () => BIG }, [], async (opts) => opts.onQuad?.(QUAD));
		expect(await handle.done).toEqual({ kind: "failed", reason: "unreadable" });
		expect(outlineOf(panelEl).line).toBe(QUAD_POINTS);
	});

	it("takes the photo away with the panel when the reading is cancelled", async () => {
		const { panelEl, handle } = setup(result({ stoppedBy: "cancelled" }), { readPhoto: async () => BIG });
		handle.cancel();
		expect(await handle.done).toEqual({ kind: "cancelled" });
		expect(panelEl.querySelector(".mtg-scan-preview")).toBeNull();
		expect(panelEl.querySelector(".mtg-scan-hint")).toBeNull();
	});

	it("reads the photo all the same when no picture can be made of it (no 2D canvas)", async () => {
		(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => null;
		const { panelEl, handle } = setup(sure(), { readPhoto: async () => BIG }, [], async (opts) => opts.onQuad?.(QUAD));
		const outcome = await handle.done;
		expect(outcome.kind).toBe("cards");
		expect(panelEl.querySelector(".mtg-scan-preview")).toBeNull();
		expect(panelEl.querySelector(".mtg-scan-hint")).toBeNull();
	});

	it("has a Retake button that stops the reading and opens the camera again inside the same tap", async () => {
		let signal: AbortSignal | undefined;
		const { panelEl, handle, retry } = setup(sure(), { readPhoto: async () => BIG }, [], async (opts) => {
			signal = opts.signal;
			await new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve()));
		});
		await vi.waitFor(() => expect(signal).toBeDefined());
		panelEl.querySelector<HTMLButtonElement>(".mtg-scan-retake")!.click();
		expect(retry).toHaveBeenCalledTimes(1); // synchronously: a browser opens a file chooser only from a tap
		expect(signal!.aborted).toBe(true);
		expect(await handle.done).toEqual({ kind: "cancelled" });
		expect(panelEl.querySelector(".mtg-scan-panel")).toBeNull();
	});

	it("offers Retake while reading and Try another photo once it failed, never both", async () => {
		const { panelEl, handle } = setup(result({ stoppedBy: "no-card" }), { readPhoto: async () => BIG });
		expect(panelEl.querySelector(".mtg-scan-retake")).not.toBeNull();
		expect(panelEl.querySelector(".mtg-scan-retry")).toBeNull();
		await handle.done;
		expect(panelEl.querySelector(".mtg-scan-retake")).toBeNull();
		expect(panelEl.querySelector(".mtg-scan-retry")).not.toBeNull();
	});
});
