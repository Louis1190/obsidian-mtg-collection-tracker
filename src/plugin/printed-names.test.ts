import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// printed-names.ts imports api/scryfall.ts, which imports `requestUrl` from "obsidian" (types only, no runtime).
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { requestUrl } from "obsidian";
import type MTGCollectionPlugin from "../plugin";
import { resetScryfallStrictGateForTests } from "../api/scryfall";
import {
	PRINTED_IMAGES_CACHE_FILENAME,
	PRINTED_NAMES_CACHE_FILENAME,
	cardDisplayImage,
	cardDisplayName,
	drainPrintedNames,
	getPrintedName,
	onPrintedNamesLearned,
	queuePrintedName,
	rememberPrintedName,
	stopPrintedNameLookups,
} from "./printed-names";

const mockRequestUrl = vi.mocked(requestUrl);

const french = { name: "Rocky Rebuke", setCode: "tla", collectorNumber: "193", language: "fr" };
const english = { name: "Rocky Rebuke", setCode: "tla", collectorNumber: "193", language: "" };

// A plugin that has only what these functions read, with the others bound as the real class does.
function fakePlugin(mode: "english" | "printed" = "printed", imageMode: "english" | "printed" = "english") {
	const plugin: any = {
		settings: { cardNameMode: mode, cardImageMode: imageMode },
		printedNamesCache: new Map<string, string>(),
		printedImagesCache: new Map<string, string>(),
		printedNameQueue: new Set<string>(),
		printedNameInFlight: null,
		printedNameTimer: undefined,
		printedNamesDraining: false,
		printedNamePausedUntil: 0,
		printedNameListeners: new Set<() => void>(),
		printedNamesVersion: 0,
		printLanguagesCache: new Map<string, string[]>(),
		scheduleMapCachePersist: vi.fn(),
		refreshOpenViews: vi.fn(),
	};
	plugin.getPrintedName = (c: any) => getPrintedName.call(plugin, c);
	plugin.queuePrintedName = (k: string) => queuePrintedName.call(plugin, k);
	plugin.drainPrintedNames = () => drainPrintedNames.call(plugin);
	return plugin as MTGCollectionPlugin & Record<string, any>;
}

// Scryfall's card by set, number and language: answers by the path it is asked.
function serve(answers: Record<string, { status: number; json?: unknown }>) {
	mockRequestUrl.mockImplementation((async (params: { url: string }) => {
		const path = new URL(params.url).pathname;
		return answers[path] ?? { status: 404, json: {} };
	}) as any);
}
const askedPaths = () => mockRequestUrl.mock.calls.map((c) => new URL((c[0] as any).url).pathname);

// The requests are spaced 110 ms apart by requestScryfall: run on a fake clock.
async function drain(plugin: any) {
	let settled = false;
	const run = plugin.drainPrintedNames().finally(() => (settled = true));
	// Advance the clock in small steps until the run is over, no further: a pause set by a failure must still be running afterwards.
	for (let i = 0; i < 600 && !settled; i++) await vi.advanceTimersByTimeAsync(250);
	await run;
}

