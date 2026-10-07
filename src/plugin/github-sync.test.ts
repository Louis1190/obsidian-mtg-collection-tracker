import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { settingsEqual } from "../core/settings-merge";
import {
	githubStatusLine,
	pushDelay,
	pollIntervalMs,
	pollDue,
	GITHUB_POLL_ACTIVE_MS,
	GITHUB_POLL_IDLE_MS,
	GITHUB_ACTIVE_WINDOW_MS,
	GITHUB_TICK_MS,
	GITHUB_PUSH_DEBOUNCE_MS,
	GITHUB_MIN_GAP_MS,
	GITHUB_BUSY_GAP_MS,
	GITHUB_BUSY_PUSHES,
} from "./github-sync";
import {
	Obj,
	deliver,
	card,
	deckCard,
	ids,
	setNow,
	deviceWith,
	seededDevice,
	cloneDevice,
	disposeDevices,
	FakeGithub,
	HttpCache,
	enableGithub,
	GH_DIR,
	GH_CORE,
	GH_FILE,
	GH_LEGACY_FILE,
	ghShard,
	ghState,
	ghShardNames,
} from "./__tests__/sync-test-harness";

// Même cadre que settings-sync.test.ts : de faux appareils (système de fichiers et stockage local à
// eux), et un faux GitHub partagé qui rejoue les règles de l'API (voir FakeGithub).
const mocks = vi.hoisted(() => ({
	notices: [] as string[],
	gh: null as unknown as FakeGithub,
}));

vi.mock("obsidian", () => ({
	Notice: class {
		constructor(message: string) {
			mocks.notices.push(message);
		}
	},
	Platform: { isIosApp: false, isAndroidApp: false },
	requestUrl: (p: Parameters<FakeGithub["request"]>[0]) => mocks.gh.request(p),
	arrayBufferToBase64: (b: ArrayBuffer) => Buffer.from(b).toString("base64"),
	normalizePath: (p: string) => p.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, ""),
}));

vi.stubGlobal("window", globalThis);

let gh: FakeGithub;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000_000);
	mocks.notices.length = 0;
	gh = new FakeGithub();
	mocks.gh = gh;
});
afterEach(() => {
	disposeDevices();
	vi.useRealTimers();
});

// L'état complet que GitHub porte (tous les fragments recomposés), et le fragment des cartes sans liste (les
// cartes de test n'ont pas de listId : elles vont toutes dans celui-là).
const remote = () => ghState(gh);
const LIST_SHARD = ghShard("list", "_");
const shardTexts = () => ghShardNames(gh).map((n) => gh.text(`${GH_DIR}/${n}`)!);
const sync = async (dev: Obj, reason = "manual") => {
	await dev.githubSync(reason);
	await dev.persistChain; // the local save a merge triggers
};
// Un appareil avec ses cartes, déjà branché sur GitHub (la première synchro n'est PAS encore faite).
async function ghDevice(cards: Obj[], t = 1000) {
	const dev = await seededDevice(cards, t);
	enableGithub(dev, gh);
	return dev;
}

describe("when it should do nothing", () => {
	it("makes no request while disabled, without a repository, or without a token", async () => {
		const dev = await seededDevice([card("a")]);
		await sync(dev);
		dev.settings.githubSyncEnabled = true;
		await sync(dev); // no repo
		dev.settings.githubRepo = gh.repo;
		await sync(dev); // no token
		expect(gh.calls).toEqual([]);
		expect(githubStatusLine(dev as never)).toMatch(/Paste a token/);
	});

	it("stays quiet before the settings are loaded", async () => {
		const dev = await ghDevice([card("a")]);
		dev.settingsLoaded = false;
		await sync(dev);
		expect(gh.calls).toEqual([]);
	});
});

describe("first sync and polling", () => {
	it("creates the files on the first sync — the common one LAST — then polls for free and sends nothing more", async () => {
		const dev = await ghDevice([card("a"), card("b")]);
		dev.resetGithubSync();
		await dev.github.chain;
		expect(gh.calls).toEqual(["GET 404", "PUT 201", "PUT 201"]);
		expect(gh.putPaths).toEqual([LIST_SHARD, GH_CORE]); // its presence says "the data is all there"
		expect(remote().collection.map((c: Obj) => c.id)).toEqual(["a", "b"]);

		await sync(dev, "poll"); // our own pushes come back once: recognized, nothing to download or merge
		await sync(dev, "poll"); // then conditional: free
		await sync(dev, "poll");
		expect(gh.calls).toEqual(["GET 404", "PUT 201", "PUT 201", "GET 200", "GET 304", "GET 304"]);
		expect(gh.rawGets).toBe(0);
		expect(dev.refreshOpenViews).not.toHaveBeenCalled();
		expect(githubStatusLine(dev as never)).toMatch(/In sync/);
	});

	it("never uploads a secret or a per-device preference", async () => {
		const dev = await ghDevice([card("a")]);
		dev.settings.cardbaseApiKey = "cbdev_SECRET";
		dev.settings.collectionViewMode = "card";
		dev.settings.navCollapsed = true;
		dev.resetGithubSync();
		await dev.github.chain;
		const all = shardTexts().join("\n");
		expect(all).not.toContain("cbdev_SECRET");
		expect(all).not.toContain("cardbaseApiKey");
		expect(all).not.toContain("collectionViewMode");
		expect(all).not.toContain("githubRepo");
		expect(all).not.toContain(gh.token);
		expect(JSON.parse(gh.text(GH_CORE)!).priceCurrency).toBeDefined(); // shared configuration is there
	});

	it("keeps the token out of the settings and, when Obsidian has one, in its secret storage", async () => {
		const dev = await seededDevice([card("a")]);
		const secrets = new Map<string, string>();
		dev.app.secretStorage = { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, v: string) => void secrets.set(id, v) };
		dev.setGithubToken("  ghp_abc  ");
		expect(dev.getGithubToken()).toBe("ghp_abc");
		expect([...secrets.values()]).toEqual(["ghp_abc"]);
		expect(JSON.stringify(dev.settings)).not.toContain("ghp_abc");
		expect(JSON.stringify([...dev.store.entries()])).not.toContain("ghp_abc");
	});

	it("falls back to the device's local storage without a secret storage", async () => {
		const dev = await seededDevice([card("a")]);
		dev.setGithubToken("ghp_local");
		expect(dev.getGithubToken()).toBe("ghp_local");
		dev.setGithubToken("");
		expect(dev.getGithubToken()).toBe("");
	});
});

