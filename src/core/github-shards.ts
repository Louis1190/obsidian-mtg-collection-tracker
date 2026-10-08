import { settingsEqual } from "./settings-merge";


type Obj = Record<string, unknown>;
export type ShardObj = Obj;

export const SHARD_SUFFIX = ".json.gz";
export const CORE_SHARD = `core${SHARD_SUFFIX}`;
export const SHARD_FORMAT = 2;
const FORMAT_KEY = "_shard";

export type ShardKind = "list" | "wantlist" | "deck";

// The byte values of a file name: everything that isn't [A-Za-z0-9_-] is encoded ~xxxx (reversible, so two
// distinct identifiers can never give the same name).
function safeId(id: string): string {
	return id.replace(/[^A-Za-z0-9_-]/g, (c) => `~${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function shardFileName(kind: ShardKind, id: string): string {
	return `${kind}-${safeId(id)}${SHARD_SUFFIX}`;
}

export function isShardFileName(name: string): boolean {
	if (name === CORE_SHARD) return true;
	return /^(list|wantlist|deck)-[A-Za-z0-9_~-]+\.json\.gz$/.test(name);
}

/* --------------------------------- splitting ------------------------------- */

const UNASSIGNED = "_";

function listIdOf(card: Obj): string {
	return typeof card.listId === "string" && card.listId !== "" ? card.listId : UNASSIGNED;
}

function cardId(c: Obj): string {
	return typeof c.id === "string" ? c.id : "";
}

// Same identity as the merge (settings-merge.ts, deckCardKey): only serves to make the order deterministic.
function deckCardKey(e: Obj): string {
	return `${String(e.scryfallId ?? "")}|${typeof e.category === "string" ? e.category : "mainboard"}|${
		e.deckFunctionOverride === "Commander" ? "C" : ""
	}`;
}

function sortedBy(items: Obj[], keyOf: (e: Obj) => string): Obj[] {
	// The sort is stable: two entities with the same key keep their original order.
	return [...items].sort((a, b) => {
		const ka = keyOf(a);
		const kb = keyOf(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
}

function objectsOf(value: unknown): Obj[] {
	return Array.isArray(value) ? (value.filter((e) => e !== null && typeof e === "object") as Obj[]) : [];
}

// The shared state (already without device-specific keys or secrets) → one object per file, the content of
// each shard being deterministic (entities sorted by id) so that two devices with the same state produce the
// same bytes.
export function encodeShards(shared: Obj): Map<string, ShardObj> {
	const out = new Map<string, ShardObj>();

	const core: Obj = { [FORMAT_KEY]: SHARD_FORMAT };
	for (const k of Object.keys(shared)) {
		if (k === "collection" || k === "wantlist") continue;
		core[k] = shared[k];
	}
	// Decks stay in the common shard WITHOUT their cards: their own fields (name, format, dates) are settled
	// by date, their cards travel in the deck's shard.
	if (Array.isArray(shared.decks)) core.decks = objectsOf(shared.decks).map((d) => ({ ...d, cards: [] }));

	const files: [string, ShardObj][] = [[CORE_SHARD, core]];

	const groupCards = (field: "collection" | "wantlist", kind: "list" | "wantlist") => {
		const groups = new Map<string, Obj[]>();
		for (const c of objectsOf(shared[field])) {
			const id = listIdOf(c);
			const g = groups.get(id);
			if (g) g.push(c);
			else groups.set(id, [c]);
		}
		for (const [id, cards] of groups) {
			files.push([shardFileName(kind, id), { [FORMAT_KEY]: SHARD_FORMAT, [field]: sortedBy(cards, cardId) }]);
		}
	};
	groupCards("collection", "list");
	groupCards("wantlist", "wantlist");

	for (const d of objectsOf(shared.decks)) {
		if (typeof d.id !== "string") continue;
		const cards = sortedBy(objectsOf(d.cards), deckCardKey);
		if (cards.length === 0) continue;
		files.push([shardFileName("deck", d.id), { [FORMAT_KEY]: SHARD_FORMAT, decks: [{ id: d.id, cards }] }]);
	}

	files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	for (const [name, obj] of files) out.set(name, obj);
	return out;
}

/* --------------------------------- assemblage ------------------------------ */

function timeOf(c: Obj): number {
	let t = 0;
	for (const f of ["dateModified", "dateAdded", "dateCreated"]) {
		const v = c[f];
		if (typeof v === "number" && v > t) t = v;
	}
	return t;
}

// A card moved from one list to another exists for an instant in TWO shards (the old one is only rewritten
// afterwards): the most recent version wins, on a tie the shard with the greatest name — the same choice
// on all devices, otherwise they wouldn't converge. Without this, the merge would see two distinct
// entities (same key, suffix #2) and duplicate the card.
function dedupeById(cards: { card: Obj; shard: string }[]): Obj[] {
	const byId = new Map<string, { card: Obj; shard: string }>();
	const noId: Obj[] = [];
	for (const entry of cards) {
		const id = cardId(entry.card);
		if (id === "") {
			noId.push(entry.card);
			continue;
		}
		const prev = byId.get(id);
		if (!prev) {
			byId.set(id, entry);
			continue;
		}
		const tp = timeOf(prev.card);
		const tn = timeOf(entry.card);
		if (tn > tp || (tn === tp && entry.shard > prev.shard)) byId.set(id, entry);
	}
	return [...[...byId.values()].map((e) => e.card), ...noId];
}

// The inverse of encodeShards: everything GitHub holds → a complete state, ready to be merged. A missing
// or late shard gives a smaller state, never a wrong one.
export function assembleShards(shards: ReadonlyMap<string, ShardObj>): Obj {
	const out: Obj = {};
	const core = shards.get(CORE_SHARD) ?? {};
	for (const k of Object.keys(core)) if (k !== FORMAT_KEY) out[k] = core[k];

	const names = [...shards.keys()].sort();
	const collect = (prefix: "list-" | "wantlist-", field: "collection" | "wantlist") => {
		const cards: { card: Obj; shard: string }[] = [];
		for (const name of names) {
			if (!name.startsWith(prefix)) continue;
			for (const card of objectsOf(shards.get(name)![field])) cards.push({ card, shard: name });
		}
		return dedupeById(cards);
	};
	const collection = collect("list-", "collection");
	const wantlist = collect("wantlist-", "wantlist");
	if (collection.length > 0 || shards.size > 0) out.collection = collection;
	if (wantlist.length > 0 || shards.size > 0) out.wantlist = wantlist;

	if (Array.isArray(out.decks)) {
		out.decks = objectsOf(out.decks).map((d) => {
			const shard = typeof d.id === "string" ? shards.get(shardFileName("deck", d.id)) : undefined;
			const entry = objectsOf(shard?.decks).find((x) => x.id === d.id);
			return { ...d, cards: entry ? objectsOf(entry.cards) : objectsOf(d.cards) };
		});
	}
	return out;
}

/* ---------------------------------- equality -------------------------------- */

// What no other device gets from these dates: each refreshes its own (prices, backups). A change that
// touches ONLY this is not sent.
const PUSH_IGNORED_SCALARS = ["lastPriceRefresh", "lastAutoBackup"];

function comparable(shard: ShardObj | undefined): Obj {
	const copy: Obj = {};
	if (!shard) return copy;
	for (const k of Object.keys(shard)) if (k !== FORMAT_KEY) copy[k] = shard[k];
	for (const k of PUSH_IGNORED_SCALARS) delete copy[k];
	const stamps = copy.syncStamps;
	if (stamps !== null && typeof stamps === "object" && !Array.isArray(stamps)) {
		const kept = { ...(stamps as Obj) };
		for (const k of PUSH_IGNORED_SCALARS) delete kept[k];
		// Empty = absent: the first timestamp of a refresh must not change anything.
		if (Object.keys(kept).length === 0) delete copy.syncStamps;
		else copy.syncStamps = kept;
	}
	return copy;
}

// A shard (other than the common shard) with no card at all is equivalent to a missing shard: never worth
// creating one, but a remote shard that still has cards we no longer have must be emptied.
export function isEmptyShard(shard: ShardObj | undefined): boolean {
	if (!shard) return true;
	if (Array.isArray(shard.collection)) return shard.collection.length === 0;
	if (Array.isArray(shard.wantlist)) return shard.wantlist.length === 0;
	if (Array.isArray(shard.decks)) return objectsOf(shard.decks).every((d) => objectsOf(d.cards).length === 0);
	return false;
}

// Do two versions of shard `name` say the same thing? Entity order, key order and prices aside — the same
// equality as the merge's (settingsEqual), otherwise two devices would endlessly rewrite an equivalent
// shard to each other. The common shard is never "empty": absent, it differs from any existing common
// shard.
export function shardsEqual(name: string, a: ShardObj | undefined, b: ShardObj | undefined): boolean {
	if (name !== CORE_SHARD) {
		const ea = isEmptyShard(a);
		const eb = isEmptyShard(b);
		if (ea || eb) return ea && eb;
	} else if (!a || !b) {
		return a === b;
	}
	return settingsEqual(comparable(a), comparable(b));
}
