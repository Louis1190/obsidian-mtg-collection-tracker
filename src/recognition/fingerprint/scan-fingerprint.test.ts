import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ScryfallCard } from "../../api/scryfall";
import type { Quad } from "../card-finder";
import { cardCorners } from "../__tests__/scenes";
import { idOf, type FingerprintDb } from "./database";
import { CORNER_TIMEOUT_MS, readWithFingerprint, type FingerprintDeps } from "./scan-fingerprint";
import { buildTestDb, renderCanvas, renderPhoto } from "./__tests__/fingerprint-scenes";

const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);
const W = 480;
const H = 640;
let db: FingerprintDb;
let photo: ReturnType<typeof renderPhoto>;
let quad: Quad;
const SEED = 37;

beforeAll(() => {
	db = buildTestDb(SEEDS, 64);
	const c = cardCorners(240, 320, 280, 391, 5);
	quad = [c[0], c[1], c[2], c[3]];
	photo = renderPhoto(SEED, quad, W, H);
});

const printing = (id: string, illustration: string, name = "Test card"): ScryfallCard => ({ id, name, set: "tst", collector_number: id, illustration_id: illustration, lang: "en" }) as unknown as ScryfallCard;
const illustrationOf = (seed: number) => idOf(db, SEEDS.indexOf(seed));

function deps(over: Partial<FingerprintDeps> = {}): FingerprintDeps & { asked: string[][] } {
	const asked: string[][] = [];
	return {
		database: async () => db,
		lookupIllustrations: async (ids) => {
			asked.push(ids);
			return [printing("only", ids[0])];
		},
		findQuad: () => quad,
		...over,
		asked,
	};
}