describe("two devices through GitHub", () => {
	it("a second device receives the data, saves it locally, and sends nothing back", async () => {
		const mac = await ghDevice([card("a")], 1000);
		mac.resetGithubSync();
		await mac.github.chain;
		const puts = gh.count("PUT");

		const ipad = await deviceWith(); // brand new, empty
		enableGithub(ipad, gh);
		ipad.resetGithubSync();
		await ipad.github.chain;
		await ipad.persistChain;

		expect(ids(ipad)).toEqual(["a"]);
		expect(ipad.refreshOpenViews).toHaveBeenCalled();
		expect(JSON.parse(ipad.fs.data()!.text).collection.map((c: Obj) => c.id)).toEqual(["a"]); // data.json follows (and so would Syncthing)
		expect(gh.count("PUT")).toBe(puts); // nothing sent back
	});

	it("an edit travels from one device to the other on the next poll — and only its list's shard goes out", async () => {
		const mac = await ghDevice([card("a")], 1000);
		mac.resetGithubSync();
		await mac.github.chain;
		const ipad = await cloneDevice(mac);
		enableGithub(ipad, gh);
		await sync(ipad, "startup");
		const puts = gh.count("PUT");

		setNow(2000);
		const held = ipad.settings.collection[0];
		mac.settings.collection[0].count = 5;
		mac.settings.collection[0].dateModified = 2000;
		mac.markGithubDirty();
		await sync(mac, "push");
		expect(remote().collection[0].count).toBe(5);
		expect(gh.count("PUT")).toBe(puts + 1);
		expect(gh.putPaths.at(-1)).toBe(LIST_SHARD);

		await sync(ipad, "poll");
		expect(ipad.settings.collection[0]).toBe(held); // an open modal keeps a live object
		expect(held.count).toBe(5);
		expect(gh.count("PUT")).toBe(puts + 1);
	});

	it("a deletion travels as a tombstone in the common shard, and empties nothing else", async () => {
		const mac = await ghDevice([card("a"), card("b")], 1000);
		mac.resetGithubSync();
		await mac.github.chain;
		const ipad = await cloneDevice(mac);
		enableGithub(ipad, gh);
		await sync(ipad, "startup");

		setNow(2000);
		mac.settings.collection = mac.settings.collection.filter((c: Obj) => c.id !== "b");
		mac.markGithubDirty();
		await sync(mac, "push");
		expect(remote().syncTombstones.collection.b).toBe(2000);
		expect(gh.putPaths.slice(-2)).toEqual([LIST_SHARD, GH_CORE]);
		await sync(ipad, "poll");
		expect(ids(ipad)).toEqual(["a"]);
	});

	it("concurrent edits: GitHub refuses the stale write, the device re-reads, merges and retries", async () => {
		const mac = await ghDevice([card("a")], 1000);
		mac.resetGithubSync();
		await mac.github.chain;
		const ipad = await cloneDevice(mac);
		enableGithub(ipad, gh);
		await sync(ipad, "startup");

		setNow(2000);
		mac.settings.collection.push(card("m", { dateAdded: 2000, dateModified: 2000 }));
		mac.markGithubDirty();
		ipad.settings.collection.push(card("i", { dateAdded: 2100, dateModified: 2100 }));
		ipad.markGithubDirty();
		// The Mac pushes in the middle of the iPad's cycle, between its read and its write.
		gh.beforePut = () => {
			const theirs = JSON.parse(gh.text(LIST_SHARD)!);
			theirs.collection.push(mac.settings.collection[1]);
			gh.setFile(LIST_SHARD, JSON.stringify(theirs));
		};
		gh.calls.length = 0;
		await sync(ipad, "push");
		// poll (nothing new) → write refused → listing + download of the changed shard → write accepted
		expect(gh.calls).toEqual(["GET 304", "PUT 409", "GET 200", "GET 200", "PUT 200"]);
		expect(ids(ipad)).toEqual(["a", "i", "m"]);
		expect(remote().collection.map((c: Obj) => c.id).sort()).toEqual(["a", "i", "m"]);
		await sync(mac, "poll");
		expect(ids(mac)).toEqual(["a", "i", "m"]);
	});

	it("the very first sync of two devices that both hold data merges, nothing is lost", async () => {
		const mac = await ghDevice([card("a"), card("x")], 1000);
		const ipad = await seededDevice([card("a"), card("y")], 1000);
		enableGithub(ipad, gh);
		mac.resetGithubSync();
		await mac.github.chain;
		ipad.resetGithubSync();
		await ipad.github.chain;
		await sync(mac, "poll");
		expect(ids(ipad)).toEqual(["a", "x", "y"]);
		expect(ids(mac)).toEqual(["a", "x", "y"]);
		expect(settingsEqual(mac.settings, ipad.settings)).toBe(true);
	});
});

describe("what is sent, and when", () => {
	it("a preference-only change sends nothing", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		await sync(dev, "poll"); // absorb the echo of our own push
		gh.calls.length = 0;
		dev.settings.collectionSortBy = "price";
		dev.markGithubDirty();
		await sync(dev, "push");
		expect(gh.calls).toEqual(["GET 304"]);
		expect(dev.github.dirty).toBe(false);
	});

	it("marking dirty schedules exactly one push, flushing sends it at once", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		dev.settings.collection.push(card("b", { dateModified: 5000 }));
		dev.markGithubDirty();
		dev.markGithubDirty();
		const timer = dev.github.pushTimer;
		expect(timer).not.toBeNull();
		dev.markGithubDirty();
		expect(dev.github.pushTimer).toBe(timer); // no second timer
		await dev.flushGithubSync();
		expect(dev.github.pushTimer).toBeNull();
		expect(remote().collection).toHaveLength(2);
		expect(dev.github.dirty).toBe(false);
	});

	it("a change made while a push is in flight stays to be sent", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		dev.settings.collection.push(card("b", { dateModified: 5000 }));
		dev.markGithubDirty();
		gh.beforePut = () => {
			dev.settings.collection.push(card("c", { dateModified: 5001 }));
			dev.dataVersion++; // what saveSettings() does
		};
		await dev.flushGithubSync();
		expect(remote().collection.map((c: Obj) => c.id)).toEqual(["a", "b"]);
		expect(dev.github.dirty).toBe(true);
		dev.github.listEtag = null;
		await dev.flushGithubSync();
		expect(remote().collection.map((c: Obj) => c.id)).toEqual(["a", "b", "c"]);
	});

	it("schedules the push after the last one, not before", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		expect(dev.github.lastPushAt).toBe(Date.now());
		expect(dev.github.pushTimes).toEqual([Date.now()]);
		dev.markGithubDirty();
		expect(dev.github.pushTimer).not.toBeNull();
	});

	it("waits a short moment normally, longer when the user edits non-stop", () => {
		const now = 1_000_000;
		// Idle for a while: just the grouping delay.
		expect(pushDelay(now, now - 60_000, [])).toBe(GITHUB_PUSH_DEBOUNCE_MS);
		// Just pushed: wait for the minimum gap.
		expect(pushDelay(now, now - 1000, [now - 1000])).toBe(GITHUB_MIN_GAP_MS - 1000);
		// Pushed continuously (3 in the last minute): the gap grows to protect the repository.
		const burst = Array.from({ length: GITHUB_BUSY_PUSHES }, (_, i) => now - 5000 * (i + 1));
		expect(pushDelay(now, now - 5000, burst)).toBe(GITHUB_BUSY_GAP_MS - 5000);
		// Old pushes no longer count.
		expect(pushDelay(now, now - 30_000, [now - 100_000, now - 90_000, now - 80_000])).toBe(GITHUB_PUSH_DEBOUNCE_MS);
		expect(GITHUB_PUSH_DEBOUNCE_MS).toBeLessThan(GITHUB_MIN_GAP_MS);
		expect(GITHUB_MIN_GAP_MS).toBeLessThan(GITHUB_BUSY_GAP_MS);
	});
});

