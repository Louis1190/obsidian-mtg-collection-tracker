import { afterEach, describe, expect, it } from "vitest";
import {
	applySettingsInPlace,
	mergeSettings,
	recordEntityStamps,
	recordScalarStamps,
	recordTombstones,
	settingsEqual,
	snapshotEntityPrints,
	snapshotKeys,
	snapshotScalars,
} from "./settings-merge";
import { assembleShards, encodeShards } from "./github-shards";
import { healInboxes } from "./data-model";

// Data that comes from outside this device (a data.json another device wrote, the GitHub data repository, a backup
// file someone sent) can hold a key named "__proto__": JSON.parse creates it as an OWN property. Code that then does
// `obj[key] ??= {}` and writes into the result would write into Object.prototype itself, i.e. into every object of
// Obsidian and of every other plugin (they share one JavaScript realm). `mergeTombstones` did exactly that (found by
// the audit of 2026-11-15, docs/history/code-audit-2026-11-15.md); these tests keep the whole merge layer honest.

type Obj = Record<string, any>;

const PROTO_KEYS_BASELINE = new Set(Object.getOwnPropertyNames(Object.prototype));

// What a pollution looks like from the outside: a property on Object.prototype that was not there at startup.
function pollutedKeys(): string[] {
	return Object.getOwnPropertyNames(Object.prototype).filter((k) => !PROTO_KEYS_BASELINE.has(k));
}

// A failing test must not poison the rest of the worker: remove whatever it added.
function cleanPrototype(): void {
	for (const k of pollutedKeys()) delete (Object.prototype as any)[k];
	// A "constructor" key reaches the Object function itself, not only its prototype.
	delete (Object as any).polluted;
	// ... and an inherited member name reaches the built-in functions.
	for (const fn of [Object.prototype.toString, Object.prototype.hasOwnProperty, Object.prototype.valueOf] as any[]) {
		delete fn.polluted;
		delete fn.x;
	}
}

afterEach(cleanPrototype);

// JSON.parse of a text carrying the key: the only way a real file produces an own "__proto__" property.
const hostile = (json: string): Obj => JSON.parse(json);
const clone = (o: unknown): Obj => JSON.parse(JSON.stringify(o));

// A realistic document, one entity of every kind the merge knows.
const doc = (): Obj => ({
	collection: [{ id: "c1", scryfallId: "s1", name: "A", count: 1, listId: "l1", dateModified: 5 }],
	lists: [{ id: "l1", name: "L", isInbox: true, dateCreated: 1, dateModified: 5 }],
	wantlist: [{ scryfallId: "s2", name: "B", count: 1, listId: "w1", dateModified: 5 }],
	wantlists: [{ id: "w1", name: "W", dateModified: 5 }],
	decks: [
		{
			id: "d1",
			name: "D",
			dateModified: 5,
			cards: [{ scryfallId: "s3", name: "C", count: 1, category: "mainboard", dateModified: 5 }],
		},
	],
	savedSearchFilters: [{ id: "f1", name: "F", dateModified: 5 }],
	priceCurrency: "usd",
	accentColor: "#ffffff",
	syncTombstones: { collection: { c0: 9 }, lists: {} },
	syncStamps: { priceCurrency: 7 },
});

// The path of every plain object in the document (arrays are walked through, never given the key).
function objectPaths(o: unknown, path: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
	if (o === null || typeof o !== "object") return out;
	if (!Array.isArray(o)) out.push(path);
	for (const k of Object.keys(o)) objectPaths((o as Obj)[k], [...path, Array.isArray(o) ? Number(k) : k], out);
	return out;
}

// A copy of `base` with an OWN "__proto__" property on the object at `path` (defineProperty = what JSON.parse does).
function withProtoKeyAt(base: Obj, path: (string | number)[]): Obj {
	const copy = clone(base);
	let target: Obj = copy;
	for (const k of path) target = target[k];
	Object.defineProperty(target, "__proto__", {
		value: { polluted: 1, alsoPolluted: 2 },
		enumerable: true,
		writable: true,
		configurable: true,
	});
	return copy;
}

describe("the pollution detector itself", () => {
	it("sees a property added to Object.prototype and cleanPrototype removes it", () => {
		expect(pollutedKeys()).toEqual([]);
		(Object.prototype as any).probe = 1;
		expect(pollutedKeys()).toEqual(["probe"]);
		cleanPrototype();
		expect(pollutedKeys()).toEqual([]);
	});

	it("treats a key that JSON.parse made an own property as exactly that (the premise of every test below)", () => {
		const o = hostile('{"__proto__":{"polluted":1}}');
		expect(Object.prototype.hasOwnProperty.call(o, "__proto__")).toBe(true);
		expect(Object.keys(o)).toEqual(["__proto__"]);
		expect(pollutedKeys()).toEqual([]);
	});
});

