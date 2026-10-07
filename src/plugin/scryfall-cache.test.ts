import { beforeEach, describe, expect, it, vi } from "vitest";

// Faux réseau scripté (voir api/safe-request.test.ts) : chaque requête consomme l'étape suivante, la dernière se répète.
const net = vi.hoisted(() => ({ steps: [] as (() => unknown)[], calls: 0 }));
vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p,
	requestUrl: async () => {
		net.calls++;
		const step = net.steps.length > 1 ? net.steps.shift()! : net.steps[0];
		return step();
	},
}));
// scryfall-cache.ts n'utilise la vue que pour retrouver les vues ouvertes : sans importance ici, et la charger tirerait toute l'application.
vi.mock("../view", () => ({ MTGCollectionView: class {} }));

import { bulkFetchLegalities, fetchCardLegalities, fetchScryfallImmutableSnapshot, getCardLegalities, getScryfallImmutableSnapshots } from "./scryfall-cache";
import type MTGCollectionPlugin from "../plugin";

const transportError = () => new Error("Request Failed. ConnectException: Failed to connect");
const down = () => { throw transportError(); };
const okCollection = (cards: unknown[]) => () => ({ status: 200, json: { data: cards }, headers: {} });
const script = (...steps: (() => unknown)[]) => { net.steps = steps; };
const card = (id: string, extra: object = {}) => ({ id, legalities: { modern: "legal" }, oracle_text: "text", set: "lea", rarity: "rare", ...extra });

// Un faux plugin : les caches et les requêtes « en vol » que lisent ces fonctions, et leurs voisines réelles.
function fakePlugin() {
	const plugin = {
		legalitiesCache: new Map<string, Record<string, string>>(),
		legalitiesFetchedAt: new Map<string, number>(),
		legalitiesInFlight: new Map<string, Promise<Record<string, string> | null>>(),
		scryfallImmutableCache: new Map<string, unknown>(),
		scryfallImmutableInFlight: new Map<string, Promise<unknown>>(),
		scheduleLegalitiesPersist: vi.fn(),
		scheduleMapCachePersist: vi.fn(),
		isLegalitiesFresh: (id: string) => plugin.legalitiesCache.has(id),
		fetchCardLegalities,
		fetchScryfallImmutableSnapshot,
	};
	return plugin as unknown as MTGCollectionPlugin & typeof plugin;
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { net.steps = []; net.calls = 0; });

describe("a network failure is an unavailable card, not a rejected promise", () => {
	it("legalities: null after the retry, nothing cached, and the next try is not blocked", async () => {
		const plugin = fakePlugin();
		script(down);
		await expect(getCardLegalities.call(plugin, "c1")).resolves.toBeNull();
		await settle();
		expect(plugin.legalitiesCache.size).toBe(0);
		expect(plugin.legalitiesInFlight.size).toBe(0);
		// la connexion revient : la même carte est demandée de nouveau et fonctionne
		script(okCollection([card("c1")]));
		await expect(getCardLegalities.call(plugin, "c1")).resolves.toEqual({ modern: "legal" });
		expect(plugin.legalitiesCache.get("c1")).toEqual({ modern: "legal" });
	}, 10000);

	it("card text, faces, TCGplayer link (the immutable snapshot): null, nothing cached", async () => {
		const plugin = fakePlugin();
		script(down);
		await expect(fetchScryfallImmutableSnapshot.call(plugin, "c1")).resolves.toBeNull();
		expect(plugin.scryfallImmutableCache.size).toBe(0);
		script(okCollection([card("c1")]));
		await expect(fetchScryfallImmutableSnapshot.call(plugin, "c1")).resolves.toMatchObject({ oracle_text: "text", set: "lea" });
		expect(plugin.scryfallImmutableCache.has("c1")).toBe(true);
	}, 10000);

	it("one failed attempt is absorbed by the retry, as for an HTTP failure", async () => {
		const plugin = fakePlugin();
		script(down, okCollection([card("c1")]));
		await expect(fetchCardLegalities.call(plugin, "c1")).resolves.toEqual({ modern: "legal" });
	}, 10000);

	it("the bulk legalities pass resolves EVERY pending id (null) and frees them, so no card stays \"in flight\" forever", async () => {
		const plugin = fakePlugin();
		script(down);
		await expect(bulkFetchLegalities.call(plugin, ["a", "b", "c"])).resolves.toBe(true);
		await settle();
		expect(plugin.legalitiesInFlight.size).toBe(0);
		expect(plugin.scheduleLegalitiesPersist).toHaveBeenCalled();
		// ce que l'ancien code bloquait : ouvrir la fiche de l'une d'elles ensuite
		script(okCollection([card("a")]));
		await expect(getCardLegalities.call(plugin, "a")).resolves.toEqual({ modern: "legal" });
	}, 10000);

	it("the bulk pass keeps what arrived before the failure", async () => {
		const plugin = fakePlugin();
		const ids = Array.from({ length: 80 }, (_, i) => "id" + i); // 2 lots de 75
		script(okCollection(ids.slice(0, 75).map((id) => card(id))), down);
		await bulkFetchLegalities.call(plugin, ids);
		await settle();
		expect(plugin.legalitiesCache.size).toBe(75);
		expect(plugin.legalitiesInFlight.size).toBe(0);
	}, 10000);

	it("Home's batched snapshots: the cached ones are returned, the missing ones are simply absent", async () => {
		const plugin = fakePlugin();
		plugin.scryfallImmutableCache.set("known", { set: "lea", oracle_text: "x" });
		script(down);
		const result = await getScryfallImmutableSnapshots.call(plugin, ["known", "unknown"]);
		expect([...result.keys()]).toEqual(["known"]);
	}, 10000);

	it("the success path is unchanged (one request, snapshot cached)", async () => {
		const plugin = fakePlugin();
		script(okCollection([card("c1"), card("c2")]));
		const result = await getScryfallImmutableSnapshots.call(plugin, ["c1", "c2"]);
		expect([...result.keys()].sort()).toEqual(["c1", "c2"]);
		expect(net.calls).toBe(1);
	}, 10000);
});