describe("downloads only what changed", () => {
	it("never downloads what it has just sent", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		await sync(dev, "poll");
		await sync(dev, "poll");
		expect(gh.rawGets).toBe(0);
		dev.settings.collection.push(card("b", { dateModified: 5000 }));
		dev.markGithubDirty();
		await sync(dev, "push");
		await sync(dev, "poll");
		await sync(dev, "poll");
		expect(gh.rawGets).toBe(0); // two pushes, four polls, not a single download
		expect(gh.count("PUT")).toBe(3); // the two files created, then the one list that changed
	});

	it("a new device downloads every shard once; after that, only the shard that changed elsewhere", async () => {
		const mac = await ghDevice([card("a", { listId: "A" }), card("b", { listId: "B" }), card("c", { listId: "C" })], 1000);
		mac.resetGithubSync();
		await mac.github.chain;
		expect(ghShardNames(gh)).toHaveLength(4); // the common shard + three lists

		const ipad = await deviceWith();
		enableGithub(ipad, gh);
		ipad.resetGithubSync();
		await ipad.github.chain;
		expect(gh.rawGets).toBe(4);
		expect(ids(ipad)).toEqual(["a", "b", "c"]);

		const base = gh.rawGets;
		for (let i = 0; i < 5; i++) await sync(ipad, "poll");
		expect(gh.rawGets).toBe(base); // nothing new: listings only (304)

		setNow(2000);
		mac.settings.collection[1].count = 4;
		mac.settings.collection[1].dateModified = 2000;
		mac.markGithubDirty();
		await sync(mac, "push");
		await sync(ipad, "poll");
		await sync(ipad, "poll");
		expect(gh.rawGets).toBe(base + 1); // list B only
		expect(gh.rawPaths.at(-1)).toBe(ghShard("list", "B"));
		expect(ipad.settings.collection.find((c: Obj) => c.id === "b")!.count).toBe(4);
	});

	it("a listing that is not a folder listing stops the sync with a clear reason; a server error only delays it", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		gh.listingFault = "object";
		await sync(dev, "manual");
		expect(dev.github.fatal).toBe(true);
		expect(githubStatusLine(dev as never)).toMatch(/not a folder listing/);
		gh.listingFault = null;
		await sync(dev, "manual");
		expect(dev.github.fatal).toBe(false);
		gh.listingFault = 503;
		await sync(dev, "manual");
		expect(dev.github.fatal).toBe(false);
		expect(dev.github.status.state).toBe("error");
	});
});

describe("an HTTP stack that caches GitHub's answers", () => {
	it("still sees an edit made elsewhere on its next poll, not a minute later", async () => {
		setNow(1000);
		const mac = await ghDevice([card("a")], 1000);
		mac.resetGithubSync();
		await mac.github.chain;
		const ipad = await cloneDevice(mac);
		enableGithub(ipad, gh);

		const real = gh.request;
		const cache = new HttpCache();
		const asIpad = async <T>(fn: () => Promise<T>): Promise<T> => {
			gh.request = cache.wrap(real);
			try {
				return await fn();
			} finally {
				gh.request = real;
			}
		};
		await asIpad(() => sync(ipad, "startup"));
		await asIpad(() => sync(ipad, "poll")); // the answers are now in this device's cache

		setNow(3000); // two seconds later, well inside the 60 s a cached answer lives
		mac.settings.collection.push(card("m", { dateAdded: 3000, dateModified: 3000 }));
		mac.markGithubDirty();
		await sync(mac, "push");
		const sha = gh.files.get(LIST_SHARD)!.sha;

		await asIpad(() => sync(ipad, "poll"));
		expect(ids(ipad)).toEqual(["a", "m"]);
		expect(ipad.github.shards.get(`list-_.json.gz`)!.sha).toBe(sha); // and it merged exactly the bytes GitHub holds
	});

	it("asks every read to skip the cache, whatever the device", async () => {
		const dev = await ghDevice([card("a")]);
		const seen: { url: string; headers: Record<string, string> }[] = [];
		const real = gh.request;
		gh.request = (p: Parameters<typeof real>[0]) => {
			if ((p.method ?? "GET") === "GET") seen.push({ url: p.url, headers: p.headers ?? {} });
			return real(p);
		};
		dev.resetGithubSync();
		await dev.github.chain;
		await sync(dev, "poll");
		await sync(dev, "poll");
		expect(seen.length).toBeGreaterThan(2);
		for (const r of seen) {
			expect(r.headers["Cache-Control"]).toBe("no-cache");
			expect(r.headers["Pragma"]).toBe("no-cache");
		}
		// …and no two polls share a URL, so no cache can answer one with the other's response
		expect(new Set(seen.map((r) => r.url)).size).toBe(seen.length);
	});
});

describe("prices alone are not worth an upload", () => {
	const priced = (id: string, usd: string, extra: Obj = {}) => card(id, { priceUsd: usd, priceEur: usd, ...extra });

	it("a price refresh (and its date) sends nothing; a real edit sends the new prices along", async () => {
		const dev = await ghDevice([priced("a", "1.00"), priced("b", "2.00")]);
		dev.resetGithubSync();
		await dev.github.chain;
		await sync(dev, "poll");
		const puts = gh.count("PUT");

		// What refreshAllPrices does: new prices, a new refresh date, no card date touched.
		for (const c of dev.settings.collection) c.priceUsd = "9.99";
		dev.settings.lastPriceRefresh = Date.now();
		dev.markGithubDirty();
		await sync(dev, "push");
		expect(gh.count("PUT")).toBe(puts);
		expect(dev.github.dirty).toBe(false);
		expect(remote().collection[0].priceUsd).toBe("1.00"); // GitHub keeps the old prices: nobody reads them

		// A real edit goes out, with the current prices.
		setNow(5000);
		dev.settings.collection[0].count = 4;
		dev.settings.collection[0].dateModified = 5000;
		dev.markGithubDirty();
		await sync(dev, "push");
		expect(gh.count("PUT")).toBe(puts + 1); // that one list's shard, with the current prices
		expect(remote().collection[0]).toMatchObject({ count: 4, priceUsd: "9.99" });
	});

	it("an edit made together with a price refresh is not swallowed", async () => {
		const dev = await ghDevice([priced("a", "1.00")]);
		dev.resetGithubSync();
		await dev.github.chain;
		await sync(dev, "poll");
		dev.settings.collection[0].priceUsd = "3.33";
		dev.settings.collection[0].count = 7;
		dev.settings.collection[0].dateModified = 6000;
		dev.markGithubDirty();
		await sync(dev, "push");
		expect(remote().collection[0]).toMatchObject({ count: 7, priceUsd: "3.33" });
	});

	it("after receiving a change, a later price refresh still sends nothing", async () => {
		const mac = await ghDevice([priced("a", "1.00")], 1000);
		mac.resetGithubSync();
		await mac.github.chain;
		const ipad = await cloneDevice(mac);
		enableGithub(ipad, gh);
		await sync(ipad, "startup");

		setNow(2000);
		mac.settings.collection.push(priced("m", "1.00", { dateAdded: 2000, dateModified: 2000 }));
		mac.markGithubDirty();
		await sync(mac, "push");
		await sync(ipad, "poll"); // the iPad now agrees with GitHub
		const puts = gh.count("PUT");
		for (const c of ipad.settings.collection) c.priceUsd = "5.55";
		ipad.settings.lastPriceRefresh = 123;
		ipad.markGithubDirty();
		await sync(ipad, "push");
		expect(gh.count("PUT")).toBe(puts);
	});
});

