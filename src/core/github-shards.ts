import { settingsEqual } from "./settings-merge";


type Obj = Record<string, unknown>;
export type ShardObj = Obj;

export const SHARD_SUFFIX = ".json.gz";
export const CORE_SHARD = `core${SHARD_SUFFIX}`;
export const SHARD_FORMAT = 2;
const FORMAT_KEY = "_shard";

export type ShardKind = "list" | "wantlist" | "deck";

// Les nombres d'octets d'un nom de fichier : tout ce qui n'est pas [A-Za-z0-9_-] est codé ~xxxx (réversible,
// donc deux identifiants distincts ne peuvent jamais donner le même nom).
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

/* --------------------------------- découpage ------------------------------- */

const UNASSIGNED = "_";

function listIdOf(card: Obj): string {
	return typeof card.listId === "string" && card.listId !== "" ? card.listId : UNASSIGNED;
}

function cardId(c: Obj): string {
	return typeof c.id === "string" ? c.id : "";
}

// Même identité que la fusion (settings-merge.ts, deckCardKey) : sert seulement à rendre l'ordre déterministe.
function deckCardKey(e: Obj): string {
	return `${String(e.scryfallId ?? "")}|${typeof e.category === "string" ? e.category : "mainboard"}|${
		e.deckFunctionOverride === "Commander" ? "C" : ""
	}`;
}

function sortedBy(items: Obj[], keyOf: (e: Obj) => string): Obj[] {
	// Le tri est stable : deux entités de même clé gardent leur ordre d'origine.
	return [...items].sort((a, b) => {
		const ka = keyOf(a);
		const kb = keyOf(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
}

function objectsOf(value: unknown): Obj[] {
	return Array.isArray(value) ? (value.filter((e) => e !== null && typeof e === "object") as Obj[]) : [];
}

// L'état partagé (déjà sans clés propres à l'appareil ni secrets) → un objet par fichier, le contenu de chaque
// fragment étant déterministe (entités triées par identifiant) pour que deux appareils qui ont le même état
// produisent les mêmes octets.
export function encodeShards(shared: Obj): Map<string, ShardObj> {
	const out = new Map<string, ShardObj>();

	const core: Obj = { [FORMAT_KEY]: SHARD_FORMAT };
	for (const k of Object.keys(shared)) {
		if (k === "collection" || k === "wantlist") continue;
		core[k] = shared[k];
	}
	// Les decks restent dans le fragment commun SANS leurs cartes : leurs propres champs (nom, format, dates)
	// se tranchent à la date, leurs cartes voyagent dans le fragment du deck.
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

// Une carte déplacée d'une liste à l'autre existe un instant dans DEUX fragments (l'ancien n'est réécrit
// qu'ensuite) : la version la plus récente l'emporte, à égalité le fragment au nom le plus grand — le même
// choix sur tous les appareils, sinon ils ne convergeraient pas. Sans cela la fusion verrait deux entités
// distinctes (même clé, suffixe #2) et dupliquerait la carte.
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

// L'inverse d'encodeShards : tout ce que GitHub porte → un état complet, prêt à être fusionné. Un fragment
// absent ou arrivé en retard donne un état plus petit, jamais un état faux.
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

/* ---------------------------------- égalité -------------------------------- */

// Ce qu'aucun autre appareil ne tire de ces dates : chacun rafraîchit les siennes (prix, sauvegardes). Un
// changement qui ne touche QUE cela n'est pas envoyé.
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
		// Vide = absent : le premier horodatage d'un rafraîchissement ne doit rien changer.
		if (Object.keys(kept).length === 0) delete copy.syncStamps;
		else copy.syncStamps = kept;
	}
	return copy;
}

// Un fragment (hors fragment commun) sans aucune carte vaut un fragment absent : jamais la peine d'en créer
// un, mais un fragment distant qui a encore des cartes que nous n'avons plus doit être vidé.
export function isEmptyShard(shard: ShardObj | undefined): boolean {
	if (!shard) return true;
	if (Array.isArray(shard.collection)) return shard.collection.length === 0;
	if (Array.isArray(shard.wantlist)) return shard.wantlist.length === 0;
	if (Array.isArray(shard.decks)) return objectsOf(shard.decks).every((d) => objectsOf(d.cards).length === 0);
	return false;
}

// Deux versions du fragment `name` disent-elles la même chose ? Ordre des entités, ordre des clés et prix
// mis à part — la même égalité que celle de la fusion (settingsEqual), faute de quoi deux appareils se
// réécriraient l'un à l'autre un fragment équivalent à l'infini. Le fragment commun n'est jamais "vide" :
// absent, il diffère de tout fragment commun existant.
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
