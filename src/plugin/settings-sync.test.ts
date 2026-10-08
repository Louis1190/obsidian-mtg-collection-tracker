import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_SETTINGS } from "../core/data-model";
import { settingsEqual } from "../core/settings-merge";
import {
	normalizeDataFolder,
	CUSTOM_DATA_FILE_NAME,
	DEVICE_SETTINGS_STORAGE_KEY,
	BIG_REMOVAL_THRESHOLD,
	BIG_ADDITION_THRESHOLD,
	SYNC_BACKUP_KEEP,
} from "./settings-sync";

// settings-sync.ts imports Notice/normalizePath from "obsidian" at module
// level (the npm package only provides types) — same constraint as
// file-export.test.ts. The `this` values are minimal fake plugins: all the
// module's functions take `this` as a parameter (see CLAUDE.md, Phase 5), so
// no real instance of MTGCollectionPlugin is needed. Two fake devices share
// the SAME logic but each have their own file system; "Syncthing" is
// simulated by copying data.json (mtime preserved) from one to the other.
const mocks = vi.hoisted(() => ({ notices: [] as string[] }));

vi.mock("obsidian", () => ({
	Notice: class {
		constructor(message: string) {
			mocks.notices.push(message);
		}
	},
	normalizePath: (p: string) => p.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, ""),
}));

vi.stubGlobal("window", globalThis);

import {
	Obj,
	DATA,
	FakeFs,
	deliver,
	makeDevice,
	boot,
	card,
	deckCard,
	ids,
	setNow,
	deviceWith,
	seededDevice,
	cloneDevice,
	disposeDevices,
} from "./__tests__/sync-test-harness";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000_000);
	mocks.notices.length = 0;
});
afterEach(() => {
	disposeDevices();
	vi.useRealTimers();
});

/* ----------------------------------- tests -------------------------------- */

describe("loading", () => {
	it("starts empty when there is no data.json, and records nothing about the disk", async () => {
		const dev = await deviceWith();
		expect(dev.settings.collection).toEqual([]);
		expect(dev.syncBaseText).toBeNull();
		expect(dev.settingsLoaded).toBe(true);
	});

	it("reads the existing file and remembers its text and signature", async () => {
		const a = await seededDevice([card("a")]);
		const b = await cloneDevice(a);
		expect(ids(b)).toEqual(["a"]);
		expect(b.syncBaseText).toBe(a.fs.data()!.text);
		expect(b.diskSig).toEqual({ mtime: a.fs.data()!.mtime, size: a.fs.data()!.text.length });
	});

	it("keeps a copy of an unreadable data.json instead of silently overwriting it", async () => {
		setNow(5000);
		const dev = await deviceWith({ text: '{"collection": [ {"id": "a"', mtime: 1 });
		expect(dev.settings.collection).toEqual([]);
		const copies = [...dev.fs.files.keys()].filter((k) => k.includes("data.unreadable-"));
		expect(copies).toHaveLength(1);
		expect(dev.fs.files.get(copies[0]).text).toBe('{"collection": [ {"id": "a"');
		expect(mocks.notices.some((m) => m.includes("could not be read"))).toBe(true);
	});
});