describe("the files on GitHub", () => {
	it("every file is gzip, a fraction of the data's size", async () => {
		const many = Array.from({ length: 800 }, (_, i) => card(`c${i}`, { imageUrl: `https://cards.scryfall.io/normal/front/a/b/${i}.jpg?1700000000`, oracleText: "Flying. Whenever this attacks, draw a card." }));
		const dev = await ghDevice(many);
		dev.resetGithubSync();
		await dev.github.chain;
		let total = 0;
		for (const name of ghShardNames(gh)) {
			const stored = gh.files.get(`${GH_DIR}/${name}`)!.bytes;
			expect([stored[0], stored[1]]).toEqual([0x1f, 0x8b]);
			total += stored.length;
		}
		expect(total).toBeLessThan(JSON.stringify(dev.settings).length / 5);
		expect(gh.files.has(GH_FILE)).toBe(false);
		expect(gh.files.has(GH_LEGACY_FILE)).toBe(false);
	});

	it("a push sends only the shard that changed: a list, a deck, or the common one", async () => {
		const dev = await ghDevice([card("a", { listId: "A" }), card("b", { listId: "B" })]);
		dev.settings.decks = [{ id: "D", name: "Deck", dateModified: 1, cards: [deckCard("d0")] }];
		dev.resetGithubSync();
		await dev.github.chain;
		expect(ghShardNames(gh)).toEqual(["core.json.gz", "deck-D.json.gz", "list-A.json.gz", "list-B.json.gz"]);
		const pushed = async (change: () => void) => {
			const before = gh.putPaths.length;
			setNow(Date.now() + 1000);
			change();
			dev.markGithubDirty();
			await sync(dev, "push");
			return gh.putPaths.slice(before).map((p: string) => p.slice(GH_DIR.length + 1));
		};
		expect(await pushed(() => Object.assign(dev.settings.collection[0], { count: 3, dateModified: Date.now() }))).toEqual(["list-A.json.gz"]);
		expect(await pushed(() => dev.settings.decks[0].cards.push(deckCard("d1", { dateModified: Date.now() })))).toEqual(["deck-D.json.gz"]);
		expect(await pushed(() => (dev.settings.accentColor = "red"))).toEqual(["core.json.gz"]);
	});

	it("a card moved to another list sends the two lists; the other device ends with ONE card, in the new list", async () => {
		const mac = await ghDevice([card("a", { listId: "A" }), card("b", { listId: "A" }), card("c", { listId: "B" })], 1000);
		mac.resetGithubSync();
		await mac.github.chain;
		const ipad = await cloneDevice(mac);
		enableGithub(ipad, gh);
		await sync(ipad, "startup");

		setNow(3000);
		Object.assign(mac.settings.collection[0], { listId: "B", dateModified: 3000 });
		mac.markGithubDirty();
		const before = gh.putPaths.length;
		await sync(mac, "push");
		expect(gh.putPaths.slice(before).map((p: string) => p.slice(GH_DIR.length + 1))).toEqual(["list-A.json.gz", "list-B.json.gz"]);
		await sync(ipad, "poll");
		expect(ids(ipad)).toEqual(["a", "b", "c"]);
		expect(ipad.settings.collection.find((c: Obj) => c.id === "a")!.listId).toBe("B");
		expect(remote().collection.filter((c: Obj) => c.id === "a")).toHaveLength(1);
	});

	it("a push cut short resumes with what is left and never resends what already went out", async () => {
		const dev = await ghDevice([card("a", { listId: "A" }), card("b", { listId: "B" })]);
		dev.resetGithubSync();
		await dev.github.chain;
		await sync(dev, "poll");
		const first = gh.putPaths.length;

		setNow(3000);
		Object.assign(dev.settings.collection[0], { count: 2, dateModified: 3000 });
		Object.assign(dev.settings.collection[1], { count: 2, dateModified: 3000 });
		dev.markGithubDirty();
		const real = gh.request;
		let puts = 0;
		gh.request = async (p: Parameters<typeof real>[0]) => {
			if (p.method === "PUT" && ++puts === 2) throw new Error("net::ERR_CONNECTION_RESET"); // the second one never arrives
			return real(p);
		};
		await sync(dev, "push");
		expect(dev.github.dirty).toBe(true);
		expect(dev.github.status.state).toBe("error");
		expect(gh.putPaths.length - first).toBe(1); // list A went out, list B did not

		gh.request = real;
		setNow(Date.now() + 10 * 60 * 1000);
		await sync(dev, "poll");
		expect(dev.github.dirty).toBe(false);
		expect(gh.putPaths.slice(first).map((p: string) => p.slice(GH_DIR.length + 1))).toEqual(["list-A.json.gz", "list-B.json.gz"]); // each exactly once
		expect(remote().collection.map((c: Obj) => c.count)).toEqual([2, 2]);
	});

	it("a list emptied on this device is emptied on GitHub too, instead of leaving its cards to a tombstone", async () => {
		const dev = await ghDevice([card("a", { listId: "A" }), card("b", { listId: "B" })], 1000);
		dev.resetGithubSync();
		await dev.github.chain;
		setNow(2000);
		dev.settings.collection = dev.settings.collection.filter((c: Obj) => c.listId !== "A");
		dev.markGithubDirty();
		await sync(dev, "push");
		expect(JSON.parse(gh.text(ghShard("list", "A"))!).collection).toEqual([]);
		expect(ids(dev)).toEqual(["b"]);
		expect(remote().collection.map((c: Obj) => c.id)).toEqual(["b"]);
	});

	it("stops with a clear message, once, when the web view cannot decompress", async () => {
		const dev = await ghDevice([card("a")]);
		gh.setFile(LIST_SHARD, JSON.stringify({ collection: [] }));
		const real = globalThis.DecompressionStream;
		(globalThis as { DecompressionStream?: unknown }).DecompressionStream = undefined;
		try {
			dev.resetGithubSync();
			await dev.github.chain;
		} finally {
			(globalThis as { DecompressionStream?: unknown }).DecompressionStream = real;
		}
		expect(dev.github.fatal).toBe(true);
		expect(githubStatusLine(dev as never)).toMatch(/cannot read the compressed/);
		expect(mocks.notices.filter((m) => m.includes("GitHub sync stopped"))).toHaveLength(1);
		expect(ids(dev)).toEqual(["a"]); // local data untouched
	});
});

