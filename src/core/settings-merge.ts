/* -------------------------------------------------------------------------- */
/* Merge of data.json between devices (2026-10-03) — pure logic, no dependency on
    Obsidian, covered by Vitest.

    Context: data.json is synchronized by Syncthing between the Mac, the iPad and
    the phone. Before this module, each device rewrote ALL of its in-memory state
    on every change: the last one to write won, and changes made elsewhere in the
    meantime silently disappeared (or ended up in a data.sync-conflict-*.json that
    nobody re-read).

    Principle, in two parts that never mix:

    1. PRESENCE of an entity (card, list, deck, deck card…): never deduced from an
       absence. An entity missing on one side is KEPT, unless a tombstone
       (`syncTombstones`) says it was deleted after its last modification. A "last
       state seen" base is not enough: a device that skips an intermediate version
       (the iPad, whose app is suspended by iOS) cannot tell "deleted elsewhere"
       from "never seen", and would wrongly resurrect or delete. The worst case of
       a missing tombstone is therefore a card that comes back, never a lost card.

    2. CONTENT of an entity present on both sides: three-way field-by-field merge
       (base = last REMOTE version read, never our own writes — see
       settings-sync.ts). A field modified on one side only takes that side;
       modified on both sides, the most recent `dateModified` wins, and on a tie a
       canonical order of the values: the result must never depend on which device
       merges (otherwise two devices would endlessly send each other their own
       version).

    3. PRICES and SETTINGS — two cases where a "last version seen" is not enough:
       the cached prices (priceUsd…) are refreshed independently by each device
       without touching any date: they are IGNORED when deciding whether two
       versions of a card differ (otherwise every daily refresh would make all
       devices rewrite 6 MB, endlessly); and the scalar settings each carry a
       timestamp (`syncStamps`), the most recent wins — a value put back to its
       original state elsewhere is indistinguishable from an untouched value if
       it's only compared to a base.

    The settings specific to each device (core/device-settings.ts: sort, view
    mode, collapsed menu…) are outside all of that: never written, compared,
    merged nor timestamped here.

    This function touches nothing: it returns a new merged state.
    `applySettingsInPlace` then carries it ONTO the existing objects, so that
    already-open windows (which keep a reference to their card) keep pointing at
    live objects. */
/* -------------------------------------------------------------------------- */

import { DEVICE_LOCAL_KEYS } from "./device-settings";

type Obj = Record<string, unknown>;

export type Tombstones = Record<string, Record<string, number>>;
export type KeySnapshot = Record<string, Set<string>>;

export interface MergeReport {
	added: number;
	removed: number;
	updated: number;
	/** The merged local state differs from the previous local state. */
	changedLocal: boolean;
	/** The merged state contains something the remote version doesn't have: it has to be written. */
	needsWrite: boolean;
}

export interface MergeResult {
	merged: Obj;
	report: MergeReport;
}

// Tombstones kept for 90 days: enough for a device left off for several weeks to
// still learn about the deletions, without the list growing indefinitely (a
// tombstone ~35 bytes; emptying 3,000 cards = ~100 KB).
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/* ---------------------------------- equality -------------------------------- */

// Deep JSON-style equality: an `undefined` property is equivalent to a
// missing property (JSON.stringify omits it, so data.json too).
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const bb = b as unknown[];
		if (a.length !== bb.length) return false;
		for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bb[i])) return false;
		return true;
	}
	const ao = a as Obj;
	const bo = b as Obj;
	let count = 0;
	for (const k in ao) {
		const av = ao[k];
		if (av === undefined) continue;
		count++;
		if (!deepEqual(av, bo[k])) return false;
	}
	for (const k in bo) if (bo[k] !== undefined) count--;
	return count === 0;
}