describe("mergeSettings and a hostile syncTombstones", () => {
	const text = '{"collection":[],"lists":[],"syncTombstones":{"__proto__":{"polluted":123456}}}';

	it("does not write into Object.prototype when the REMOTE side carries it", () => {
		mergeSettings(null, { collection: [], lists: [] }, hostile(text));
		expect(pollutedKeys()).toEqual([]);
		expect(({} as any).polluted).toBeUndefined();
	});

	it("does not write into Object.prototype when the LOCAL side carries it", () => {
		mergeSettings(null, hostile(text), { collection: [], lists: [] });
		expect(pollutedKeys()).toEqual([]);
	});

	it("does not write into Object.prototype when the BASE carries it", () => {
		mergeSettings(hostile(text), { collection: [], lists: [] }, { collection: [], lists: [] });
		expect(pollutedKeys()).toEqual([]);
	});

	it("keeps the legitimate tombstones next to the hostile one and never copies the hostile key into the result", () => {
		const remote = hostile(
			'{"collection":[],"lists":[],"syncTombstones":{"collection":{"gone":42},"__proto__":{"polluted":1}}}'
		);
		const merged = mergeSettings(null, { collection: [], lists: [] }, remote).merged as Obj;
		expect(merged.syncTombstones.collection).toEqual({ gone: 42 });
		expect(Object.prototype.hasOwnProperty.call(merged.syncTombstones, "__proto__")).toBe(false);
		// Assigning the hostile object to out["__proto__"] would not pollute the world but would make the result
		// INHERIT its keys (a collection named "polluted" out of nowhere).
		expect(Object.getPrototypeOf(merged.syncTombstones)).toBe(Object.prototype);
		expect(merged.syncTombstones.polluted).toBeUndefined();
	});

	it("does not write into a built-in FUNCTION either when a collection is named like an inherited member", () => {
		// out["toString"] ??= {} would hand back Object.prototype.toString (not nullish) and the write would land on it.
		const remote = hostile(
			'{"collection":[],"lists":[],"syncTombstones":{"toString":{"polluted":1},"hasOwnProperty":{"polluted":2},"valueOf":{"x":3}}}'
		);
		mergeSettings(null, { collection: [], lists: [] }, remote);
		expect((Object.prototype.toString as any).polluted).toBeUndefined();
		expect((Object.prototype.hasOwnProperty as any).polluted).toBeUndefined();
		expect((Object.prototype.valueOf as any).x).toBeUndefined();
	});

	it("never copies a built-in name into a collection as if it were the id of a deleted entity", () => {
		const remote = hostile(
			'{"collection":[],"lists":[],"syncTombstones":{"collection":{"constructor":5,"prototype":6,"__proto__":7,"real-id":8}}}'
		);
		const merged = mergeSettings(null, { collection: [], lists: [] }, remote).merged as Obj;
		expect(merged.syncTombstones.collection).toEqual({ "real-id": 8 });
		expect(Object.keys(merged.syncTombstones.collection)).toEqual(["real-id"]);
	});

	it("an inherited-looking name inside a collection is not mistaken for an entry already present", () => {
		const a = hostile('{"collection":[],"lists":[],"syncTombstones":{"collection":{"toString":10}}}');
		const b = hostile('{"collection":[],"lists":[],"syncTombstones":{"collection":{"toString":20}}}');
		const merged = mergeSettings(null, a, b).merged as Obj;
		// The newest deletion time wins, as for any other id.
		expect(merged.syncTombstones.collection.toString).toBe(20);
	});

	it("also refuses the other names that reach built-ins (constructor, prototype)", () => {
		const remote = hostile('{"collection":[],"lists":[],"syncTombstones":{"constructor":{"polluted":1},"prototype":{"polluted":1}}}');
		mergeSettings(null, { collection: [], lists: [] }, remote);
		expect(pollutedKeys()).toEqual([]);
		expect((Object as any).polluted).toBeUndefined();
	});
});

describe("a __proto__ key at every level of the document, through every merge-layer function", () => {
	const base = doc();
	const paths = objectPaths(base);

	it("covers a meaningful number of positions", () => {
		expect(paths.length).toBeGreaterThan(10);
	});

	const operations: [string, (h: Obj) => unknown][] = [
		["mergeSettings, hostile remote", (h) => mergeSettings(null, clone(base), clone(h))],
		["mergeSettings, hostile local", (h) => mergeSettings(null, clone(h), clone(base))],
		["mergeSettings, hostile base", (h) => mergeSettings(clone(h), clone(base), clone(base))],
		["applySettingsInPlace", (h) => applySettingsInPlace(clone(base), clone(h))],
		["recordTombstones, hostile settings", (h) => recordTombstones(clone(h), snapshotKeys(clone(base)), 1)],
		["recordTombstones, hostile snapshot", (h) => recordTombstones(clone(base), snapshotKeys(clone(h)), 1)],
		["recordScalarStamps", (h) => recordScalarStamps(clone(h), snapshotScalars(clone(base)), 1)],
		["recordEntityStamps", (h) => recordEntityStamps(clone(h), snapshotEntityPrints(clone(base)), 1)],
		["encodeShards then assembleShards", (h) => assembleShards(encodeShards(clone(h)))],
		["healInboxes", (h) => healInboxes(clone(h) as any)],
		["settingsEqual", (h) => settingsEqual(clone(h), clone(base))],
	];

	for (const [name, run] of operations) {
		it(`${name} leaves Object.prototype alone wherever the key sits`, () => {
			const offenders: string[] = [];
			for (const path of paths) {
				try {
					run(withProtoKeyAt(base, path));
				} catch {
					// A function may reject a malformed document; what matters here is only the prototype.
				}
				if (pollutedKeys().length > 0) {
					offenders.push("/" + path.join("/"));
					cleanPrototype();
				}
			}
			expect(offenders).toEqual([]);
		});
	}

	it("a hostile shard handed to assembleShards does not pollute either", () => {
		const shards = new Map([
			["core.json.gz", hostile('{"v":2,"data":{"__proto__":{"polluted":1}},"__proto__":{"polluted":1}}')],
		]);
		try {
			assembleShards(shards as any);
		} catch {
			// rejecting is fine
		}
		expect(pollutedKeys()).toEqual([]);
	});
});