// Les versions ≤ 1.0.511 gardaient tout dans UN fichier : data.json.gz (1.0.507 à 1.0.511), data.json (≤ 1.0.506).
describe("migration from the single file of earlier versions", () => {
	const legacy = () => ({
		collection: [card("old1", { listId: "A" }), card("old2", { listId: "B" })],
		lists: [
			{ id: "A", name: "A", dateModified: 1 },
			{ id: "B", name: "B", dateModified: 1 },
		],
		priceCurrency: "EUR",
	});
	const legacyReads = (path: string) => gh.rawPaths.filter((p) => p === path).length;

	for (const [label, path] of [
		["data.json.gz (1.0.507 to 1.0.511)", GH_FILE],
		["the plain data.json (1.0.506 and before)", GH_LEGACY_FILE],
	] as const) {
		it(`${label}: merged with the device's own data, split into shards, the old file left alone and read once`, async () => {
			gh.setFile(path, JSON.stringify(legacy()));
			const before = gh.files.get(path)!.sha;
			const dev = await ghDevice([card("mine", { listId: "A" })]);
			dev.resetGithubSync();
			await dev.github.chain;
			await dev.persistChain;
			expect(ids(dev)).toEqual(["mine", "old1", "old2"]); // merged, nothing lost
			expect(remote().collection.map((c: Obj) => c.id).sort()).toEqual(["mine", "old1", "old2"]);
			expect(ghShardNames(gh)).toEqual(["core.json.gz", "list-A.json.gz", "list-B.json.gz"]);
			expect(gh.putPaths.at(-1)).toBe(GH_CORE); // the common shard last
			expect(gh.files.get(path)!.sha).toBe(before); // never rewritten or deleted
			expect(legacyReads(path)).toBe(1);

			// A second device finds the shards and never touches the old file.
			const other = await deviceWith();
			enableGithub(other, gh);
			other.resetGithubSync();
			await other.github.chain;
			await other.persistChain;
			expect(ids(other)).toEqual(["mine", "old1", "old2"]);
			await sync(dev, "poll");
			await sync(dev, "poll");
			expect(legacyReads(path)).toBe(1);
		});
	}

	it("when both old files exist, the compressed one wins (it was seeded from the plain one)", async () => {
		gh.setFile(GH_LEGACY_FILE, JSON.stringify({ collection: [card("plain")] }));
		gh.setFile(GH_FILE, JSON.stringify({ collection: [card("gz", { listId: "A" })] }));
		const dev = await seededDevice([]);
		enableGithub(dev, gh);
		dev.resetGithubSync();
		await dev.github.chain;
		expect(ids(dev)).toEqual(["gz"]);
		expect(legacyReads(GH_LEGACY_FILE)).toBe(0);
	});

	it("a migration cut short is finished by the next device that looks: the common shard was not written yet", async () => {
		gh.setFile(GH_FILE, JSON.stringify(legacy()));
		const a = await ghDevice([card("a1", { listId: "A" })]);
		const real = gh.request;
		let puts = 0;
		gh.request = async (p: Parameters<typeof real>[0]) => {
			if (p.method === "PUT" && ++puts === 2) throw new Error("net::ERR_CONNECTION_RESET");
			return real(p);
		};
		a.resetGithubSync();
		await a.github.chain;
		gh.request = real;
		expect(gh.files.has(GH_CORE)).toBe(false); // cut short: some list shards, no common shard
		expect(ghShardNames(gh).length).toBeGreaterThan(0);

		const b = await seededDevice([]);
		enableGithub(b, gh);
		b.resetGithubSync();
		await b.github.chain;
		expect(gh.files.has(GH_CORE)).toBe(true); // finished
		expect(ids(b)).toEqual(["a1", "old1", "old2"]); // the old file's data came through too
		expect(remote().collection.map((c: Obj) => c.id).sort()).toEqual(["a1", "old1", "old2"]);
	});

	it("two devices migrating at the same time end up with everything", async () => {
		gh.setFile(GH_FILE, JSON.stringify(legacy()));
		const a = await ghDevice([card("a1", { listId: "A" })]);
		const b = await seededDevice([card("b1", { listId: "A" })]);
		enableGithub(b, gh);
		a.resetGithubSync();
		b.resetGithubSync();
		await Promise.all([a.github.chain, b.github.chain]);
		for (let i = 0; i < 3; i++) {
			setNow(Date.now() + 60_000);
			await sync(a, "poll");
			await sync(b, "poll");
		}
		expect(ids(a)).toEqual(["a1", "b1", "old1", "old2"]);
		expect(ids(b)).toEqual(["a1", "b1", "old1", "old2"]);
		expect(remote().collection.map((c: Obj) => c.id).sort()).toEqual(["a1", "b1", "old1", "old2"]);
	});

	it("a device still on the old version keeps writing its file: nobody reads it any more, nothing breaks", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		gh.setFile(GH_FILE, JSON.stringify({ collection: [card("stale")] })); // an old device wrote it
		await sync(dev, "poll");
		await sync(dev, "manual");
		expect(dev.github.status.state).toBe("idle");
		expect(ids(dev)).toEqual(["a"]);
	});

	it("a repository with nothing in it is simply created, without any pointless read", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		expect(gh.rawPaths).toEqual([]);
		expect(remote().collection).toHaveLength(1);
	});
});

describe("failures", () => {
	it("offline: keeps the work, backs off, and sends everything once back", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		gh.offline = true;
		dev.settings.collection.push(card("b", { dateModified: 5000 }));
		dev.markGithubDirty();
		await sync(dev, "push");
		expect(dev.github.status.state).toBe("error");
		expect(githubStatusLine(dev as never)).toMatch(/Could not reach GitHub/);
		expect(dev.github.dirty).toBe(true);
		expect(dev.github.fatal).toBe(false);

		gh.offline = false;
		gh.calls.length = 0;
		await sync(dev, "poll"); // still inside the backoff: no request at all
		expect(gh.calls).toEqual([]);
		setNow(1_000_000 + 10 * 60 * 1000);
		await sync(dev, "poll");
		expect(remote().collection).toHaveLength(2);
		expect(dev.github.status.state).toBe("idle");
		expect(dev.github.failures).toBe(0);
	});

	it("a rejected token stops the sync with one notice, until the user acts", async () => {
		const dev = await ghDevice([card("a")]);
		gh.token = "something-else";
		dev.resetGithubSync();
		await dev.github.chain;
		expect(dev.github.fatal).toBe(true);
		expect(mocks.notices.filter((m) => m.includes("GitHub sync stopped"))).toHaveLength(1);
		gh.calls.length = 0;
		await sync(dev, "poll");
		await sync(dev, "poll");
		expect(gh.calls).toEqual([]);
		expect(mocks.notices).toHaveLength(1);

		dev.setGithubToken(gh.token); // the user pastes the right one
		dev.resetGithubSync();
		await dev.github.chain;
		expect(dev.github.fatal).toBe(false);
		expect(remote().collection).toHaveLength(1);
	});

	it("a file on GitHub that is not JSON is neither merged nor overwritten", async () => {
		const dev = await ghDevice([card("a")]);
		gh.setFile(GH_CORE, "<<<<<<< merge conflict markers");
		dev.resetGithubSync();
		await dev.github.chain;
		expect(dev.github.fatal).toBe(true);
		expect(gh.text(GH_CORE)).toBe("<<<<<<< merge conflict markers");
		expect(ids(dev)).toEqual(["a"]);
		expect(githubStatusLine(dev as never)).toMatch(/not valid JSON/);
	});

	it("gives up cleanly when GitHub keeps changing under it", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		dev.settings.collection.push(card("b", { dateModified: 5000 }));
		dev.markGithubDirty();
		const real = gh.request;
		let n = 0;
		gh.request = async (p: Parameters<typeof real>[0]) => {
			if (p.method === "PUT") gh.beforePut = () => gh.setFile(LIST_SHARD, JSON.stringify({ collection: [card(`other${n++}`)] }));
			return real(p);
		};
		await sync(dev, "push");
		expect(dev.github.status.state).toBe("error");
		expect(dev.github.fatal).toBe(false);
		expect(dev.github.dirty).toBe(true);
	});
});