// Serialization with sorted keys: serves ONLY to break a tie between two
// conflicting values identically on all devices (the key insertion order,
// for its part, depends on the device that built the object).
function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (v !== null && typeof v === "object") {
		const o = v as Obj;
		return `{${Object.keys(o)
			.filter((k) => o[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v) ?? "null";
}

// Equality of two timestamped entities, prices aside.
function sameContent(a: Obj, b: Obj): boolean {
	for (const k of unionKeys(a, b)) if (!VOLATILE_FIELDS.has(k) && !deepEqual(a[k], b[k])) return false;
	return true;
}

// true = the remote value wins. Symmetric: device A (local = a, remote = b) and
// device B (local = b, remote = a) pick the same winner.
function remoteWins(local: unknown, remote: unknown, localTime: number, remoteTime: number): boolean {
	if (remoteTime !== localTime) return remoteTime > localTime;
	return canonical(remote) > canonical(local);
}

/* ------------------------------ indexed entities --------------------------- */

interface Spec {
	keyOf: (e: Obj) => string;
	/** Sub-arrays of entities (e.g. a deck's cards) and their key function. */
	nested?: Record<string, Spec>;
	/**
	 * Timestamped entity (`dateModified`): on conflict, the most recent version
	 * wins AS A WHOLE. No field-by-field merge for it: with a single starting
	 * version, a field put back to its original value by the other device is
	 * indistinguishable from a field it didn't touch, and the two devices would
	 * each keep their own value, sending it to each other endlessly.
	 */
	lww?: boolean;
	/**
	 * Entity with no modification date of its own originally (lists, decks…): the
	 * plugin maintains one (`recordEntityStamps`) so that the conflict is settled by
	 * date and not on an ambiguous base.
	 */
	stamped?: boolean;
}

const byId = (e: Obj): string => (typeof e.id === "string" ? e.id : "");

// DeckCard has no id of its own (see data-model.ts): the same identity that
// deck merges/imports already use (scryfallId + board + Commander role) —
// choosing them otherwise would merge two rows that the plugin treats as
// distinct, or the reverse.
const deckCardKey = (e: Obj): string =>
	`${String(e.scryfallId ?? "")}|${typeof e.category === "string" ? e.category : "mainboard"}|${
		e.deckFunctionOverride === "Commander" ? "C" : ""
	}`;

const COLLECTIONS: Record<string, Spec> = {
	collection: { keyOf: byId, lww: true },
	lists: { keyOf: byId, lww: true, stamped: true },
	wantlist: { keyOf: byId, lww: true },
	wantlists: { keyOf: byId, lww: true, stamped: true },
	savedSearchFilters: { keyOf: byId, lww: true, stamped: true },
	// The deck's fields are settled by date, its cards are merged one by one.
	decks: { keyOf: byId, stamped: true, nested: { cards: { keyOf: deckCardKey, lww: true } } },
};

const TOMBSTONES_KEY = "syncTombstones";
const STAMPS_KEY = "syncStamps";

// Derived data, refreshed separately by each device (refreshAllPrices): never a
// reason to merge, write or settle a conflict.
export const VOLATILE_FIELDS: ReadonlySet<string> = new Set([
	"priceUsd",
	"priceUsdFoil",
	"priceEur",
	"priceEurFoil",
	"priceUsdEtched",
	"priceEurEtched",
]);

// Timestamps that must never go backwards: the most recent wins.
const MAX_WINS = new Set(["lastPriceRefresh", "lastAutoBackup"]);

interface KeyedArray {
	keys: string[];
	byKey: Map<string, Obj>;
}

// Two entities that would share the same key stay distinct (suffix #2, #3…
// in order of appearance) instead of overwriting each other.
function indexArray(items: unknown, keyOf: (e: Obj) => string): KeyedArray {
	const keys: string[] = [];
	const byKey = new Map<string, Obj>();
	if (!Array.isArray(items)) return { keys, byKey };
	const seen = new Map<string, number>();
	for (const raw of items) {
		if (raw === null || typeof raw !== "object") continue;
		const e = raw as Obj;
		const base = keyOf(e);
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		const key = n === 1 ? base : `${base}#${n}`;
		keys.push(key);
		byKey.set(key, e);
	}
	return { keys, byKey };
}

function entityTime(e: Obj): number {
	let t = 0;
	for (const f of ["dateModified", "dateAdded", "dateCreated"]) {
		const v = e[f];
		if (typeof v === "number" && v > t) t = v;
	}
	return t;
}

function modifiedTime(e: Obj): number {
	return typeof e.dateModified === "number" ? e.dateModified : 0;
}