beforeEach(() => {
	mockRequestUrl.mockReset();
	resetScryfallStrictGateForTests();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("getPrintedName / cardDisplayName", () => {
	it("know nothing about a copy that is not in a foreign language, and never queue it", () => {
		const plugin = fakePlugin();
		expect(getPrintedName.call(plugin, english)).toBeUndefined();
		expect(plugin.printedNameQueue.size).toBe(0);
		expect(cardDisplayName.call(plugin, english)).toBe("Rocky Rebuke");
	});

	it("queue a foreign copy whose name is not known yet, once, and show the English name meanwhile", () => {
		const plugin = fakePlugin();
		expect(getPrintedName.call(plugin, french)).toBeUndefined();
		expect(getPrintedName.call(plugin, french)).toBeUndefined();
		expect([...plugin.printedNameQueue]).toEqual(["tla:193:fr"]);
		expect(cardDisplayName.call(plugin, french)).toBe("Rocky Rebuke");
	});

	it("return the cached name, and treat an empty entry as 'this print has none'", () => {
		const plugin = fakePlugin();
		plugin.printedNamesCache.set("tla:193:fr", "Blâme de pierre");
		expect(getPrintedName.call(plugin, french)).toBe("Blâme de pierre");
		expect(cardDisplayName.call(plugin, french)).toBe("Blâme de pierre");
		plugin.printedNamesCache.set("tla:193:fr", "");
		expect(getPrintedName.call(plugin, french)).toBeUndefined();
		expect(cardDisplayName.call(plugin, french)).toBe("Rocky Rebuke");
		expect(plugin.printedNameQueue.size).toBe(0);
	});

	it("show the English name in English mode, but still know the printed one for the search", () => {
		const plugin = fakePlugin("english");
		plugin.printedNamesCache.set("tla:193:fr", "Blâme de pierre");
		expect(cardDisplayName.call(plugin, french)).toBe("Rocky Rebuke");
		expect(getPrintedName.call(plugin, french)).toBe("Blâme de pierre");
	});

	it("do not queue anything for a while after a failed request", () => {
		const plugin = fakePlugin();
		plugin.printedNamePausedUntil = performance.now() + 30_000;
		getPrintedName.call(plugin, french);
		expect(plugin.printedNameQueue.size).toBe(0);
	});
});

describe("rememberPrintedName", () => {
	it("keeps the name of a card found by its name in another language, and persists it", () => {
		const plugin = fakePlugin();
		rememberPrintedName.call(plugin, { set: "tla", collector_number: "193", lang: "fr", printed_name: " Blâme de pierre " });
		expect(plugin.printedNamesCache.get("tla:193:fr")).toBe("Blâme de pierre");
		expect(plugin.printedNamesVersion).toBe(1);
		expect(plugin.scheduleMapCachePersist).toHaveBeenCalledWith(PRINTED_NAMES_CACHE_FILENAME, plugin.printedNamesCache);
	});

	it("ignores an English card, a card with no printed name, and a name it already has", () => {
		const plugin = fakePlugin();
		rememberPrintedName.call(plugin, { set: "tla", collector_number: "193", lang: "en", printed_name: "Rocky Rebuke" });
		rememberPrintedName.call(plugin, { set: "tla", collector_number: "193", lang: "fr" });
		expect(plugin.printedNamesCache.size).toBe(0);
		rememberPrintedName.call(plugin, { set: "tla", collector_number: "193", lang: "fr", printed_name: "Blâme de pierre" });
		rememberPrintedName.call(plugin, { set: "tla", collector_number: "193", lang: "fr", printed_name: "Blâme de pierre" });
		expect(plugin.printedNamesVersion).toBe(1);
	});
});

describe("drainPrintedNames", () => {
	it("asks for each queued copy once, remembers the name, and has the views redraw", async () => {
		const plugin = fakePlugin();
		serve({ "/cards/tla/193/fr": { status: 200, json: { printed_name: "Blâme de pierre" } } });
		plugin.printedNameQueue.add("tla:193:fr");
		await drain(plugin);
		expect(askedPaths()).toEqual(["/cards/tla/193/fr"]);
		expect(plugin.printedNamesCache.get("tla:193:fr")).toBe("Blâme de pierre");
		expect(plugin.printedNamesVersion).toBe(1);
		expect(plugin.refreshOpenViews).toHaveBeenCalledTimes(1);
		expect(plugin.printedNameQueue.size).toBe(0);
	});

	it("remembers a 404 as 'no name in that language' and does not redraw for it", async () => {
		const plugin = fakePlugin();
		serve({});
		plugin.printedNameQueue.add("tla:193:de");
		await drain(plugin);
		expect(plugin.printedNamesCache.get("tla:193:de")).toBe("");
		expect(plugin.refreshOpenViews).not.toHaveBeenCalled();
		// asked about again? no
		getPrintedName.call(plugin, { ...french, language: "de" });
		expect(plugin.printedNameQueue.size).toBe(0);
	});

	it("stops and pauses on any other answer, remembering nothing for it, and goes on later", async () => {
		const plugin = fakePlugin();
		serve({ "/cards/tla/193/fr": { status: 503 }, "/cards/inv/145/fr": { status: 200, json: { printed_name: "Espion gobelin" } } });
		plugin.printedNameQueue.add("tla:193:fr");
		plugin.printedNameQueue.add("inv:145:fr");
		await drain(plugin);
		expect(askedPaths()).toEqual(["/cards/tla/193/fr"]);
		expect(plugin.printedNamesCache.size).toBe(0);
		expect(plugin.printedNameQueue.size).toBe(0);
		expect(plugin.printedNamePausedUntil).toBeGreaterThan(performance.now());
		// during the pause nothing is queued; after it, the copy comes back by itself
		getPrintedName.call(plugin, french);
		expect(plugin.printedNameQueue.size).toBe(0);
		await vi.advanceTimersByTimeAsync(31_000);
		getPrintedName.call(plugin, french);
		expect(plugin.printedNameQueue.size).toBe(1);
	});

	it("treats a request that throws (offline) like any other failure", async () => {
		const plugin = fakePlugin();
		mockRequestUrl.mockImplementation((async () => {
			throw new Error("net::ERR_INTERNET_DISCONNECTED");
		}) as any);
		plugin.printedNameQueue.add("tla:193:fr");
		await drain(plugin);
		expect(plugin.printedNamesCache.size).toBe(0);
		expect(plugin.printedNamePausedUntil).toBeGreaterThan(performance.now());
	});

	it("does not ask for a language a printing was not printed in, when that is already known", async () => {
		const plugin = fakePlugin();
		plugin.printLanguagesCache.set("tla:193", ["en", "ja"]);
		plugin.printedNameQueue.add("tla:193:fr");
		await drain(plugin);
		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(plugin.printedNamesCache.get("tla:193:fr")).toBe("");
	});

	it("does not ask again for a name it already has, nor run twice at once", async () => {
		const plugin = fakePlugin();
		serve({ "/cards/tla/193/fr": { status: 200, json: { printed_name: "Blâme de pierre" } } });
		plugin.printedNamesCache.set("tla:193:fr", "Blâme de pierre");
		plugin.printedImagesCache.set("tla:193:fr", "");
		plugin.printedNameQueue.add("tla:193:fr");
		await drain(plugin);
		expect(mockRequestUrl).not.toHaveBeenCalled();

		plugin.printedNamesDraining = true;
		plugin.printedNameQueue.add("inv:145:fr");
		await plugin.drainPrintedNames();
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("does not queue the copy it is fetching right now again", async () => {
		const plugin = fakePlugin();
		let release!: () => void;
		mockRequestUrl.mockImplementation((() => new Promise((resolve) => (release = () => resolve({ status: 200, json: { printed_name: "X" } })))) as any);
		plugin.printedNameQueue.add("tla:193:fr");
		const run = plugin.drainPrintedNames();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(plugin.printedNameInFlight).toBe("tla:193:fr");
		getPrintedName.call(plugin, french);
		expect(plugin.printedNameQueue.size).toBe(0);
		release();
		await vi.advanceTimersByTimeAsync(1_000);
		await run;
		expect(plugin.printedNameInFlight).toBeNull();
	});

	it("redraws every 40 names while a long run goes on, and once more for the rest", async () => {
		const plugin = fakePlugin();
		mockRequestUrl.mockImplementation((async () => ({ status: 200, json: { printed_name: "Nom" } })) as any);
		for (let i = 1; i <= 85; i++) plugin.printedNameQueue.add(`set:${i}:fr`);
		await drain(plugin);
		expect(plugin.refreshOpenViews).toHaveBeenCalledTimes(3);
		expect(plugin.printedNamesVersion).toBe(85);
	});
});

describe("queuePrintedName", () => {
	it("groups the misses of one render into one run, a moment later", async () => {
		const plugin = fakePlugin();
		serve({
			"/cards/tla/193/fr": { status: 200, json: { printed_name: "Blâme de pierre" } },
			"/cards/inv/145/fr": { status: 200, json: { printed_name: "Espion gobelin" } },
		});
		queuePrintedName.call(plugin, "tla:193:fr");
		queuePrintedName.call(plugin, "inv:145:fr");
		expect(mockRequestUrl).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(askedPaths()).toEqual(["/cards/tla/193/fr", "/cards/inv/145/fr"]);
	});
});

describe("onPrintedNamesLearned", () => {
	it("tells a listener (an open detail window) when names were learned, together with the views' redraw", async () => {
		const plugin = fakePlugin();
		const listener = vi.fn();
		onPrintedNamesLearned.call(plugin, listener);
		serve({ "/cards/tla/193/fr": { status: 200, json: { printed_name: "Blâme de pierre" } } });
		plugin.printedNameQueue.add("tla:193:fr");
		await drain(plugin);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(plugin.refreshOpenViews).toHaveBeenCalledTimes(1);
	});

	it("does not tell it when nothing was learned (a 404, a failure)", async () => {
		const plugin = fakePlugin();
		const listener = vi.fn();
		onPrintedNamesLearned.call(plugin, listener);
		serve({});
		plugin.printedNameQueue.add("tla:193:de");
		await drain(plugin);
		expect(listener).not.toHaveBeenCalled();
	});

	it("stops telling a listener once it unsubscribed (the window closed)", async () => {
		const plugin = fakePlugin();
		const listener = vi.fn();
		const stop = onPrintedNamesLearned.call(plugin, listener);
		stop();
		expect(plugin.printedNameListeners.size).toBe(0);
		serve({ "/cards/tla/193/fr": { status: 200, json: { printed_name: "Blâme de pierre" } } });
		plugin.printedNameQueue.add("tla:193:fr");
		await drain(plugin);
		expect(listener).not.toHaveBeenCalled();
	});
});

// A 200 answer of GET /cards/{set}/{number}/{lang}: the name and the picture of the print.
const frenchBody = (status: string, name = "Blâme de pierre") => ({
	printed_name: name,
	image_status: status,
	image_uris: { normal: "https://cards.scryfall.io/normal/front/fr/tla-193.jpg" },
});
const frenchImage = "https://cards.scryfall.io/normal/front/fr/tla-193.jpg";
const englishCopy = { ...french, imageUrl: "https://cards.scryfall.io/normal/front/en/tla-193.jpg" };

describe("cardDisplayImage", () => {
	it("is the copy's own picture in English mode, and asks for nothing", () => {
		const plugin = fakePlugin("printed", "english");
		plugin.printedImagesCache.set("tla:193:fr", frenchImage);
		expect(cardDisplayImage.call(plugin, englishCopy)).toBe(englishCopy.imageUrl);
		const other = fakePlugin("printed", "english");
		cardDisplayImage.call(other, englishCopy);
		expect(other.printedNameQueue.size).toBe(0);
	});

	it("is the printed picture in printed mode when it is known", () => {
		const plugin = fakePlugin("english", "printed");
		plugin.printedImagesCache.set("tla:193:fr", frenchImage);
		expect(cardDisplayImage.call(plugin, englishCopy)).toBe(frenchImage);
	});

	it("keeps the copy's picture, and queues the lookup once, while the printed one is not known yet", () => {
		const plugin = fakePlugin("english", "printed");
		expect(cardDisplayImage.call(plugin, englishCopy)).toBe(englishCopy.imageUrl);
		expect(cardDisplayImage.call(plugin, englishCopy)).toBe(englishCopy.imageUrl);
		expect([...plugin.printedNameQueue]).toEqual(["tla:193:fr"]);
	});

	it("keeps the copy's picture when Scryfall has no real scan of the print, without asking again", () => {
		const plugin = fakePlugin("english", "printed");
		plugin.printedImagesCache.set("tla:193:fr", "");
		expect(cardDisplayImage.call(plugin, englishCopy)).toBe(englishCopy.imageUrl);
		expect(plugin.printedNameQueue.size).toBe(0);
	});

	it("never changes the picture of a copy that is not in a foreign language", () => {
		const plugin = fakePlugin("english", "printed");
		expect(cardDisplayImage.call(plugin, { ...englishCopy, language: "" })).toBe(englishCopy.imageUrl);
		expect(cardDisplayImage.call(plugin, { ...englishCopy, language: "en" })).toBe(englishCopy.imageUrl);
		expect(plugin.printedNameQueue.size).toBe(0);
	});
});

describe("drainPrintedNames and the printed pictures", () => {
	it("learns the name AND the picture from one request, and persists both caches", async () => {
		const plugin = fakePlugin("printed", "printed");
		serve({ "/cards/tla/193/fr": { status: 200, json: frenchBody("highres_scan") } });
		plugin.printedNameQueue.add("tla:193:fr");
		await drain(plugin);
		expect(askedPaths()).toEqual(["/cards/tla/193/fr"]);
		expect(plugin.printedNamesCache.get("tla:193:fr")).toBe("Blâme de pierre");
		expect(plugin.printedImagesCache.get("tla:193:fr")).toBe(frenchImage);
		expect(plugin.scheduleMapCachePersist).toHaveBeenCalledWith(PRINTED_IMAGES_CACHE_FILENAME, plugin.printedImagesCache);
		expect(plugin.scheduleMapCachePersist).toHaveBeenCalledWith(PRINTED_NAMES_CACHE_FILENAME, plugin.printedNamesCache);
	});

	it("remembers 'no real picture' for a stand-in, but still learns the name and redraws", async () => {
		const plugin = fakePlugin("printed", "printed");
		serve({ "/cards/tla/193/fr": { status: 200, json: frenchBody("placeholder") } });
		plugin.printedNameQueue.add("tla:193:fr");
		await drain(plugin);
		expect(plugin.printedImagesCache.get("tla:193:fr")).toBe("");
		expect(plugin.printedNamesCache.get("tla:193:fr")).toBe("Blâme de pierre");
		expect(plugin.refreshOpenViews).toHaveBeenCalledTimes(1);
	});

	it("redraws for a picture even when the print has no name of its own", async () => {
		const plugin = fakePlugin("english", "printed");
		serve({ "/cards/tla/193/fr": { status: 200, json: frenchBody("lowres", "") } });
		plugin.printedNameQueue.add("tla:193:fr");
		await drain(plugin);
		expect(plugin.printedNamesCache.get("tla:193:fr")).toBe("");
		expect(plugin.printedImagesCache.get("tla:193:fr")).toBe(frenchImage);
		expect(plugin.refreshOpenViews).toHaveBeenCalledTimes(1);
	});

	it("remembers a 404 and a language the print was not printed in as having neither name nor picture", async () => {
		const plugin = fakePlugin("printed", "printed");
		serve({});
		plugin.printLanguagesCache.set("inv:145", ["en", "fr"]);
		plugin.printedNameQueue.add("tla:193:de");
		plugin.printedNameQueue.add("inv:145:ja");
		await drain(plugin);
		expect(askedPaths()).toEqual(["/cards/tla/193/de"]);
		for (const key of ["tla:193:de", "inv:145:ja"]) {
			expect(plugin.printedNamesCache.get(key)).toBe("");
			expect(plugin.printedImagesCache.get(key)).toBe("");
		}
	});

	it("looks a print up again for its picture when only the name was known, and does not when both are", async () => {
		const plugin = fakePlugin("english", "printed");
		serve({ "/cards/tla/193/fr": { status: 200, json: frenchBody("highres_scan") } });
		plugin.printedNamesCache.set("tla:193:fr", "Blâme de pierre");
		cardDisplayImage.call(plugin, englishCopy);
		expect([...plugin.printedNameQueue]).toEqual(["tla:193:fr"]);
		await drain(plugin);
		expect(askedPaths()).toEqual(["/cards/tla/193/fr"]);
		expect(plugin.printedImagesCache.get("tla:193:fr")).toBe(frenchImage);

		mockRequestUrl.mockClear();
		plugin.printedNameQueue.add("tla:193:fr");
		await drain(plugin);
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("keeps a name seeded from the search hit when the lookup's own name is empty", async () => {
		const plugin = fakePlugin("printed", "printed");
		serve({ "/cards/tla/193/fr": { status: 200, json: frenchBody("lowres", "") } });
		plugin.printedNamesCache.set("tla:193:fr", "Blâme de pierre");
		plugin.printedNameQueue.add("tla:193:fr");
		await drain(plugin);
		expect(plugin.printedNamesCache.get("tla:193:fr")).toBe("Blâme de pierre");
	});
});

describe("pacing, unloading and failing listeners", () => {
	it("leaves at least half a second between two lookups (the strictest tier of Scryfall's limits)", async () => {
		const plugin = fakePlugin();
		const times: number[] = [];
		mockRequestUrl.mockImplementation((async () => {
			times.push(Date.now());
			return { status: 200, json: { printed_name: "Nom" } };
		}) as any);
		["a:1:fr", "b:2:fr", "c:3:fr"].forEach((key) => plugin.printedNameQueue.add(key));
		await drain(plugin);
		expect(times).toHaveLength(3);
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(500);
		expect(times[2] - times[1]).toBeGreaterThanOrEqual(500);
	});

	it("does not wait after the last lookup, nor for a copy it already knows", async () => {
		const plugin = fakePlugin();
		const times: number[] = [];
		mockRequestUrl.mockImplementation((async () => {
			times.push(Date.now());
			return { status: 200, json: { printed_name: "Nom" } };
		}) as any);
		plugin.printedNamesCache.set("known:1:fr", "Déjà");
		plugin.printedImagesCache.set("known:1:fr", "");
		plugin.printedNameQueue.add("known:1:fr");
		plugin.printedNameQueue.add("a:1:fr");
		const started = Date.now();
		await drain(plugin);
		expect(times).toHaveLength(1);
		expect(times[0] - started).toBeLessThan(500);
	});

	it("stops asking, queues nothing and drops its listeners once the plugin is unloaded", async () => {
		const plugin = fakePlugin();
		let calls = 0;
		mockRequestUrl.mockImplementation((async () => {
			calls++;
			return { status: 200, json: { printed_name: "Nom" } };
		}) as any);
		["a:1:fr", "b:2:fr", "c:3:fr", "d:4:fr"].forEach((key) => plugin.printedNameQueue.add(key));
		onPrintedNamesLearned.call(plugin, vi.fn());
		const run = plugin.drainPrintedNames();
		await vi.advanceTimersByTimeAsync(700);
		stopPrintedNameLookups.call(plugin);
		await vi.advanceTimersByTimeAsync(60_000);
		await run;
		expect(calls).toBeLessThan(4);
		expect(plugin.printedNameQueue.size).toBe(0);
		expect(plugin.printedNameListeners.size).toBe(0);
		getPrintedName.call(plugin, french);
		expect(plugin.printedNameQueue.size).toBe(0);
	});

	it("tells every listener even when the views fail to redraw or one listener throws", async () => {
		const plugin = fakePlugin();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		plugin.refreshOpenViews = vi.fn(() => {
			throw new Error("render failed");
		});
		const bad = vi.fn(() => {
			throw new Error("listener failed");
		});
		const good = vi.fn();
		onPrintedNamesLearned.call(plugin, bad);
		onPrintedNamesLearned.call(plugin, good);
		serve({ "/cards/tla/193/fr": { status: 200, json: { printed_name: "Blâme de pierre" } } });
		plugin.printedNameQueue.add("tla:193:fr");
		await drain(plugin);
		expect(bad).toHaveBeenCalledTimes(1);
		expect(good).toHaveBeenCalledTimes(1);
		expect(errors).toHaveBeenCalledTimes(2);
		errors.mockRestore();
	});
});