describe("flaky networks", () => {
	it("a request that hangs does not block the sync: it times out, and the next cycle works", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		dev.github.requestTimeoutMs = 40;
		const real = gh.request;
		gh.request = () => new Promise(() => {}); // the connection stalls: no answer, no error
		await sync(dev, "manual"); // must come back by itself
		expect(dev.github.status.state).toBe("error");
		expect(githubStatusLine(dev as never)).toMatch(/no answer after/);
		expect(dev.github.fatal).toBe(false);
		gh.request = real;
		await sync(dev, "manual");
		expect(dev.github.status.state).toBe("idle");
	});

	it("after a network failure it retries within seconds, not minutes", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		gh.offline = true;
		for (let i = 0; i < 6; i++) {
			dev.github.retryAt = 0;
			await sync(dev, "poll");
		}
		expect(dev.github.failures).toBe(6);
		expect(dev.github.retryAt - Date.now()).toBeLessThanOrEqual(15_000); // capped at 15 s, was 5 minutes
		expect(githubStatusLine(dev as never)).toMatch(/Failed 6 times in a row/);
	});

	it("coming back to the app (focus) or tapping Sync now does not wait for a network backoff", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		gh.offline = true;
		await sync(dev, "poll"); // fails, now inside its backoff
		gh.offline = false;
		gh.calls.length = 0;
		await sync(dev, "poll");
		expect(gh.calls).toEqual([]); // a plain poll waits
		await sync(dev, "focus");
		expect(gh.calls.length).toBeGreaterThan(0); // the user came back: try now
		expect(dev.github.status.state).toBe("idle");
	});

	it("but a rate limit from GitHub is respected even when the user comes back", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		const real = gh.request;
		gh.request = async (p: Parameters<typeof real>[0]) => ({ ...(await real(p)), status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "90" }, json: {} });
		await sync(dev, "poll");
		expect(dev.github.rateLimited).toBe(true);
		gh.request = real;
		gh.calls.length = 0;
		await sync(dev, "focus");
		expect(gh.calls).toEqual([]);
		await sync(dev, "manual"); // an explicit tap is the user's call
		expect(gh.calls.length).toBeGreaterThan(0);
	});

	it("says when the last success was, in the error status", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		gh.offline = true;
		await sync(dev, "poll");
		expect(githubStatusLine(dev as never)).toMatch(/Last success:/);
	});
});