function unionKeys(...objs: (Obj | undefined | null)[]): string[] {
	const seen = new Set<string>();
	for (const o of objs) if (o) for (const k of Object.keys(o)) seen.add(k);
	return Array.from(seen);
}

/* ------------------------------ pierres tombales --------------------------- */

function tombstonesOf(settings: Obj): Tombstones {
	const t = settings[TOMBSTONES_KEY];
	return t !== null && typeof t === "object" && !Array.isArray(t) ? (t as Tombstones) : {};
}

function mergeTombstones(a: Tombstones, b: Tombstones): Tombstones {
	const out: Tombstones = {};
	for (const src of [a, b]) {
		for (const coll of Object.keys(src)) {
			const entries = src[coll];
			if (entries === null || typeof entries !== "object") continue;
			const dst = (out[coll] ??= {});
			for (const key of Object.keys(entries)) {
				const ts = entries[key];
				if (typeof ts === "number" && (dst[key] === undefined || ts > dst[key])) dst[key] = ts;
			}
		}
	}
	return out;
}

// Keys present per collection, including deck cards (composite key
// `deck|card`). Serves to spot, at each write, what has disappeared since last
// time: this is what becomes a tombstone.
export function snapshotKeys(settings: Obj): KeySnapshot {
	const snap: KeySnapshot = {};
	for (const [coll, spec] of Object.entries(COLLECTIONS)) {
		const arr = settings[coll];
		if (!Array.isArray(arr)) continue;
		const idx = indexArray(arr, spec.keyOf);
		snap[coll] = new Set(idx.keys);
		if (!spec.nested) continue;
		for (const [field, nestedSpec] of Object.entries(spec.nested)) {
			const set = new Set<string>();
			for (const parentKey of idx.keys) {
				const sub = idx.byKey.get(parentKey)![field];
				for (const subKey of indexArray(sub, nestedSpec.keyOf).keys) set.add(`${parentKey}|${subKey}`);
			}
			snap[`${coll}.${field}`] = set;
		}
	}
	return snap;
}

// Finds the object for a snapshot key (deck card included).
function findEntity(settings: Obj, coll: string, key: string): Obj | undefined {
	const dot = coll.indexOf(".");
	if (dot < 0) return indexArray(settings[coll], COLLECTIONS[coll].keyOf).byKey.get(key);
	const parentColl = coll.slice(0, dot);
	const field = coll.slice(dot + 1);
	const parentSpec = COLLECTIONS[parentColl];
	const parents = indexArray(settings[parentColl], parentSpec.keyOf);
	const parentKey = key.slice(0, key.indexOf("|"));
	const parent = parents.byKey.get(parentKey);
	const nested = parentSpec.nested?.[field];
	if (!parent || !nested) return undefined;
	return indexArray(parent[field], nested.keyOf).byKey.get(key.slice(parentKey.length + 1));
}

// Compares the current state to `prev` (keys known at the last write/read) and
// records a tombstone for everything that has disappeared; removes those of
// entities that have just reappeared (restoring a backup…); purges those older
// than TOMBSTONE_TTL_MS. Returns the number of newly recorded deletions.
// Mutates `settings.syncTombstones`.
export function recordTombstones(settings: Obj, prev: KeySnapshot, now: number): number {
	const cur = snapshotKeys(settings);
	let tomb = settings[TOMBSTONES_KEY] as Tombstones | undefined;
	if (tomb === null || typeof tomb !== "object" || Array.isArray(tomb)) tomb = undefined;
	let added = 0;

	for (const coll of Object.keys(prev)) {
		const curSet = cur[coll];
		if (!curSet) continue; // collection absente/illisible : on n'invente aucune suppression
		const dot = coll.indexOf(".");
		for (const key of prev[coll]) {
			if (curSet.has(key)) continue;
			// Deck card: if the deck itself has disappeared, its own tombstone is enough.
			if (dot >= 0 && !cur[coll.slice(0, dot)]?.has(key.slice(0, key.indexOf("|")))) continue;
			if (!tomb) tomb = settings[TOMBSTONES_KEY] = {} as Tombstones;
			(tomb[coll] ??= {})[key] = now;
			added++;
		}
	}
	if (!tomb) return added;

	for (const coll of Object.keys(tomb)) {
		const entries = tomb[coll];
		const curSet = cur[coll];
		const prevSet = prev[coll];
		for (const key of Object.keys(entries)) {
			const reappeared = !!curSet?.has(key) && !prevSet?.has(key);
			if (reappeared) {
				// Re-created after having been deleted (restoring a backup, undo…): it must beat
				// the tombstone everywhere, including on the devices that keep it — its
				// modification date therefore moves to now.
				const entity = findEntity(settings, coll, key);
				if (entity && entityTime(entity) <= entries[key]) entity.dateModified = now;
				delete entries[key];
			} else if (now - entries[key] > TOMBSTONE_TTL_MS) delete entries[key];
		}
		if (Object.keys(entries).length === 0) delete tomb[coll];
	}
	if (Object.keys(tomb).length === 0) delete settings[TOMBSTONES_KEY];
	return added;
}