describe("readWithFingerprint", { timeout: 60_000 }, () => {
	it("finds the illustration, asks Scryfall for the printings that carry it, and hands them over; one printing needs no pictures", async () => {
		const pixels = vi.fn(async () => null);
		const d = deps({ cardPixels: pixels });
		const status: string[] = [];
		const tiles = await readWithFingerprint(photo, d, { onStatus: (t) => status.push(t) });
		expect(d.asked).toEqual([[illustrationOf(SEED)]]);
		expect(tiles?.cards.map((c) => c.id)).toEqual(["only"]);
		expect(tiles?.note).toMatch(/^1 possible card from your photo/);
		expect(pixels).not.toHaveBeenCalled();
		expect(status).toEqual(["Loading the card database…", "Looking for the card…", "Looking up the editions…"]);
	});

	it("hands the card the finder found to onQuad as soon as it is found, before the base is searched, and not when there is no card", async () => {
		const events: string[] = [];
		const found: unknown[] = [];
		await readWithFingerprint(
			photo,
			deps({
				findQuad: () => (events.push("find"), quad),
				lookupIllustrations: async (ids) => (events.push("lookup"), [printing("only", ids[0])]),
			}),
			{ onQuad: (q) => (events.push("quad"), found.push(q)) },
		);
		expect(found).toEqual([quad]);
		expect(events).toEqual(["find", "quad", "lookup"]);
		const none: unknown[] = [];
		await readWithFingerprint(photo, deps({ findQuad: () => null }), { onQuad: (q) => none.push(q) });
		expect(none).toEqual([]);
	});

	it("puts the printings that carry the illustration in the order of their look: the one that looks like the photo first", async () => {
		const il = illustrationOf(SEED);
		const sibs = [printing("dark-text", il), printing("same-look", il), printing("also-dark", il)];
		const variantOf: Record<string, number> = { "dark-text": 1, "same-look": 0, "also-dark": 1 };
		const asked: string[] = [];
		const tiles = await readWithFingerprint(photo, deps({ lookupIllustrations: async () => sibs, cardPixels: async (c) => (asked.push(c.id), renderCanvas(SEED, variantOf[c.id])) }));
		expect(asked.sort()).toEqual(["also-dark", "dark-text", "same-look"]);
		expect(tiles?.cards.map((c) => c.id)[0]).toBe("same-look");
		expect(tiles?.cards.length).toBe(3);
		expect(tiles?.note).toMatch(/^3 editions of the card in your photo/);
	});

	it("keeps Scryfall's order for a printing whose picture could not be read, and when the pictures never come", async () => {
		const il = illustrationOf(SEED);
		const sibs = [printing("a", il), printing("b", il), printing("c", il)];
		const noPictures = await readWithFingerprint(photo, deps({ lookupIllustrations: async () => sibs, cardPixels: async () => null }));
		expect(noPictures?.cards.map((c) => c.id)).toEqual(["a", "b", "c"]);
		const slow = await readWithFingerprint(photo, deps({ lookupIllustrations: async () => sibs, cardPixels: () => new Promise(() => undefined) }), { pixelsTimeoutMs: 20 });
		expect(slow?.cards.map((c) => c.id)).toEqual(["a", "b", "c"]);
		const throwing = await readWithFingerprint(photo, deps({ lookupIllustrations: async () => sibs, cardPixels: async (c) => (c.id === "b" ? renderCanvas(SEED) : Promise.reject(new Error("x"))) }));
		expect(throwing?.cards[0].id).toBe("b"); // the only one that could be read looks like the photo; the others keep their order after it
	});

	it("answers null (the title is read instead) when there is no base, no card in the photo, no answer from Scryfall or a failure anywhere", async () => {
		expect(await readWithFingerprint(photo, deps({ database: async () => null }))).toBeNull();
		expect(await readWithFingerprint(photo, deps({ findQuad: () => null }))).toBeNull();
		expect(await readWithFingerprint(photo, deps({ lookupIllustrations: async () => [] }))).toBeNull();
		expect(await readWithFingerprint(photo, deps({ lookupIllustrations: () => new Promise(() => undefined) }), { lookupTimeoutMs: 20 })).toBeNull();
		expect(await readWithFingerprint(photo, deps({ lookupIllustrations: () => Promise.reject(new Error("offline")) }))).toBeNull();
		expect(await readWithFingerprint(photo, deps({ database: () => Promise.reject(new Error("disk")) }))).toBeNull();
	});

	it("stops, answering null, when the person cancelled", async () => {
		const gone = new AbortController();
		gone.abort();
		const d = deps();
		expect(await readWithFingerprint(photo, d, { signal: gone.signal })).toBeNull();
		expect(d.asked).toEqual([]);
		const late = new AbortController();
		const slowBase = deps({
			lookupIllustrations: async (ids) => {
				late.abort(); // cancelled while Scryfall was being asked
				return [printing("x", ids[0])];
			},
		});
		expect(await readWithFingerprint(photo, slowBase, { signal: late.signal })).toBeNull();
	});

	it("reports the base's loading as the first part of the progress bar", async () => {
		const fractions: number[] = [];
		const d = deps({
			database: async (onProgress) => {
				onProgress?.(0, 4);
				onProgress?.(2, 4);
				onProgress?.(4, 4);
				return db;
			},
		});
		await readWithFingerprint(photo, d, { onProgress: (f) => fractions.push(f) });
		expect(fractions.slice(0, 3)).toEqual([0, 0.2, 0.4]);
		expect(fractions[fractions.length - 1]).toBeGreaterThanOrEqual(0.9);
		expect([...fractions].sort((a, b) => a - b)).toEqual(fractions); // never goes back
	});

	it("works with the plugin's own finder on the photo", { timeout: 60_000 }, async () => {
		const tiles = await readWithFingerprint(photo, { ...deps(), findQuad: undefined });
		expect(tiles?.cards.length).toBe(1);
	});
	describe("the card's corner, asked when the match is faint", () => {
		const il = () => illustrationOf(SEED);
		const named = printing("named", "other-art");
		const cornerCard = (card: ScryfallCard | null = named) => vi.fn(async (_photo: unknown, _quad: unknown, _outer: boolean, _signal: AbortSignal) => card);

		it("is not asked when the best score is strong: no engine starts for a card the base is sure of", async () => {
			const corner = cornerCard();
			const tiles = await readWithFingerprint(photo, deps({ cornerCard: corner }), { cornerCheckScore: 1000 });
			expect(corner).not.toHaveBeenCalled();
			expect(tiles?.cards.map((c) => c.id)).toEqual(["only"]);
		});

		it("is asked by default for a card the base does not hold (answered a faint wrong one), and not for a card it does", async () => {
			const absent = renderPhoto(999, quad, W, H); // a picture none of the 150 cards of the test base was drawn from: its best score is about -10.8, the card of SEED about -16
			const corner = cornerCard();
			const wrongOne = await readWithFingerprint(absent, deps({ cornerCard: corner }));
			expect(corner).toHaveBeenCalledTimes(1);
			expect(wrongOne?.cards[0].id).toBe("named"); // the corner's printing is shown before the wrong card the base answered
			expect(wrongOne?.note).not.toMatch(/Test/); // no diagnostic text in a person's note
			const sure = cornerCard();
			await readWithFingerprint(photo, deps({ cornerCard: sure }));
			expect(sure).not.toHaveBeenCalled();
		});

		it("is asked, with the card the finder found, while Scryfall is asked, and its printing goes first", async () => {
			const order: string[] = [];
			const corner = vi.fn(async (_p: unknown, _q: unknown, outer: boolean) => (order.push(`corner outer=${outer}`), named));
			const tiles = await readWithFingerprint(
				photo,
				deps({
					cornerCard: corner,
					lookupIllustrations: async (ids) => (order.push("lookup"), [printing("only", ids[0])]),
				}),
				{ cornerCheckScore: -1000 },
			);
			expect(order).toEqual(["corner outer=false", "lookup"]); // started first: the two run together
			expect(corner.mock.calls[0][1]).toEqual(quad);
			expect(tiles?.cards.map((c) => c.id)).toEqual(["named", "only"]);
			expect(tiles?.note).toMatch(/^Matched by the number printed on your card \(TST named\), but the picture does not confirm it/);
		});

		it("tells it, with the plugin's own finder, whether the quad is the card's own edge (where the corner's text sits in it)", { timeout: 60_000 }, async () => {
			const absent = renderPhoto(999, quad, W, H);
			const corner = cornerCard();
			await readWithFingerprint(absent, { ...deps({ cornerCard: corner }), findQuad: undefined });
			expect(corner.mock.calls[0][2]).toBe(true); // a dark-bordered card on a lighter table: the finder answers the card's own edge
			expect(corner.mock.calls[0][1]).not.toEqual(quad); // the finder's own quad, not the one the other tests hand in
		});

		it("says the picture agrees when the corner's printing carries the illustration found", async () => {
			const same = printing("same-art", il());
			const tiles = await readWithFingerprint(photo, deps({ cornerCard: cornerCard(same), lookupIllustrations: async (ids) => [printing("only", ids[0]), same] }), { cornerCheckScore: -1000 });
			expect(tiles?.cards[0].id).toBe("same-art");
			expect(tiles?.note).toMatch(/and the picture agrees\./);
			expect(tiles?.weak).toBe(false);
		});

		it("keeps the fingerprint's tiles when the corner names no card, fails, or is too slow", async () => {
			for (const cornerCardDep of [cornerCard(null), vi.fn(() => Promise.reject(new Error("engine"))), vi.fn(() => new Promise<ScryfallCard | null>(() => undefined))]) {
				const tiles = await readWithFingerprint(photo, deps({ cornerCard: cornerCardDep }), { cornerCheckScore: -1000, cornerTimeoutMs: 20 });
				expect(tiles?.cards.map((c) => c.id)).toEqual(["only"]);
				expect(tiles?.note).toMatch(/^1 possible card from your photo/);
			}
			expect(CORNER_TIMEOUT_MS).toBeGreaterThan(3000); // an engine that has to start is given time
		});

		it("is stopped when the scan ends, and when the person cancels", async () => {
			let seen: AbortSignal | undefined;
			const slow = vi.fn((_p: unknown, _q: unknown, _o: boolean, signal: AbortSignal) => ((seen = signal), new Promise<ScryfallCard | null>(() => undefined)));
			await readWithFingerprint(photo, deps({ cornerCard: slow }), { cornerCheckScore: -1000, cornerTimeoutMs: 20 });
			expect(seen?.aborted).toBe(true); // the scan finished without it: its reading is told to stop
			const gone = new AbortController();
			let during: AbortSignal | undefined;
			const hanging = vi.fn((_p: unknown, _q: unknown, _o: boolean, signal: AbortSignal) => ((during = signal), new Promise<ScryfallCard | null>(() => undefined)));
			const run = readWithFingerprint(photo, deps({ cornerCard: hanging, lookupIllustrations: async (ids) => (gone.abort(), [printing("only", ids[0])]) }), { cornerCheckScore: -1000, signal: gone.signal });
			expect(await run).toBeNull();
			expect(during?.aborted).toBe(true);
		});
	});
});