describe("the status shown on Home", () => {
	it("shows nothing while the sync is off, then follows the engine", async () => {
		const dev = await seededDevice([card("a")]);
		expect(dev.githubHomeStatus()).toBeNull();

		enableGithub(dev, gh);
		expect(dev.githubHomeStatus()!.text).toBe("Syncing with GitHub…"); // on, nothing exchanged yet
		dev.resetGithubSync();
		await dev.github.chain;
		const ok = dev.githubHomeStatus()!;
		expect(ok.tone).toBe("ok");
		expect(ok.text).toMatch(/^Synced with GitHub — checked at /);
	});

	it("says when GitHub cannot be reached, and that nothing is lost", async () => {
		const dev = await ghDevice([card("a")]);
		dev.resetGithubSync();
		await dev.github.chain;
		gh.offline = true;
		dev.settings.collection.push(card("b", { dateModified: 5000 }));
		dev.markGithubDirty();
		await sync(dev, "push");
		const s = dev.githubHomeStatus()!;
		expect(s.tone).toBe("warn");
		expect(s.text).toMatch(/last synced at/);
		expect(s.text).toMatch(/kept on this device/);
		expect(s.text).not.toMatch(/net::|ERR_/); // the technical cause stays in the settings

		gh.offline = false;
		setNow(1_000_000 + 10 * 60 * 1000);
		await sync(dev, "poll");
		expect(dev.githubHomeStatus()!.tone).toBe("ok"); // back to green by itself
	});

	it("a rejected token is an error that points to the settings", async () => {
		const dev = await ghDevice([card("a")]);
		gh.token = "something-else";
		dev.resetGithubSync();
		await dev.github.chain;
		const s = dev.githubHomeStatus()!;
		expect(s.tone).toBe("error");
		expect(s.text).toMatch(/rejected the token/);
		expect(s.text).toMatch(/Open the settings/);
	});

	it("needs a token as well as a repository", async () => {
		const dev = await seededDevice([card("a")]);
		enableGithub(dev, gh);
		dev.setGithubToken("");
		expect(dev.githubHomeStatus()!.tone).toBe("warn");
		expect(dev.githubHomeStatus()!.text).toMatch(/repository and a token/);
	});

	it("tells subscribers about every change, until they unsubscribe — and survives a configuration reset", async () => {
		const dev = await ghDevice([card("a")]);
		const seen: string[] = [];
		const stop = dev.subscribeGithubStatus(() => seen.push(dev.github.status.state));
		dev.resetGithubSync(); // resets the engine's state: the subscription must stay
		await dev.github.chain;
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[seen.length - 1]).toBe("idle");

		const before = seen.length;
		await sync(dev, "poll");
		expect(seen.length).toBeGreaterThan(before); // a poll rewrites the status too (that is how Home stays current)

		stop();
		const after = seen.length;
		await sync(dev, "poll");
		expect(seen.length).toBe(after);
	});

	it("a listener that throws never breaks the sync", async () => {
		const dev = await ghDevice([card("a")]);
		dev.subscribeGithubStatus(() => {
			throw new Error("view is closing");
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		dev.resetGithubSync();
		await dev.github.chain;
		warn.mockRestore();
		expect(dev.github.status.state).toBe("idle");
		expect(remote().collection).toHaveLength(1); // the data still reached GitHub
	});
});

describe("how often it polls", () => {
	it("is fast when the window is visible, slow when it is hidden and nothing happened", () => {
		expect(pollIntervalMs(true, 5000, 0)).toBe(GITHUB_POLL_ACTIVE_MS);
		expect(pollIntervalMs(false, 5000, 0)).toBe(GITHUB_POLL_IDLE_MS);
		expect(GITHUB_POLL_ACTIVE_MS).toBeLessThan(GITHUB_POLL_IDLE_MS);
	});

	it("stays fast for a while after activity even if the window gets hidden, then slows down", () => {
		expect(pollIntervalMs(false, 5000, 5001)).toBe(GITHUB_POLL_ACTIVE_MS);
		expect(pollIntervalMs(false, 5000, 5000)).toBe(GITHUB_POLL_IDLE_MS); // the window is over at that very instant
	});

	it("a poll is due once a whole interval has passed since the last one", () => {
		expect(pollDue(true, 10_000, 8_000, 0)).toBe(true);
		expect(pollDue(true, 10_000, 8_001, 0)).toBe(false);
		expect(pollDue(false, 17_000, 8_000, 0)).toBe(false);
		expect(pollDue(false, 18_000, 8_000, 0)).toBe(true);
		expect(GITHUB_TICK_MS).toBeLessThanOrEqual(GITHUB_POLL_ACTIVE_MS / 2); // the timer beats faster than the fastest pace
	});

	// Le minuteur réel (setupGithubSync) : un battement par seconde, un sondage seulement quand il est dû.
	describe("the timer", () => {
		let beat: () => void;
		let handlers: Record<string, () => void>;
		let visibility: string;
		let dev: Obj;

		beforeEach(async () => {
			visibility = "visible";
			vi.stubGlobal("document", {
				get visibilityState() {
					return visibility;
				},
			});
			vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
				beat = fn;
				return 1;
			}) as never);
			handlers = {};
			dev = await ghDevice([card("a")]);
			dev.registerInterval = vi.fn();
			dev.registerDomEvent = vi.fn((_t: unknown, event: string, cb: () => void) => {
				handlers[event] = cb;
			});
			dev.resetGithubSync(); // first sync, and a clean state (no activity)
			await dev.github.chain;
		});
		afterEach(() => {
			vi.restoreAllMocks();
			delete (globalThis as { document?: unknown }).document;
		});

		// Fait battre le minuteur chaque seconde pendant `seconds`, rend le nombre de requêtes de lecture faites.
		const beatFor = async (seconds: number) => {
			const before = gh.count("GET");
			for (let i = 0; i < seconds; i++) {
				setNow(Date.now() + 1000);
				beat();
				await dev.github.chain;
			}
			return gh.count("GET") - before;
		};

		it("polls every 2 s while the window is visible", async () => {
			dev.setupGithubSync();
			await dev.github.chain;
			expect(await beatFor(20)).toBe(10);
		});

		it("polls only every 10 s while hidden", async () => {
			dev.setupGithubSync();
			await dev.github.chain;
			visibility = "hidden";
			setNow(Date.now() + GITHUB_ACTIVE_WINDOW_MS + 1000); // nothing happened for a while
			expect(await beatFor(20)).toBe(2);
		});

		it("an edit made here keeps the fast pace for a minute, hidden or not", async () => {
			dev.setupGithubSync();
			await dev.github.chain;
			visibility = "hidden";
			setNow(Date.now() + GITHUB_ACTIVE_WINDOW_MS + 1000);
			dev.markGithubDirty(); // activity
			expect(dev.github.activeUntil).toBe(Date.now() + GITHUB_ACTIVE_WINDOW_MS);
			await dev.flushGithubSync(); // sends it (the push is not the point here)
			expect(await beatFor(20)).toBe(10); // still fast
			setNow(dev.github.activeUntil + 1000);
			expect(await beatFor(20)).toBe(2); // the minute is over: slow again
		});

		it("coming back to the app syncs at once and wakes the fast pace", async () => {
			dev.setupGithubSync();
			await dev.github.chain;
			visibility = "hidden";
			setNow(Date.now() + GITHUB_ACTIVE_WINDOW_MS + 1000);
			const before = gh.count("GET");
			visibility = "visible";
			handlers.visibilitychange();
			await dev.github.chain;
			expect(gh.count("GET")).toBeGreaterThan(before); // an immediate sync
			expect(dev.github.activeUntil).toBe(Date.now() + GITHUB_ACTIVE_WINDOW_MS);
		});

		it("receiving a change from another device also wakes the fast pace", async () => {
			const other = await cloneDevice(dev);
			enableGithub(other, gh);
			await sync(other, "startup");
			setNow(Date.now() + 5000);
			other.settings.collection.push(card("m", { dateAdded: Date.now(), dateModified: Date.now() }));
			other.markGithubDirty();
			await sync(other, "push");

			dev.github.activeUntil = 0;
			await sync(dev, "poll");
			expect(ids(dev)).toContain("m");
			expect(dev.github.activeUntil).toBeGreaterThan(Date.now()); // the other device is active: stay responsive
		});
	});
});

describe("a brand-new device joining", () => {
	it("adopts a setting chosen long ago instead of overwriting it with its default", async () => {
		// The Mac's currency was chosen before settings were stamped: it is in its data.json with no syncStamps.
		const mac = await deviceWith({ text: JSON.stringify({ priceCurrency: "eur", collection: [card("a")] }), mtime: 1000 });
		enableGithub(mac, gh);
		mac.resetGithubSync();
		await mac.github.chain;
		expect(JSON.parse(gh.text(GH_CORE)!).priceCurrency).toBe("eur");
		const puts = gh.count("PUT");

		const fresh = await deviceWith(); // defaults: priceCurrency "usd"
		expect(fresh.settings.priceCurrency).toBe("usd");
		enableGithub(fresh, gh);
		fresh.resetGithubSync();
		await fresh.github.chain;
		await fresh.persistChain;
		expect(fresh.settings.priceCurrency).toBe("eur"); // the user's choice, not the default
		expect(gh.count("PUT")).toBe(puts); // nothing sent back

		await sync(mac, "poll");
		await sync(mac, "poll");
		expect(mac.settings.priceCurrency).toBe("eur");
		expect(JSON.parse(gh.text(GH_CORE)!).priceCurrency).toBe("eur");
	});

	it("a currency the user changes on purpose still travels, in both directions", async () => {
		const mac = await ghDevice([card("a")], 1000);
		mac.resetGithubSync();
		await mac.github.chain;
		const ipad = await cloneDevice(mac);
		enableGithub(ipad, gh);
		await sync(ipad, "startup");

		setNow(3000);
		mac.settings.priceCurrency = "eur"; // a real change: stamped when saved
		mac.markGithubDirty();
		await sync(mac, "push");
		await sync(ipad, "poll");
		expect(ipad.settings.priceCurrency).toBe("eur");

		setNow(6000);
		ipad.settings.priceCurrency = "usd"; // back to the default, on purpose
		ipad.markGithubDirty();
		await sync(ipad, "push");
		await sync(mac, "poll");
		expect(mac.settings.priceCurrency).toBe("usd"); // an explicit choice is not mistaken for "untouched"
	});
});

describe("alongside Syncthing", () => {
	it("an edit reaching a device by BOTH channels is merged twice and sent once", async () => {
		const mac = await ghDevice([card("a")], 1000);
		mac.resetGithubSync();
		await mac.github.chain;
		const ipad = await cloneDevice(mac);
		enableGithub(ipad, gh);
		await sync(ipad, "startup");
		gh.calls.length = 0;

		setNow(2000);
		mac.settings.collection.push(card("n", { dateAdded: 2000, dateModified: 2000 }));
		await mac.persistSettings(); // data.json (Syncthing)
		mac.markGithubDirty();
		await sync(mac, "push"); // GitHub
		deliver(mac.fs, ipad.fs); // Syncthing gets there first…
		await ipad.checkForExternalChange();
		expect(ids(ipad)).toEqual(["a", "n"]);
		await sync(ipad, "poll"); // …then GitHub: nothing new, and nothing to send
		await sync(ipad, "poll");
		expect(gh.count("PUT")).toBe(1);
		expect(ipad.github.dirty).toBe(false);
	});
});