/* ------------------------- order-independent equality ------------------ */

// Two devices each merge with THEIR order (theirs first, then what comes from the
// other): the same content can therefore exist in two orders. If they were judged
// different, each device would rewrite the file on receiving the other's,
// indefinitely. Collections of entities are therefore compared by key, not by
// position.
function entityEqual(spec: Spec, a: Obj, b: Obj): boolean {
	for (const k of unionKeys(a, b)) {
		if (spec.lww && VOLATILE_FIELDS.has(k)) continue;
		const nestedSpec = spec.nested?.[k];
		if (nestedSpec && Array.isArray(a[k]) && Array.isArray(b[k])) {
			if (!keyedArraysEqual(nestedSpec, a[k] as unknown[], b[k] as unknown[])) return false;
		} else if (!deepEqual(a[k], b[k])) return false;
	}
	return true;
}

function keyedArraysEqual(spec: Spec, a: unknown[], b: unknown[]): boolean {
	const A = indexArray(a, spec.keyOf);
	const B = indexArray(b, spec.keyOf);
	if (A.keys.length !== B.keys.length) return false;
	for (const k of A.keys) {
		const eb = B.byKey.get(k);
		if (!eb || !entityEqual(spec, A.byKey.get(k)!, eb)) return false;
	}
	return true;
}

// Equality of two settings states, entity order aside.
export function settingsEqual(a: Obj, b: Obj): boolean {
	for (const k of unionKeys(a, b)) {
		if (DEVICE_LOCAL_KEYS.has(k)) continue;
		const spec = COLLECTIONS[k];
		if (spec && Array.isArray(a[k]) && Array.isArray(b[k])) {
			if (!keyedArraysEqual(spec, a[k] as unknown[], b[k] as unknown[])) return false;
		} else if (!deepEqual(a[k], b[k])) return false;
	}
	return true;
}

/* ------------------------- timestamping of scalar settings ---------------- */

const META_KEYS = new Set([TOMBSTONES_KEY, STAMPS_KEY]);

// Canonical value of each scalar setting (everything that is neither a
// collection of entities nor sync metadata).
export function snapshotScalars(settings: Obj): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of Object.keys(settings)) {
		if (COLLECTIONS[k] || META_KEYS.has(k) || DEVICE_LOCAL_KEYS.has(k)) continue;
		out[k] = canonical(settings[k]);
	}
	return out;
}

// Dates the last local modification of each setting that has changed since
// `prev` (state known at the last write/read/merge). Mutates `syncStamps`.
export function recordScalarStamps(settings: Obj, prev: Record<string, string>, now: number): number {
	const cur = snapshotScalars(settings);
	let stamps = settings[STAMPS_KEY] as Record<string, number> | undefined;
	if (stamps === null || typeof stamps !== "object" || Array.isArray(stamps)) stamps = undefined;
	let changed = 0;
	for (const k of Object.keys(cur)) {
		if (prev[k] === cur[k]) continue;
		if (!stamps) stamps = settings[STAMPS_KEY] = {} as Record<string, number>;
		stamps[k] = now;
		changed++;
	}
	return changed;
}