describe("writing", () => {
	it("writes the settings and records the signature it produced", async () => {
		const dev = await seededDevice([card("a")]);
		const f = dev.fs.data()!;
		expect(JSON.parse(f.text).collection).toHaveLength(1);
		expect(dev.diskSig).toEqual({ mtime: f.mtime, size: f.text.length });
	});

	it("does not rewrite (or touch) the file when nothing changed", async () => {
		const dev = await seededDevice([card("a")], 1000);
		const before = dev.fs.data()!.mtime;
		setNow(9000);
		await dev.persistSettings();
		expect(dev.fs.data()!.mtime).toBe(before);
	});

	it("does not re-read the file after its own write (signature fast path)", async () => {
		const dev = await seededDevice([card("a")]);
		dev.fs.reads = 0;
		await dev.checkForExternalChange();
		expect(dev.fs.reads).toBe(0);
	});

	it("serializes concurrent saves instead of interleaving them", async () => {
		const dev = await deviceWith();
		setNow(2000);
		dev.settings.collection.push(card("a"));
		const p1 = dev.persistSettings();
		dev.settings.collection.push(card("b"));
		const p2 = dev.persistSettings();
		await Promise.all([p1, p2]);
		expect(JSON.parse(dev.fs.data()!.text).collection.map((c: Obj) => c.id)).toEqual(["a", "b"]);
	});

	it("a failing write is reported as a failure, not silently dropped", async () => {
		const dev = await deviceWith();
		dev.settings.collection.push(card("a"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		dev.fs.adapter.write = async () => {
			throw new Error("disk full");
		};
		await dev.persistSettings();
		expect(dev.saveFailed).toBe(true);
		expect(dev.diskText).toBeNull();
		errors.mockRestore();
		if (dev.saveRetryTimer !== null) clearTimeout(dev.saveRetryTimer);
	});
});

describe("two devices", () => {
	it("adopts a newer version from the other device, live, without writing anything back", async () => {
		const mac = await seededDevice([card("a")], 1000);
		const ipad = await cloneDevice(mac);
		const heldCard = ipad.settings.collection[0];

		setNow(2000);
		mac.settings.collection.push(card("b", { dateAdded: 2000, dateModified: 2000 }));
		mac.settings.collection[0].count = 5;
		mac.settings.collection[0].dateModified = 2000;
		await mac.persistSettings();

		expect(deliver(mac.fs, ipad.fs)).toBe(true);
		const mtimeAfterDelivery = ipad.fs.data()!.mtime;
		await ipad.onExternalSettingsChange();

		expect(ids(ipad)).toEqual(["a", "b"]);
		expect(ipad.settings.collection[0]).toBe(heldCard); // an open card modal stays alive
		expect(heldCard.count).toBe(5);
		expect(ipad.refreshOpenViews).toHaveBeenCalled();
		expect(ipad.dataVersion).toBeGreaterThan(0);
		expect(ipad.fs.data()!.mtime).toBe(mtimeAfterDelivery); // adopted, not rewritten
		expect(ipad.syncBaseText).toBe(mac.fs.data()!.text);
	});

	it("does not fire a refresh when the other device changed nothing we care about", async () => {
		const mac = await seededDevice([card("a")], 1000);
		const ipad = await cloneDevice(mac);
		setNow(2000);
		ipad.fs.files.set(DATA, { text: mac.fs.data()!.text, mtime: 2000 }); // same content, mtime touched up
		await ipad.checkForExternalChange();
		expect(ipad.refreshOpenViews).not.toHaveBeenCalled();
	});

	it.each([
		["Mac's file reaches the iPad first", "mac"],
		["iPad's file reaches the Mac first", "ipad"],
	])("concurrent additions are both kept and the devices converge (%s)", async (_label, first) => {
		const mac = await seededDevice([card("a")], 1000);
		const ipad = await cloneDevice(mac);

		setNow(2000);
		mac.settings.collection.push(card("x", { dateAdded: 2000, dateModified: 2000 }));
		await mac.persistSettings();
		setNow(2500);
		ipad.settings.collection.push(card("y", { dateAdded: 2500, dateModified: 2500 }));
		await ipad.persistSettings();

		const [src, dst] = first === "mac" ? [mac, ipad] : [ipad, mac];
		setNow(3000);
		// The incoming file is more recent than the destination's.
		src.fs.files.set(DATA, { ...src.fs.data()!, mtime: 2900 });
		dst.fs.files.get(DATA)!.mtime = 2600;
		expect(deliver(src.fs, dst.fs)).toBe(true);
		await dst.checkForExternalChange();
		expect(ids(dst)).toEqual(["a", "x", "y"]);

		setNow(3500);
		deliver(dst.fs, src.fs);
		await src.checkForExternalChange();
		expect(ids(src)).toEqual(["a", "x", "y"]);
		expect(settingsEqual(src.settings, dst.settings)).toBe(true);
	});

	it("keeps a safety copy of the foreign version before overwriting it with a merged one", async () => {
		const mac = await seededDevice([card("a")], 1000);
		const ipad = await cloneDevice(mac);
		setNow(2000);
		mac.settings.collection.push(card("x", { dateModified: 2000 }));
		await mac.persistSettings();
		setNow(2200);
		ipad.settings.collection.push(card("y", { dateModified: 2200 }));
		await ipad.persistSettings();
		deliver(mac.fs, ipad.fs); // mac older than ipad: doesn't replace
		ipad.fs.files.set(DATA, { text: mac.fs.data()!.text, mtime: 2300 });
		setNow(2400);
		await ipad.checkForExternalChange();
		await ipad.persistChain;
		await vi.waitFor(() => expect(ipad.fs.backups("remote")).toHaveLength(1));
		expect(ipad.fs.files.get(ipad.fs.backups("remote")[0])!.text).toBe(mac.fs.data()!.text);
	});

	it("keeps only the most recent safety copies", async () => {
		const mac = await seededDevice([card("a")], 1000);
		const ipad = await cloneDevice(mac);
		for (let i = 0; i < SYNC_BACKUP_KEEP + 2; i++) {
			const t = 2000 + i * 1000;
			setNow(t);
			mac.settings.collection.push(card(`m${i}`, { dateModified: t }));
			await mac.persistSettings();
			setNow(t + 300);
			ipad.settings.collection.push(card(`i${i}`, { dateModified: t + 300 }));
			await ipad.persistSettings();
			ipad.fs.files.set(DATA, { text: mac.fs.data()!.text, mtime: t + 400 });
			setNow(t + 500);
			await ipad.checkForExternalChange();
			await ipad.persistChain;
			await vi.waitFor(() => expect(ipad.fs.backups("remote").length).toBeGreaterThan(0));
			// lets the save's fire-and-forget finish before the next turn
			await new Promise((r) => setTimeout(r, 0));
		}
		expect(ipad.fs.backups("remote").length).toBeLessThanOrEqual(SYNC_BACKUP_KEEP);
	});
});

describe("a brand-new device meeting data written before settings were stamped", () => {
	it("keeps the user's choice (Syncthing path): the default does not overwrite it", async () => {
		// data.json written by an older version: priceCurrency "eur", no syncStamps.
		const old = await deviceWith({ text: JSON.stringify({ priceCurrency: "eur", collection: [card("a")] }), mtime: 1000 });
		const fresh = await deviceWith();
		expect(fresh.settings.priceCurrency).toBe("usd");
		setNow(2000);
		deliver(old.fs, fresh.fs);
		await fresh.checkForExternalChange();
		expect(fresh.settings.priceCurrency).toBe("eur");
		await fresh.persistChain;
		// …and the file it writes back says the same, so the old device keeps it too.
		deliver(fresh.fs, old.fs);
		await old.checkForExternalChange();
		expect(old.settings.priceCurrency).toBe("eur");
	});
});

describe("deletions", () => {
	it("propagates a deletion to the other device", async () => {
		const mac = await seededDevice([card("a"), card("b"), card("c")], 1000);
		const ipad = await cloneDevice(mac);
		setNow(2000);
		mac.settings.collection = mac.settings.collection.filter((c: Obj) => c.id !== "c");
		await mac.persistSettings();
		deliver(mac.fs, ipad.fs);
		await ipad.checkForExternalChange();
		expect(ids(ipad)).toEqual(["a", "b"]);
		expect(ipad.settings.syncTombstones.collection.c).toBe(2000);
	});

	it("a deletion made just before the save is not undone by a copy still on the other device", async () => {
		// The user deletes, and an external check falls within the grouping delay
		// (the deletion isn't written yet).
		const mac = await seededDevice([card("a"), card("c")], 1000);
		const ipad = await cloneDevice(mac);
		setNow(2000);
		ipad.settings.collection.push(card("z", { dateModified: 2000 }));
		await ipad.persistSettings();
		setNow(2500);
		mac.settings.collection = mac.settings.collection.filter((c: Obj) => c.id !== "c"); // not saved yet
		deliver(ipad.fs, mac.fs);
		await mac.checkForExternalChange();
		expect(ids(mac)).toEqual(["a", "z"]); // c does not come back
	});

	it("a device that skipped a version does not bring a deleted card back", async () => {
		const mac = await seededDevice([card("a")], 1000);
		const phone = await cloneDevice(mac);
		const ipad = await cloneDevice(mac);

		setNow(2000);
		mac.settings.collection.push(card("y", { dateAdded: 2000, dateModified: 2000 }));
		await mac.persistSettings();
		deliver(mac.fs, phone.fs);
		deliver(mac.fs, ipad.fs);
		await ipad.checkForExternalChange(); // l'iPad voit y…
		expect(ids(ipad)).toEqual(["a", "y"]);

		setNow(3000);
		await phone.checkForExternalChange();
		phone.settings.collection = phone.settings.collection.filter((c: Obj) => c.id !== "y");
		await phone.persistSettings(); // …the phone deletes it…

		setNow(4000);
		ipad.settings.collection.push(card("z", { dateAdded: 4000, dateModified: 4000 }));
		await ipad.persistSettings(); // …the iPad writes something else before having seen the phone's file again
		// Syncthing conflict: the most recent file (the iPad's, which still contains y) wins everywhere.
		expect(deliver(ipad.fs, phone.fs)).toBe(true);
		setNow(5000);
		await phone.checkForExternalChange(); // the phone merges: its tombstone kills y, it keeps z…
		await phone.persistChain;
		expect(ids(phone)).toEqual(["a", "z"]);
		expect(deliver(phone.fs, ipad.fs)).toBe(true);
		setNow(6000);
		await ipad.checkForExternalChange(); // …and the iPad learns it without losing anything.

		expect(ids(ipad)).toEqual(["a", "z"]); // y stays deleted, z is kept
	});

	it("an edit made after the deletion wins over it", async () => {
		const mac = await seededDevice([card("a"), card("c")], 1000);
		const ipad = await cloneDevice(mac);

		setNow(2000);
		mac.settings.collection = mac.settings.collection.filter((c: Obj) => c.id !== "c");
		await mac.persistSettings();

		setNow(3000);
		ipad.settings.collection.find((c: Obj) => c.id === "c")!.count = 9;
		ipad.settings.collection.find((c: Obj) => c.id === "c")!.dateModified = 3000;
		await ipad.persistSettings();

		ipad.fs.data()!.mtime = 3000;
		mac.fs.data()!.mtime = 2000;
		deliver(ipad.fs, mac.fs);
		setNow(3500);
		await mac.checkForExternalChange();
		expect(ids(mac)).toEqual(["a", "c"]);
		expect(mac.settings.collection.find((c: Obj) => c.id === "c").count).toBe(9);
	});

	it("tracks the deletion of a deck card and of a whole deck", async () => {
		setNow(1000);
		const mac = await deviceWith();
		mac.settings.decks = [
			{ id: "D1", name: "One", cards: [deckCard("s0"), deckCard("s1")] },
			{ id: "D2", name: "Two", cards: [deckCard("t0")] },
		];
		await mac.persistSettings();
		const ipad = await cloneDevice(mac);

		setNow(2000);
		mac.settings.decks = [{ id: "D1", name: "One", cards: [deckCard("s0")] }];
		await mac.persistSettings();
		deliver(mac.fs, ipad.fs);
		await ipad.checkForExternalChange();

		expect(ipad.settings.decks.map((d: Obj) => d.id)).toEqual(["D1"]);
		expect(ipad.settings.decks[0].cards.map((c: Obj) => c.scryfallId)).toEqual(["s0"]);
	});

	it("warns and keeps a copy of the local data when another device removes a lot at once", async () => {
		const many = Array.from({ length: BIG_REMOVAL_THRESHOLD + 5 }, (_, i) => card(`c${i}`));
		const mac = await seededDevice(many, 1000);
		const ipad = await cloneDevice(mac);

		setNow(2000);
		mac.settings.collection = [];
		await mac.persistSettings();
		deliver(mac.fs, ipad.fs);
		setNow(2500);
		await ipad.checkForExternalChange();

		expect(ipad.settings.collection).toEqual([]);
		await vi.waitFor(() => expect(ipad.fs.backups("local")).toHaveLength(1));
		expect(JSON.parse(ipad.fs.files.get(ipad.fs.backups("local")[0])!.text).collection).toHaveLength(many.length);
		expect(mocks.notices.some((m) => m.includes("removed"))).toBe(true);
	});

	it("warns and keeps a copy when a stale device brings back a lot of cards at once", async () => {
		const mac = await seededDevice([card("a")], 1000);
		const stale = Array.from({ length: BIG_ADDITION_THRESHOLD + 10 }, (_, i) => card(`old${i}`));
		const oldDevice = await seededDevice([card("a"), ...stale], 500);
		setNow(2000);
		oldDevice.fs.data()!.mtime = 3000;
		deliver(oldDevice.fs, mac.fs);
		await mac.checkForExternalChange();
		expect(mac.settings.collection).toHaveLength(stale.length + 1); // never lose data: they come back
		await vi.waitFor(() => expect(mac.fs.backups("local")).toHaveLength(1)); // but the previous state is kept
		expect(mocks.notices.some((m) => m.includes("added"))).toBe(true);
	});

	it("a small deletion does not warn", async () => {
		const mac = await seededDevice([card("a"), card("b")], 1000);
		const ipad = await cloneDevice(mac);
		setNow(2000);
		mac.settings.collection = [];
		await mac.persistSettings();
		deliver(mac.fs, ipad.fs);
		await ipad.checkForExternalChange();
		expect(mocks.notices).toEqual([]);
	});
});

describe("display preferences stay on each device", () => {
	const stored = (dev: Obj) => dev.store.get(DEVICE_SETTINGS_STORAGE_KEY) as Obj | undefined;

	it("are kept out of data.json and kept in the device's own storage", async () => {
		const dev = await seededDevice([card("a")], 1000);
		dev.settings.collectionViewMode = "card";
		dev.settings.deckSortBy = "price";
		dev.settings.navCollapsed = true;
		dev.saveDeviceLocalSettings();
		setNow(2000);
		dev.settings.collection.push(card("b", { dateModified: 2000 }));
		await dev.persistSettings();
		const file = JSON.parse(dev.fs.data()!.text);
		expect(file).not.toHaveProperty("collectionViewMode");
		expect(file).not.toHaveProperty("deckSortBy");
		expect(file).not.toHaveProperty("navCollapsed");
		expect(file.priceCurrency).toBeDefined(); // shared configuration is still there
		expect(stored(dev)).toMatchObject({ collectionViewMode: "card", deckSortBy: "price", navCollapsed: true });
	});

	it("changing only a preference writes nothing to data.json", async () => {
		const dev = await seededDevice([card("a")], 1000);
		const writes = dev.fs.dataWrites;
		setNow(2000);
		dev.settings.collectionSortBy = "price";
		dev.settings.deckViewMode = "stacks";
		dev.saveDeviceLocalSettings();
		await dev.persistSettings();
		expect(dev.fs.dataWrites).toBe(writes);
		expect(stored(dev)).toMatchObject({ collectionSortBy: "price", deckViewMode: "stacks" });
	});

	it("two devices share the data but each keeps its own preferences", async () => {
		const mac = await seededDevice([card("a")], 1000);
		const ipad = await cloneDevice(mac);
		mac.settings.collectionViewMode = "card";
		mac.saveDeviceLocalSettings();
		ipad.settings.collectionViewMode = "grid";
		ipad.saveDeviceLocalSettings();

		setNow(2000);
		mac.settings.collection.push(card("b", { dateModified: 2000 }));
		await mac.persistSettings();
		deliver(mac.fs, ipad.fs);
		await ipad.checkForExternalChange();

		expect(ids(ipad)).toEqual(["a", "b"]);
		expect(ipad.settings.collectionViewMode).toBe("grid");
		expect(mac.settings.collectionViewMode).toBe("card");
		expect(ipad.refreshOpenViews).toHaveBeenCalled(); // the data did change
	});

	it("a device keeps what data.json held until now when it upgrades, then data.json stops carrying it", async () => {
		const old = await deviceWith({
			text: JSON.stringify({ collection: [card("a")], collectionViewMode: "grid", navCollapsed: true }, null, 2),
			mtime: 1,
		});
		expect(old.settings.collectionViewMode).toBe("grid");
		expect(old.settings.navCollapsed).toBe(true);
		expect(stored(old)).toMatchObject({ collectionViewMode: "grid", navCollapsed: true });
		setNow(2000);
		old.settings.collection.push(card("b", { dateModified: 2000 }));
		await old.persistSettings();
		expect(JSON.parse(old.fs.data()!.text)).not.toHaveProperty("collectionViewMode");
		expect(old.settings.collectionViewMode).toBe("grid");
	});

	it("the device's own stored value wins over the file's", async () => {
		const fs = new FakeFs();
		fs.files.set(DATA, { text: JSON.stringify({ collectionViewMode: "grid" }), mtime: 1 });
		const dev = makeDevice(fs);
		dev.store.set(DEVICE_SETTINGS_STORAGE_KEY, { collectionViewMode: "card" });
		await boot(dev);
		expect(dev.settings.collectionViewMode).toBe("card");
	});

	it("ignores a stored value of the wrong type or for an unknown key", async () => {
		const fs = new FakeFs();
		const dev = makeDevice(fs);
		dev.store.set(DEVICE_SETTINGS_STORAGE_KEY, { collectionViewMode: 5, navCollapsed: "yes", evil: 1, accentColor: "red" });
		await boot(dev);
		expect(dev.settings.collectionViewMode).toBe(DEFAULT_SETTINGS.collectionViewMode);
		expect(dev.settings.navCollapsed).toBe(DEFAULT_SETTINGS.navCollapsed);
		expect(dev.settings).not.toHaveProperty("evil");
		expect(dev.settings.accentColor).toBe(""); // shared setting: not taken from the device storage
	});

	it("an old-version file that still carries preferences neither changes nor triggers anything", async () => {
		const mac = await seededDevice([card("a")], 1000);
		mac.settings.collectionViewMode = "card";
		mac.saveDeviceLocalSettings();
		setNow(2000);
		const foreign = JSON.parse(mac.fs.data()!.text);
		foreign.collectionViewMode = "grid";
		foreign.navCollapsed = true;
		mac.fs.files.set(DATA, { text: JSON.stringify(foreign, null, 2), mtime: 2000 });
		const writes = mac.fs.dataWrites;
		await mac.checkForExternalChange();
		await mac.persistChain;
		expect(mac.settings.collectionViewMode).toBe("card");
		expect(mac.settings.navCollapsed).toBe(DEFAULT_SETTINGS.navCollapsed);
		expect(mac.fs.dataWrites).toBe(writes); // nothing to write back for a preference difference
		expect(mac.refreshOpenViews).not.toHaveBeenCalled();
	});

	it("a poll that finds the file unchanged does no work (one stat)", async () => {
		const dev = await seededDevice([card("a")], 1000);
		dev.fs.reads = 0;
		const sets = [dev.knownKeys, dev.knownScalars, dev.knownPrints];
		await dev.checkForExternalChange();
		expect(dev.fs.reads).toBe(0);
		expect([dev.knownKeys, dev.knownScalars, dev.knownPrints]).toEqual(sets);
		expect([dev.knownKeys, dev.knownScalars, dev.knownPrints].every((v, i) => v === sets[i])).toBe(true); // not even rebuilt
	});
});

describe("choosing the data folder", () => {
	const where = (folder: string) => `${folder}/${CUSTOM_DATA_FILE_NAME}`;
	const stored = (dev: Obj) => dev.store.get(DEVICE_SETTINGS_STORAGE_KEY) as Obj | undefined;
	const file = (dev: Obj, folder: string) => JSON.parse(dev.fs.files.get(where(folder))!.text);

	it("normalizes what the user types", () => {
		expect(normalizeDataFolder("")).toBe("");
		expect(normalizeDataFolder("  / ")).toBe("");
		expect(normalizeDataFolder("MTG Data")).toBe("MTG Data");
		expect(normalizeDataFolder("/Sync//MTG/ ")).toBe("Sync/MTG");
		expect(normalizeDataFolder("a\\b")).toBe("a/b");
		expect(normalizeDataFolder("./x/./y")).toBe("x/y");
		expect(normalizeDataFolder("../escape")).toBeNull();
		expect(normalizeDataFolder("a/../b")).toBeNull();
	});

	it("moves the data to a vault folder, leaves the old file alone, and keeps saving there", async () => {
		const dev = await seededDevice([card("a")], 1000);
		const before = dev.fs.data()!.text;
		setNow(2000);
		expect(await dev.changeDataFolder("MTG Data")).toEqual({ ok: true, mergedExisting: false });
		expect(file(dev, "MTG Data").collection).toHaveLength(1);
		expect(dev.fs.data()!.text).toBe(before); // never deleted, never rewritten
		expect(dev.settings.dataFolder).toBe("MTG Data");
		expect(stored(dev)).toMatchObject({ dataFolder: "MTG Data" });

		setNow(3000);
		dev.settings.collection.push(card("b", { dateModified: 3000 }));
		await dev.persistSettings();
		expect(file(dev, "MTG Data").collection).toHaveLength(2);
		expect(dev.fs.data()!.text).toBe(before);
	});

	it("a restart finds the data again in the chosen folder", async () => {
		const dev = await seededDevice([card("a"), card("b")], 1000);
		await dev.changeDataFolder("MTG Data");
		const again = makeDevice(dev.fs);
		for (const [k, v] of dev.store) again.store.set(k, v); // same device: same local storage
		await boot(again);
		expect(again.dataFolderInUse).toBe("MTG Data");
		expect(ids(again)).toEqual(["a", "b"]);
		expect(again.diskText).toBe(dev.fs.files.get(where("MTG Data"))!.text);
		expect(again.settings.dataFolder).toBe("MTG Data");
	});

	it("MERGES with a file that is already in the chosen folder instead of overwriting it", async () => {
		const mac = await seededDevice([card("a"), card("x")], 1000);
		const other = await seededDevice([card("a"), card("y")], 1200);
		mac.fs.dirs.add("Sync");
		mac.fs.files.set(where("Sync"), { text: other.fs.data()!.text, mtime: 1500 }); // what Syncthing delivered
		setNow(2000);
		expect(await mac.changeDataFolder("Sync")).toEqual({ ok: true, mergedExisting: true });
		expect(ids(mac)).toEqual(["a", "x", "y"]);
		expect(file(mac, "Sync").collection.map((c: Obj) => c.id).sort()).toEqual(["a", "x", "y"]);
	});

	it("can go back to the plugin's own folder, which then gets the latest data", async () => {
		const dev = await seededDevice([card("a")], 1000);
		await dev.changeDataFolder("MTG Data");
		setNow(2000);
		dev.settings.collection.push(card("b", { dateModified: 2000 }));
		await dev.persistSettings();
		setNow(3000);
		expect(await dev.changeDataFolder("")).toEqual({ ok: true, mergedExisting: true });
		expect(dev.dataFolderInUse).toBe("");
		expect(JSON.parse(dev.fs.data()!.text).collection).toHaveLength(2);
		expect(stored(dev)).toMatchObject({ dataFolder: "" });
	});

	it("refuses a folder that tries to leave the vault, and changes nothing", async () => {
		const dev = await seededDevice([card("a")], 1000);
		const result = await dev.changeDataFolder("../outside");
		expect(result.ok).toBe(false);
		expect(dev.dataFolderInUse).toBe("");
		expect(dev.settings.dataFolder).toBe("");
	});

	it("goes back to the previous place when the new one cannot be written", async () => {
		const dev = await seededDevice([card("a")], 1000);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const realWrite = dev.fs.adapter.write;
		dev.fs.adapter.write = async (p: string, d: string, o?: { mtime?: number }) => {
			if (p.startsWith("Bad/")) throw new Error("read-only folder");
			return realWrite(p, d, o);
		};
		const result = await dev.changeDataFolder("Bad");
		expect(result).toMatchObject({ ok: false, message: "read-only folder" });
		expect(dev.dataFolderInUse).toBe("");
		expect(dev.settings.dataFolder).toBe("");
		setNow(2000);
		dev.settings.collection.push(card("b", { dateModified: 2000 }));
		await dev.persistSettings();
		expect(JSON.parse(dev.fs.data()!.text).collection).toHaveLength(2); // still saving where it was
		errors.mockRestore();
	});

	it("starts from the original data when the chosen folder has no file yet, then creates it", async () => {
		// New device: the folder is set (same as on the others) but Syncthing has not delivered the file.
		const fs = new FakeFs();
		fs.files.set(DATA, { text: JSON.stringify({ collection: [card("a"), card("b")] }), mtime: 1 });
		const dev = makeDevice(fs);
		dev.store.set(DEVICE_SETTINGS_STORAGE_KEY, { dataFolder: "Sync" });
		await boot(dev);
		expect(ids(dev)).toEqual(["a", "b"]); // not an empty collection
		expect(dev.dataFolderInUse).toBe("Sync");
		setNow(2000);
		dev.settings.collection.push(card("c", { dateModified: 2000 }));
		await dev.persistSettings();
		expect(file(dev, "Sync").collection).toHaveLength(3);
	});

	it("picks up what Syncthing writes into the chosen folder (the 5 s poll)", async () => {
		const mac = await seededDevice([card("a")], 1000);
		await mac.changeDataFolder("Sync");
		const ipad = await deviceWith({ text: mac.fs.files.get(where("Sync"))!.text, mtime: 1000 });
		ipad.fs.files.set(where("Sync"), { ...ipad.fs.files.get(DATA)! });
		setNow(2000);
		ipad.settings.collection.push(card("i", { dateModified: 2000 }));
		await ipad.changeDataFolder("Sync");
		mac.fs.files.set(where("Sync"), { ...ipad.fs.files.get(where("Sync"))! });
		await mac.checkForExternalChange();
		expect(ids(mac)).toEqual(["a", "i"]);
	});

	it("recreates the folder if it was deleted meanwhile", async () => {
		const dev = await seededDevice([card("a")], 1000);
		await dev.changeDataFolder("Sync");
		dev.fs.dirs.delete("Sync");
		dev.fs.missingDirs.add("Sync");
		setNow(2000);
		dev.settings.collection.push(card("b", { dateModified: 2000 }));
		await dev.persistSettings();
		expect(file(dev, "Sync").collection).toHaveLength(2);
	});
});

describe("robustness", () => {
	it("ignores a data.json that is not valid JSON and repairs it on the next save", async () => {
		const dev = await seededDevice([card("a")], 1000);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		setNow(2000);
		dev.fs.files.set(DATA, { text: '{"collection": [', mtime: 2000 });
		await dev.checkForExternalChange();
		expect(ids(dev)).toEqual(["a"]);
		dev.settings.collection.push(card("b"));
		setNow(3000);
		await dev.persistSettings();
		expect(JSON.parse(dev.fs.data()!.text).collection).toHaveLength(2);
		warn.mockRestore();
	});

	it("an empty object on disk cannot wipe the local data", async () => {
		const dev = await seededDevice([card("a"), card("b")], 1000);
		setNow(2000);
		dev.fs.files.set(DATA, { text: "{}", mtime: 2000 });
		await dev.checkForExternalChange();
		expect(ids(dev)).toEqual(["a", "b"]);
		await dev.persistChain;
		expect(JSON.parse(dev.fs.data()!.text).collection).toHaveLength(2); // and restored on disk
	});

	it("a data.json deleted from under us is recreated by the next save", async () => {
		const dev = await seededDevice([card("a")], 1000);
		dev.fs.files.delete(DATA);
		await dev.checkForExternalChange();
		setNow(2000);
		dev.settings.collection.push(card("b"));
		await dev.persistSettings();
		expect(JSON.parse(dev.fs.data()!.text).collection).toHaveLength(2);
	});

	it("notices another process rewriting the file right after our own write", async () => {
		const mac = await seededDevice([card("a")], 1000);
		const other = await cloneDevice(mac);
		setNow(2000);
		other.settings.collection.push(card("o", { dateModified: 2000 }));
		await other.persistSettings();

		setNow(5_000_000);
		mac.settings.collection.push(card("m", { dateModified: 5_000_000 }));
		let fired = false;
		mac.fs.afterWrite = () => {
			if (fired) return;
			fired = true;
			mac.fs.files.set(DATA, { text: other.fs.data()!.text, mtime: 2000 }); // Syncthing renames its file over it
		};
		await mac.persistSettings();
		await mac.persistChain; // the check triggered by the detection
		expect(ids(mac)).toEqual(["a", "m", "o"]);
		expect(JSON.parse(mac.fs.data()!.text).collection.map((c: Obj) => c.id).sort()).toEqual(["a", "m", "o"]);
	});

	it("a concurrent save and external check leave one consistent file", async () => {
		const mac = await seededDevice([card("a")], 1000);
		const ipad = await cloneDevice(mac);
		setNow(2000);
		ipad.settings.collection.push(card("i", { dateModified: 2000 }));
		await ipad.persistSettings();
		deliver(ipad.fs, mac.fs);
		setNow(2500);
		mac.settings.collection.push(card("m", { dateModified: 2500 }));
		await Promise.all([mac.checkForExternalChange(), mac.persistSettings(), mac.checkForExternalChange()]);
		expect(ids(mac)).toEqual(["a", "i", "m"]);
		expect(JSON.parse(mac.fs.data()!.text).collection).toHaveLength(3);
	});
});

// Readable diagnostic when two devices don't converge: what differs, key by key.
function describeDiff(a: Obj, b: Obj): string {
	const lines: string[] = [];
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
		const av = a[k];
		const bv = b[k];
		if (Array.isArray(av) && Array.isArray(bv) && k !== "savedSearchFilters") {
			const key = (e: Obj) => (k === "decks" ? e.id : e.id);
			const am = new Map<string, Obj>(av.map((e: Obj) => [key(e), e]));
			const bm = new Map<string, Obj>(bv.map((e: Obj) => [key(e), e]));
			for (const [id, e] of am) {
				const o = bm.get(id);
				if (!o) lines.push(`${k}: ${id} only in A`);
				else if (k === "decks") {
					const ac = new Map<string, Obj>((e.cards as Obj[]).map((c) => [c.scryfallId, c]));
					const bc = new Map<string, Obj>((o.cards as Obj[]).map((c) => [c.scryfallId, c]));
					for (const [sid, c] of ac) {
						if (!bc.has(sid)) lines.push(`deck card ${sid} only in A`);
						else if (JSON.stringify(c) !== JSON.stringify(bc.get(sid))) lines.push(`deck card ${sid} differs: A=${JSON.stringify(c)} B=${JSON.stringify(bc.get(sid))}`);
					}
					for (const sid of bc.keys()) if (!ac.has(sid)) lines.push(`deck card ${sid} only in B`);
				} else if (!settingsEqual({ [k]: [e] }, { [k]: [o] })) lines.push(`${k}: ${id} differs: A=${JSON.stringify(e)} B=${JSON.stringify(o)}`);
			}
			for (const id of bm.keys()) if (!am.has(id)) lines.push(`${k}: ${id} only in B`);
		} else if (JSON.stringify(av) !== JSON.stringify(bv) && !Array.isArray(av)) lines.push(`${k}: A=${JSON.stringify(av)} B=${JSON.stringify(bv)}`);
	}
	return lines.join("\n");
}

/* ----------------------- convergence : appareils au hasard ------------------ */

// Deterministic PRNG: a failure must be replayable identically.
function mulberry32(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("random multi-device sessions", () => {
	// Three devices, hundreds of operations (adding/modifying/deleting cards, deck
	// cards, settings), file deliveries out of order and devices that don't look
	// right away (suspended iPad). Invariants: the devices converge to the same
	// state; no card that was never deleted disappears; a card deleted and never
	// touched afterwards isn't resurrected.
	const MARGIN_MS = 10_000;
	const SEEDS = Number(process.env.SYNC_STRESS_SEEDS ?? 25);
	const STEPS = Number(process.env.SYNC_STRESS_STEPS ?? 120);
	for (let seed = 1; seed <= SEEDS; seed++) {
		it(`seed ${seed}`, async () => {
			const rnd = mulberry32(seed);
			const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
			let t = 10_000;
			setNow(t);
			const base = await deviceWith();
			base.settings.collection = [card("c0"), card("c1"), card("c2")];
			base.settings.decks = [{ id: "D", name: "Deck", cards: [deckCard("d0"), deckCard("d1")] }];
			await base.persistSettings();
			const devices = [base, await cloneDevice(base), await cloneDevice(base)];

			let nextId = 0;
			const lastTouched = new Map<string, number>(); // key → last modification/addition
			const lastDeleted = new Map<string, number>(); // key → last deletion
			const everDeleted = new Set<string>();
			const keys = ["c0", "c1", "c2", "deck:d0", "deck:d1"];
			const listKeys: string[] = [];
			const deletedLists = new Set<string>();
			const listTouched = new Map<string, number>();
			const listDeleted = new Map<string, number>();
			for (const k of keys) lastTouched.set(k, 100);

			const touch = (k: string) => lastTouched.set(k, t);

			for (let step = 0; step < STEPS; step++) {
				t += 1000;
				setNow(t);
				const dev = pick(devices);
				const op = rnd();
				const list: Obj[] = dev.settings.collection;
				const deck = dev.settings.decks[0];
				if (op < 0.2) {
					const id = `n${nextId++}`;
					list.push(card(id, { dateAdded: t, dateModified: t }));
					touch(id);
					keys.push(id);
				} else if (op < 0.4 && list.length) {
					const c = pick(list);
					c.count++;
					c.dateModified = t;
					touch(c.id);
				} else if (op < 0.5 && list.length) {
					pick(list).priceUsd = String(rnd()); // refreshed price: no date touched
				} else if (op < 0.65 && list.length) {
					const c = pick(list);
					dev.settings.collection = list.filter((x) => x.id !== c.id);
					lastDeleted.set(c.id, t);
					everDeleted.add(c.id);
				} else if (op < 0.75) {
					const sid = `dn${nextId++}`;
					deck.cards.push(deckCard(sid, { dateAdded: t, dateModified: t }));
					touch(`deck:${sid}`);
					keys.push(`deck:${sid}`);
				} else if (op < 0.82 && deck.cards.length) {
					const c = pick(deck.cards as Obj[]);
					c.count++;
					c.dateModified = t;
					touch(`deck:${c.scryfallId}`);
				} else if (op < 0.88 && deck.cards.length) {
					const c = pick(deck.cards as Obj[]);
					deck.cards = deck.cards.filter((x: Obj) => x !== c);
					lastDeleted.set(`deck:${c.scryfallId}`, t);
					everDeleted.add(`deck:${c.scryfallId}`);
				} else if (op < 0.9) {
					dev.settings.priceCurrency = pick(["usd", "eur"]);
				} else if (op < 0.92) {
					dev.settings.accentColor = pick(["", "red", "blue"]);
				} else if (op < 0.95) {
					const id = `L${nextId++}`;
					dev.settings.lists.push({ id, name: `List ${id}`, dateCreated: t });
					listKeys.push(id);
					listTouched.set(id, t);
				} else if (op < 0.97 && dev.settings.lists.length) {
					const l = pick(dev.settings.lists as Obj[]);
					l.name = `Renamed ${t}`;
					listTouched.set(l.id, t);
				} else if (op < 0.99 && dev.settings.lists.length) {
					const l = pick(dev.settings.lists as Obj[]);
					dev.settings.lists = dev.settings.lists.filter((x: Obj) => x !== l);
					deletedLists.add(l.id);
					listDeleted.set(l.id, t);
				}
				// The plugin saves 400 ms after each modification: a deletion is therefore dated
				// (tombstone) almost at the instant of the operation. The other modifications, for
				// their part, can remain pending when an external check falls.
				const wasDeletion = op >= 0.5 && op < 0.65 ? true : op >= 0.82 && op < 0.88 ? true : op >= 0.97 && op < 0.99;
				if (wasDeletion || rnd() < 0.8) await dev.persistSettings();

				// Deliveries: sometimes, between two random devices; the receiver sometimes looks later.
				if (rnd() < 0.5) {
					const from = pick(devices);
					const to = pick(devices);
					if (from !== to && deliver(from.fs, to.fs) && rnd() < 0.6) {
						t += 10;
						setNow(t);
						await to.checkForExternalChange();
					}
				}
			}

			// Settlement: the grouping delay elapses everywhere, then each file ends up
			// reaching each device (the most recent wins), until stability.
			for (const dev of devices) {
				t += 1000;
				setNow(t);
				await dev.persistSettings();
			}
			for (let round = 0; round < 12; round++) {
				for (const from of devices) {
					for (const to of devices) {
						if (from === to) continue;
						// Enough time between two deliveries not to trigger the anti-loop safeguard.
						t += 60_000;
						setNow(t);
						if (deliver(from.fs, to.fs)) await to.checkForExternalChange();
					}
				}
				if (devices.every((d) => settingsEqual(d.settings, devices[0].settings))) break;
			}

			const [a, b, c] = devices;
			for (const d of devices) expect(d.fs.data()!.text).not.toContain("collectionViewMode");
			expect(settingsEqual(a.settings, b.settings), "a vs b\n" + describeDiff(a.settings, b.settings)).toBe(true);
			expect(settingsEqual(a.settings, c.settings), "a vs c\n" + describeDiff(a.settings, c.settings)).toBe(true);

			const present = new Set<string>([
				...a.settings.collection.map((x: Obj) => x.id),
				...a.settings.decks[0].cards.map((x: Obj) => `deck:${x.scryfallId}`),
			]);
			const presentLists = new Set<string>(a.settings.lists.map((x: Obj) => x.id));
			for (const id of listKeys) {
				// Deleted then renamed elsewhere AFTER: the modification wins (as for a card). The real
				// dates are those of the PREPARATION of the write (up to a few steps later than the
				// operation when the save is deferred): a gap smaller than MARGIN_MS between the last
				// modification and the last deletion is ambiguous, we don't require it.
				const touched = listTouched.get(id) ?? 0;
				const deleted = listDeleted.get(id) ?? 0;
				if (deletedLists.has(id) && Math.abs(touched - deleted) <= MARGIN_MS) continue;
				const alive = !deletedLists.has(id) || touched > deleted;
				expect(presentLists.has(id), `list ${id}`).toBe(alive);
			}
			// Stability: once converged, additional exchanges no longer write anything (no ping-pong).
			const writesBefore = devices.map((d) => d.fs.dataWrites);
			for (let extra = 0; extra < 2; extra++) {
				for (const from of devices) {
					for (const to of devices) {
						if (from === to) continue;
						t += 60_000;
						setNow(t);
						if (deliver(from.fs, to.fs)) await to.checkForExternalChange();
					}
				}
			}
			expect(devices.map((d) => d.fs.dataWrites), "files kept being rewritten after convergence").toEqual(writesBefore);
			for (const k of keys) {
				if (!everDeleted.has(k)) expect(present.has(k), `${k} was never deleted but is gone`).toBe(true);
				else {
					const touched = lastTouched.get(k) ?? 0;
					const deleted = lastDeleted.get(k) ?? 0;
					const alive = touched > deleted;
					if (!alive && deleted - touched > MARGIN_MS) {
						expect(present.has(k), `${k} was deleted and never touched again but is back`).toBe(false);
					}
					if (alive && touched - deleted > MARGIN_MS) {
						expect(present.has(k), `${k} was edited after its deletion but is gone`).toBe(true);
					}
				}
			}
		});
	}
});