/* ------------------ sessions aléatoires : trois appareils, GitHub seul ---------- */

function mulberry32(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("random sessions through GitHub", () => {
	// Trois appareils, des centaines d'opérations, des pannes réseau, des appareils qui ne se
	// synchronisent que de temps en temps. Invariants : convergence, aucune carte jamais supprimée
	// perdue, aucune carte supprimée et jamais retouchée ressuscitée, et surtout STABILITÉ — une fois
	// convergés, plus aucun envoi ni aucune écriture (pas de ping-pong avec GitHub, ni avec Syncthing
	// quand les deux canaux sont actifs). La moitié des sessions ajoutent des livraisons Syncthing.
	const MARGIN_MS = 10_000;
	const SEEDS = Number(process.env.SYNC_STRESS_SEEDS ?? 25);
	const STEPS = Number(process.env.SYNC_STRESS_STEPS ?? 120);
	for (let seed = 1; seed <= SEEDS; seed++) {
		it(`seed ${seed}${seed % 2 === 0 ? " (+ Syncthing)" : ""}`, async () => {
			const rnd = mulberry32(seed);
			const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
			const hybrid = seed % 2 === 0;
			let t = 10_000;
			setNow(t);
			const base = await deviceWith();
			// Plusieurs listes : les cartes se répartissent sur plusieurs fragments, et les déplacements entre listes
			// (une carte dans DEUX fragments un instant) font partie de la session.
			const LISTS = ["L1", "L2", "L3"];
			base.settings.collection = [card("c0", { listId: "L1" }), card("c1", { listId: "L2" }), card("c2", { listId: "L3" })];
			base.settings.decks = [{ id: "D", name: "Deck", cards: [deckCard("d0"), deckCard("d1")] }];
			await base.persistSettings();
			const devices = [base, await cloneDevice(base), await cloneDevice(base)];
			for (const d of devices) enableGithub(d, gh);

			let nextId = 0;
			const keys = ["c0", "c1", "c2", "deck:d0", "deck:d1"];
			const lastTouched = new Map<string, number>(keys.map((k) => [k, 100]));
			const lastDeleted = new Map<string, number>();
			const everDeleted = new Set<string>();

			for (let step = 0; step < STEPS; step++) {
				t += 1000;
				setNow(t);
				const dev = pick(devices);
				const op = rnd();
				const list: Obj[] = dev.settings.collection;
				const deck = dev.settings.decks[0];
				let deletion = false;
				if (op < 0.2) {
					const id = `n${nextId++}`;
					list.push(card(id, { listId: pick(LISTS), dateAdded: t, dateModified: t }));
					lastTouched.set(id, t);
					keys.push(id);
				} else if (op < 0.33 && list.length) {
					const c = pick(list);
					c.listId = pick(LISTS); // moved (or not: the same list is a no-op that still counts as a touch)
					c.dateModified = t;
					lastTouched.set(c.id, t);
				} else if (op < 0.4 && list.length) {
					const c = pick(list);
					c.count++;
					c.dateModified = t;
					lastTouched.set(c.id, t);
				} else if (op < 0.5 && list.length) {
					pick(list).priceUsd = String(rnd());
				} else if (op < 0.65 && list.length) {
					const c = pick(list);
					dev.settings.collection = list.filter((x) => x.id !== c.id);
					lastDeleted.set(c.id, t);
					everDeleted.add(c.id);
					deletion = true;
				} else if (op < 0.75) {
					const sid = `dn${nextId++}`;
					deck.cards.push(deckCard(sid, { dateAdded: t, dateModified: t }));
					lastTouched.set(`deck:${sid}`, t);
					keys.push(`deck:${sid}`);
				} else if (op < 0.85 && deck.cards.length) {
					const c = pick(deck.cards as Obj[]);
					deck.cards = deck.cards.filter((x: Obj) => x !== c);
					lastDeleted.set(`deck:${c.scryfallId}`, t);
					everDeleted.add(`deck:${c.scryfallId}`);
					deletion = true;
				} else if (op < 0.92) {
					dev.settings.accentColor = pick(["", "red", "blue"]);
				} else {
					dev.settings.collectionViewMode = pick(["list", "grid", "card"]); // per-device: must never travel
				}
				dev.dataVersion++;
				dev.markGithubDirty();
				if (deletion || rnd() < 0.8) await dev.persistSettings();

				if (rnd() < 0.08) gh.offline = !gh.offline;
				if (rnd() < 0.5) await pick(devices).githubSync(pick(["poll", "push", "flush"]));
				if (hybrid && rnd() < 0.3) {
					const from = pick(devices);
					const to = pick(devices);
					if (from !== to && deliver(from.fs, to.fs)) await to.checkForExternalChange();
				}
			}

			// Règlement : le réseau revient, chaque appareil échange jusqu'à stabilité.
			gh.offline = false;
			const settled = () => devices.every((d) => settingsEqual(d.settings, devices[0].settings));
			for (let round = 0; round < 12 && !(round > 0 && settled()); round++) {
				for (const d of devices) {
					t += 60_000;
					setNow(t);
					await d.persistSettings();
					await sync(d, "manual");
					if (hybrid) {
						for (const other of devices) if (other !== d && deliver(d.fs, other.fs)) await other.checkForExternalChange();
					}
				}
			}
			expect(settled(), "devices did not converge").toBe(true);

			// Stabilité : deux tours de plus ne doivent plus rien envoyer ni écrire.
			const puts = gh.count("PUT");
			const writes = devices.map((d) => d.fs.dataWrites);
			for (let extra = 0; extra < 2; extra++) {
				for (const d of devices) {
					t += 60_000;
					setNow(t);
					await sync(d, "manual");
					await d.checkForExternalChange();
				}
			}
			expect(gh.count("PUT"), "GitHub kept receiving writes after convergence").toBe(puts);
			expect(devices.map((d) => d.fs.dataWrites), "data.json kept being rewritten after convergence").toEqual(writes);

			expect(shardTexts().join("\n")).not.toContain("collectionViewMode");
			const present = new Set<string>([
				...devices[0].settings.collection.map((x: Obj) => x.id),
				...devices[0].settings.decks[0].cards.map((x: Obj) => `deck:${x.scryfallId}`),
			]);
			for (const k of keys) {
				const touched = lastTouched.get(k) ?? 0;
				const deleted = lastDeleted.get(k) ?? 0;
				if (!everDeleted.has(k)) expect(present.has(k), `${k} was never deleted but is gone`).toBe(true);
				else if (deleted - touched > MARGIN_MS) expect(present.has(k), `${k} came back`).toBe(false);
				else if (touched - deleted > MARGIN_MS) expect(present.has(k), `${k} was edited after its deletion but is gone`).toBe(true);
			}
		});
	}
});