function stampsOf(settings: Obj): Record<string, number> {
	const s = settings[STAMPS_KEY];
	return s !== null && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, number>) : {};
}

/* ----------------------- timestamping of lists and decks ------------------ */

export type EntityPrints = Record<string, Record<string, string>>;

// Fingerprint of the OWN content of each list/wantlist/filter/deck (excluding a
// deck's cards and dateModified itself).
export function snapshotEntityPrints(settings: Obj): EntityPrints {
	const out: EntityPrints = {};
	for (const [coll, spec] of Object.entries(COLLECTIONS)) {
		if (!spec.stamped) continue;
		const arr = settings[coll];
		if (!Array.isArray(arr)) continue;
		const idx = indexArray(arr, spec.keyOf);
		const prints: Record<string, string> = {};
		for (const key of idx.keys) {
			const e = idx.byKey.get(key)!;
			const own: Obj = {};
			for (const f of Object.keys(e)) if (f !== "dateModified" && !spec.nested?.[f]) own[f] = e[f];
			prints[key] = canonical(own);
		}
		out[coll] = prints;
	}
	return out;
}

// Sets `dateModified` to `now` for any list/deck… whose content has changed
// (or that has just been created) since `prev`. Mutates the entities.
export function recordEntityStamps(settings: Obj, prev: EntityPrints, now: number): number {
	const cur = snapshotEntityPrints(settings);
	let changed = 0;
	for (const coll of Object.keys(cur)) {
		const idx = indexArray(settings[coll], COLLECTIONS[coll].keyOf);
		for (const key of idx.keys) {
			if (prev[coll]?.[key] === cur[coll][key]) continue;
			idx.byKey.get(key)!.dateModified = now;
			changed++;
		}
	}
	return changed;
}

/* ---------------------------------- fusion --------------------------------- */

interface Ctx {
	tombs: Tombstones;
	stats: { added: number; removed: number; updated: number };
}

// Timestamped entity: see Spec.lww. The "only one side changed" shortcuts only
// apply for a remote version that is not more RECENT than the local one —
// otherwise it has been touched (perhaps put back to its original value) after
// us.
function resolveByTime(b: Obj | undefined, l: Obj, r: Obj): Obj {
	const lt = modifiedTime(l);
	const rt = modifiedTime(r);
	if (b) {
		// "Only one side changed": valid only if the other is not OLDER than us. A
		// late-delivered file (an older version than the one already seen) must not
		// overwrite a local version that is nonetheless "unchanged" since our last read.
		if (sameContent(l, b) && !(lt > rt)) return r;
		if (sameContent(r, b) && !(rt > lt)) return l;
	}
	// Same date, different contents: if one contains all of the other plus extra
	// fields (catch-up by a more recent plugin version, which doesn't touch
	// dateModified), it's the most complete one — never the reverse, otherwise the
	// added field would disappear then be added again in a loop.
	if (lt === rt) {
		if (isSuperset(r, l)) return r;
		if (isSuperset(l, r)) return l;
	}
	return remoteWins(l, r, lt, rt) ? r : l;
}

function isSuperset(a: Obj, b: Obj): boolean {
	for (const k of Object.keys(b)) {
		if (b[k] !== undefined && !VOLATILE_FIELDS.has(k) && !deepEqual(a[k], b[k])) return false;
	}
	return true;
}

