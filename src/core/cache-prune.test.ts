import { describe, expect, it } from "vitest";
import { pruneUnusedExpired, scryfallIdsInUse } from "./cache-prune";

const DAY = 24 * 60 * 60 * 1000;
const TTL = 7 * DAY;
const NOW = 100 * DAY;

describe("scryfallIdsInUse", () => {
	it("gathers the cards of every list, wantlist and deck", () => {
		const ids = scryfallIdsInUse({
			collection: [{ scryfallId: "a" }, { scryfallId: "b" }],
			wantlist: [{ scryfallId: "c" }],
			decks: [{ cards: [{ scryfallId: "d" }] }, { cards: [{ scryfallId: "a" }, { scryfallId: "e" }] }],
		});
		expect([...ids].sort()).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("ignores rows with no id, and copes with parts of the settings that are missing", () => {
		expect([...scryfallIdsInUse({ collection: [{ scryfallId: "" }, {}, { scryfallId: "x" }], decks: [{}] })]).toEqual(["x"]);
		expect(scryfallIdsInUse({}).size).toBe(0);
	});

	it("counts a card once however many rows hold it", () => {
		expect(scryfallIdsInUse({ collection: [{ scryfallId: "a" }, { scryfallId: "a" }], wantlist: [{ scryfallId: "a" }] }).size).toBe(1);
	});
});

describe("pruneUnusedExpired", () => {
	function caches(ages: Record<string, number | null>) {
		const entries = new Map<string, unknown>();
		const fetchedAt = new Map<string, number>();
		for (const [id, ageDays] of Object.entries(ages)) {
			entries.set(id, { id });
			if (ageDays !== null) fetchedAt.set(id, NOW - ageDays * DAY);
		}
		return { entries, fetchedAt };
	}

	it("removes an unused entry older than the TTL, from both maps, and says how many", () => {
		const { entries, fetchedAt } = caches({ old: 30, young: 2 });
		expect(pruneUnusedExpired(entries, fetchedAt, new Set(), NOW, TTL)).toBe(1);
		expect([...entries.keys()]).toEqual(["young"]);
		expect([...fetchedAt.keys()]).toEqual(["young"]);
	});

	it("never removes the entry of a card that is held, however old", () => {
		const { entries, fetchedAt } = caches({ held: 500, other: 500 });
		expect(pruneUnusedExpired(entries, fetchedAt, new Set(["held"]), NOW, TTL)).toBe(1);
		expect([...entries.keys()]).toEqual(["held"]);
	});

	it("keeps a fresh entry whether or not the card is held", () => {
		const { entries, fetchedAt } = caches({ a: 0, b: 6.9 });
		expect(pruneUnusedExpired(entries, fetchedAt, new Set(), NOW, TTL)).toBe(0);
		expect(entries.size).toBe(2);
	});

	it("an entry exactly as old as the TTL is expired; one millisecond younger is fresh", () => {
		const entries = new Map<string, unknown>([["edge", 1], ["fresh", 2]]);
		const fetchedAt = new Map<string, number>([["edge", NOW - TTL], ["fresh", NOW - TTL + 1]]);
		pruneUnusedExpired(entries, fetchedAt, new Set(), NOW, TTL);
		expect([...entries.keys()]).toEqual(["fresh"]);
	});

	it("an unused entry with no date is removed (it cannot be judged fresh), a held one is kept", () => {
		const { entries, fetchedAt } = caches({ dateless: null, heldDateless: null });
		expect(pruneUnusedExpired(entries, fetchedAt, new Set(["heldDateless"]), NOW, TTL)).toBe(1);
		expect([...entries.keys()]).toEqual(["heldDateless"]);
	});

	it("does nothing to empty caches, and touches nothing it was not asked to", () => {
		const { entries, fetchedAt } = caches({});
		expect(pruneUnusedExpired(entries, fetchedAt, new Set(["a"]), NOW, TTL)).toBe(0);
		const stray = new Map<string, number>([["only-a-date", NOW - 99 * DAY]]);
		pruneUnusedExpired(new Map(), stray, new Set(), NOW, TTL);
		expect(stray.size).toBe(1);
	});

	it("removes exactly the 76 % the audit found on real data, in a scaled-down model of it", () => {
		const ages: Record<string, number | null> = {};
		for (let i = 0; i < 100; i++) ages[`held${i}`] = i % 2 === 0 ? 1 : 60;
		for (let i = 0; i < 300; i++) ages[`stranger${i}`] = i < 10 ? 3 : 200;
		const { entries, fetchedAt } = caches(ages);
		const used = new Set(Object.keys(ages).filter((k) => k.startsWith("held")));
		expect(pruneUnusedExpired(entries, fetchedAt, used, NOW, TTL)).toBe(290);
		expect(entries.size).toBe(110);
	});
});