function mergeEntity(ctx: Ctx, spec: Spec, coll: string, fullKey: string, b: Obj | undefined, l: Obj, r: Obj): Obj {
	if (spec.lww) return sameContent(l, r) ? l : resolveByTime(b, l, r);
	if (deepEqual(l, r)) return l;
	const lt = modifiedTime(l);
	const rt = modifiedTime(r);
	const out: Obj = {};
	for (const k of unionKeys(l, r, b)) {
		const lv = l[k];
		const rv = r[k];
		const bv = b ? b[k] : undefined;
		const nestedSpec = spec.nested?.[k];
		let v: unknown;
		if (deepEqual(lv, rv)) v = lv;
		else if (nestedSpec && Array.isArray(lv) && Array.isArray(rv)) {
			v = mergeEntityArray(ctx, `${coll}.${k}`, `${fullKey}|`, nestedSpec, Array.isArray(bv) ? bv : undefined, lv, rv);
		} else if (b && deepEqual(lv, bv) && !(lt > rt)) v = rv;
		// Same guard as resolveByTime: "the other side didn't change" only holds if it
		// is not more recent than us (otherwise it may have put back the original
		// value).
		else if (b && deepEqual(rv, bv) && !(rt > lt)) v = lv;
		// Real conflict (or no base): a field present on one side only is kept —
		// without a base we cannot tell "deleted" from "added by a more recent
		// plugin version", and losing a value is worse than keeping one too many.
		else if (lv === undefined) v = rv;
		else if (rv === undefined) v = lv;
		else v = remoteWins(lv, rv, lt, rt) ? rv : lv;
		if (v !== undefined) out[k] = v;
	}
	return out;
}

function mergeEntityArray(
	ctx: Ctx,
	coll: string,
	prefix: string,
	spec: Spec,
	base: unknown[] | undefined,
	local: unknown[],
	remote: unknown[]
): Obj[] {
	const L = indexArray(local, spec.keyOf);
	const R = indexArray(remote, spec.keyOf);
	const B = base ? indexArray(base, spec.keyOf) : null;
	const tombColl = ctx.tombs[coll];
	const out: Obj[] = [];

	const consider = (key: string, l: Obj | undefined, r: Obj | undefined) => {
		let m: Obj;
		if (l && r) {
			m = mergeEntity(ctx, spec, coll, prefix + key, B?.byKey.get(key), l, r);
			if (m !== l && !deepEqual(m, l)) ctx.stats.updated++;
		} else m = (l ?? r)!;
		// Deleted after its last modification (on either device)?
		const ts = tombColl?.[prefix + key];
		if (ts !== undefined && ts >= entityTime(m)) {
			if (l) ctx.stats.removed++;
			return;
		}
		if (!l) ctx.stats.added++;
		out.push(m);
	};

	// Local order first, then the entities that arrived from the other device.
	for (const k of L.keys) consider(k, L.byKey.get(k), R.byKey.get(k));
	for (const k of R.keys) if (!L.byKey.has(k)) consider(k, undefined, R.byKey.get(k));
	return out;
}

// Shallow copy without certain keys — and without their timestamps (`syncStamps`). Serves a source that
// doesn't carry everything (GitHub never receives the API key): what it doesn't carry must be neither
// compared (otherwise "there is always something to send back to it", endlessly) nor merged.
export function omitKeys(settings: Obj, ignore: ReadonlySet<string>): Obj {
	const out: Obj = {};
	for (const k of Object.keys(settings)) if (!ignore.has(k)) out[k] = settings[k];
	const stamps = settings[STAMPS_KEY];
	if (stamps !== null && typeof stamps === "object" && !Array.isArray(stamps)) {
		const kept: Record<string, unknown> = {};
		for (const k of Object.keys(stamps)) if (!ignore.has(k)) kept[k] = (stamps as Obj)[k];
		if (Object.keys(kept).length > 0) out[STAMPS_KEY] = kept;
		else delete out[STAMPS_KEY];
	}
	return out;
}

export function mergeSettings(
	base: Obj | null,
	local: Obj,
	remote: Obj,
	ignore?: ReadonlySet<string>,
	defaults?: Obj
): MergeResult {
	if (ignore && ignore.size > 0) {
		base = base && omitKeys(base, ignore);
		local = omitKeys(local, ignore);
		remote = omitKeys(remote, ignore);
	}
	const tombs = mergeTombstones(tombstonesOf(local), tombstonesOf(remote));
	const ctx: Ctx = { tombs, stats: { added: 0, removed: 0, updated: 0 } };
	const merged: Obj = {};
	const stampsL = stampsOf(local);
	const stampsR = stampsOf(remote);

	for (const k of unionKeys(local, remote, base)) {
		if (META_KEYS.has(k) || DEVICE_LOCAL_KEYS.has(k)) continue;
		const lv = local[k];
		const rv = remote[k];
		const bv = base ? base[k] : undefined;
		const spec = COLLECTIONS[k];
		if (spec && Array.isArray(lv) && Array.isArray(rv)) {
			merged[k] = mergeEntityArray(ctx, k, "", spec, Array.isArray(bv) ? bv : undefined, lv, rv);
			continue;
		}
		let v: unknown;
		// A field missing on the remote side (a device on an older version) never
		// deletes anything here.
		if (rv === undefined) v = lv;
		else if (lv === undefined) v = rv;
		else if (deepEqual(lv, rv)) v = lv;
		else if (MAX_WINS.has(k) && typeof lv === "number" && typeof rv === "number") v = Math.max(lv, rv);
		else if ((stampsL[k] ?? 0) !== (stampsR[k] ?? 0)) v = (stampsR[k] ?? 0) > (stampsL[k] ?? 0) ? rv : lv;
		// No timestamp (device on an older version): three-way.
		else if (base && deepEqual(lv, bv)) v = rv;
		else if (base && deepEqual(rv, bv)) v = lv;
		else {
			const lIsDefault = defaults !== undefined && deepEqual(lv, defaults[k]);
			const rIsDefault = defaults !== undefined && deepEqual(rv, defaults[k]);
			// Symmetric: both devices, each with its own local/remote viewpoint, pick the same value.
			if (lIsDefault !== rIsDefault) v = lIsDefault ? rv : lv;
			else v = remoteWins(lv, rv, 0, 0) ? rv : lv;
		}
		if (v !== undefined) merged[k] = v;
	}
	const stamps: Record<string, number> = {};
	for (const src of [stampsL, stampsR]) {
		for (const k of Object.keys(src)) {
			if (DEVICE_LOCAL_KEYS.has(k)) continue; // leftover from a version that synchronized them
			if (typeof src[k] === "number" && !(src[k] <= (stamps[k] ?? -1))) stamps[k] = src[k];
		}
	}
	if (Object.keys(stamps).length > 0) merged[STAMPS_KEY] = stamps;
	if (Object.keys(tombs).length > 0) merged[TOMBSTONES_KEY] = tombs;

	return {
		merged,
		report: {
			...ctx.stats,
			changedLocal: !settingsEqual(merged, local),
			needsWrite: !settingsEqual(merged, remote),
		},
	};
}

/* ----------------------------- application en place ------------------------- */

function reconcileArray(target: unknown[], merged: Obj[], spec: Spec): void {
	const T = indexArray(target, spec.keyOf);
	const M = indexArray(merged, spec.keyOf);
	const next: Obj[] = [];
	for (const k of M.keys) {
		const m = M.byKey.get(k)!;
		const t = T.byKey.get(k);
		if (t && t !== m) {
			assignEntity(t, m, spec);
			next.push(t);
		} else next.push(m);
	}
	let same = next.length === target.length;
	for (let i = 0; same && i < next.length; i++) if (next[i] !== target[i]) same = false;
	if (same) return;
	target.length = 0;
	for (const e of next) target.push(e);
}

// Copies `m` ONTO `t` (same object, new content): an open window holding `t` sees
// the update; a deleted entity, for its part, disappears from the array.
function assignEntity(t: Obj, m: Obj, spec: Spec): void {
	for (const k of Object.keys(t)) if (m[k] === undefined) delete t[k];
	for (const k of Object.keys(m)) {
		const mv = m[k];
		const tv = t[k];
		const nestedSpec = spec.nested?.[k];
		if (nestedSpec && Array.isArray(tv) && Array.isArray(mv)) reconcileArray(tv, mv as Obj[], nestedSpec);
		else if (!deepEqual(tv, mv)) t[k] = mv;
	}
}

// Carries `merged` (the result of mergeSettings, or a remote version adopted
// as is) onto `target` while keeping the identity of the objects that remain.
export function applySettingsInPlace(target: Obj, merged: Obj): void {
	for (const k of Object.keys(merged)) {
		const mv = merged[k];
		const tv = target[k];
		const spec = COLLECTIONS[k];
		if (spec && Array.isArray(tv) && Array.isArray(mv)) reconcileArray(tv, mv as Obj[], spec);
		else if (!deepEqual(tv, mv)) target[k] = mv;
	}
}
