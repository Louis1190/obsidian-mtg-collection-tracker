/* -------------------------------------------------------------------------- */
/*  Fusion de data.json entre appareils (2026-10-03) — logique pure, aucune
    dépendance à Obsidian, couverte par Vitest.

    Contexte : data.json est synchronisé par Syncthing entre le Mac, l'iPad et
    le téléphone. Avant ce module, chaque appareil réécrivait TOUT son état en
    mémoire à chaque modification : le dernier à écrire gagnait, et les
    modifications faites ailleurs entre-temps disparaissaient en silence (ou
    finissaient dans un data.sync-conflict-*.json que personne ne relisait).

    Principe, en deux volets qui ne se mélangent jamais :

    1. PRÉSENCE d'une entité (carte, liste, deck, carte de deck…) : jamais
       déduite d'une absence. Une entité absente d'un côté est CONSERVÉE, sauf
       si une pierre tombale (`syncTombstones`) dit qu'elle a été supprimée
       après sa dernière modification. Une base "dernier état vu" ne suffit
       pas : un appareil qui saute une version intermédiaire (l'iPad, dont
       l'appli est suspendue par iOS) ne peut pas distinguer "supprimée
       ailleurs" de "jamais vue", et ressusciterait ou supprimerait à tort.
       Le pire cas d'une pierre tombale manquante est donc une carte qui
       revient, jamais une carte perdue.

    2. CONTENU d'une entité présente des deux côtés : fusion champ par champ à
       trois voies (base = dernière version DISTANTE lue, jamais nos propres
       écritures — voir settings-sync.ts). Un champ modifié d'un seul côté
       prend ce côté ; modifié des deux côtés, la `dateModified` la plus
       récente gagne, et à égalité un ordre canonique des valeurs : le
       résultat ne doit jamais dépendre de quel appareil fusionne (sinon deux
       appareils se renverraient indéfiniment chacun leur version).

    3. PRIX et RÉGLAGES — deux cas où une "dernière version vue" ne suffit pas :
       les prix en cache (priceUsd…) sont rafraîchis indépendamment par chaque
       appareil sans toucher à aucune date : ils sont IGNORÉS pour décider si
       deux versions d'une carte diffèrent (sinon chaque rafraîchissement
       quotidien ferait réécrire 6 Mo sur tous les appareils, sans fin) ; et
       les réglages scalaires portent chacun un horodatage (`syncStamps`), le
       plus récent gagne — une valeur remise à son état d'origine ailleurs est
       indiscernable d'une valeur non touchée si on ne compare qu'à une base.

    Les réglages propres à chaque appareil (core/device-settings.ts : tri, mode de
    vue, menu replié…) sont hors de tout ça : jamais écrits, comparés, fusionnés
    ni horodatés ici.

    Cette fonction ne touche à rien : elle renvoie un nouvel état fusionné.
    `applySettingsInPlace` le reporte ensuite SUR les objets existants, pour
    que les fenêtres déjà ouvertes (qui gardent une référence à leur carte)
    continuent de pointer vers des objets vivants.  */
/* -------------------------------------------------------------------------- */

import { DEVICE_LOCAL_KEYS } from "./device-settings";

type Obj = Record<string, unknown>;

export type Tombstones = Record<string, Record<string, number>>;
export type KeySnapshot = Record<string, Set<string>>;

export interface MergeReport {
	added: number;
	removed: number;
	updated: number;
	/** L'état local fusionné diffère de l'état local d'avant. */
	changedLocal: boolean;
	/** L'état fusionné contient quelque chose que la version distante n'a pas : il faut l'écrire. */
	needsWrite: boolean;
}

export interface MergeResult {
	merged: Obj;
	report: MergeReport;
}

// Pierres tombales gardées 90 jours : assez pour qu'un appareil resté éteint
// plusieurs semaines apprenne encore les suppressions, sans que la liste ne
// grossisse indéfiniment (une pierre ~35 octets ; vider 3 000 cartes = ~100 Ko).
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/* ---------------------------------- égalité -------------------------------- */

// Égalité profonde façon JSON : une propriété `undefined` équivaut à une
// propriété absente (JSON.stringify l'omet, donc data.json aussi).
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

// Sérialisation à clés triées : sert UNIQUEMENT à départager deux valeurs en
// conflit de façon identique sur tous les appareils (l'ordre d'insertion des
// clés, lui, dépend de l'appareil qui a construit l'objet).
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

// Égalité de deux entités horodatées, prix mis à part.
function sameContent(a: Obj, b: Obj): boolean {
	for (const k of unionKeys(a, b)) if (!VOLATILE_FIELDS.has(k) && !deepEqual(a[k], b[k])) return false;
	return true;
}

// true = la valeur distante l'emporte. Symétrique : l'appareil A (local = a,
// distant = b) et l'appareil B (local = b, distant = a) choisissent le même gagnant.
function remoteWins(local: unknown, remote: unknown, localTime: number, remoteTime: number): boolean {
	if (remoteTime !== localTime) return remoteTime > localTime;
	return canonical(remote) > canonical(local);
}

/* ------------------------------ entités indexées --------------------------- */

interface Spec {
	keyOf: (e: Obj) => string;
	/** Sous-tableaux d'entités (ex. les cartes d'un deck) et leur fonction de clé. */
	nested?: Record<string, Spec>;
	/**
	 * Entité horodatée (`dateModified`) : en cas de conflit, la version la plus
	 * récente l'emporte EN ENTIER. Pas de fusion champ par champ pour elle : avec
	 * une seule version de départ, un champ remis à sa valeur d'origine par
	 * l'autre appareil est indiscernable d'un champ qu'il n'a pas touché, et les
	 * deux appareils garderaient chacun leur valeur en se la renvoyant sans fin.
	 */
	lww?: boolean;
	/**
	 * Entité sans date de modification propre à l'origine (listes, decks…) : le plugin
	 * en maintient une (`recordEntityStamps`) pour que le conflit se tranche à la date
	 * et non sur une base ambiguë.
	 */
	stamped?: boolean;
}

const byId = (e: Obj): string => (typeof e.id === "string" ? e.id : "");

// DeckCard n'a pas d'id propre (voir data-model.ts) : même identité que celle
// que les fusions/imports de deck utilisent déjà (scryfallId + board + rôle
// Commander) — les choisir autrement ferait fusionner deux lignes que le
// plugin traite comme distinctes, ou l'inverse.
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
	// Les champs du deck se tranchent à la date, ses cartes se fusionnent une à une.
	decks: { keyOf: byId, stamped: true, nested: { cards: { keyOf: deckCardKey, lww: true } } },
};

const TOMBSTONES_KEY = "syncTombstones";
const STAMPS_KEY = "syncStamps";

// Données dérivées, rafraîchies séparément par chaque appareil (refreshAllPrices) :
// jamais une raison de fusionner, d'écrire ou de trancher un conflit.
export const VOLATILE_FIELDS: ReadonlySet<string> = new Set([
	"priceUsd",
	"priceUsdFoil",
	"priceEur",
	"priceEurFoil",
	"priceUsdEtched",
	"priceEurEtched",
]);

// Horodatages qui ne doivent jamais reculer : le plus récent gagne.
const MAX_WINS = new Set(["lastPriceRefresh", "lastAutoBackup"]);

interface KeyedArray {
	keys: string[];
	byKey: Map<string, Obj>;
}

// Deux entités qui partageraient la même clé restent distinctes (suffixe #2,
// #3… dans l'ordre d'apparition) au lieu de s'écraser mutuellement.
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

// Clés présentes par collection, y compris les cartes de deck (clé composite
// `deck|carte`). Sert à repérer, à chaque écriture, ce qui a disparu depuis la
// dernière fois : c'est ce qui devient une pierre tombale.
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

// Retrouve l'objet d'une clé de snapshot (carte de deck comprise).
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

// Compare l'état courant à `prev` (clés connues à la dernière écriture/lecture)
// et inscrit une pierre tombale pour tout ce qui a disparu ; retire celles des
// entités qui viennent de réapparaître (restauration d'une sauvegarde…) ; purge
// les plus anciennes que TOMBSTONE_TTL_MS. Renvoie le nombre de suppressions
// nouvellement inscrites. Mute `settings.syncTombstones`.
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
			// Carte de deck : si le deck lui-même a disparu, sa propre pierre tombale suffit.
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
				// Recréée après avoir été supprimée (restauration d'une sauvegarde, annulation…) :
				// elle doit battre la pierre tombale partout, y compris sur les appareils qui la
				// gardent — sa date de modification passe donc à maintenant.
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

/* ------------------------- égalité indépendante de l'ordre ------------------ */

// Deux appareils fusionnent chacun avec SON ordre (le leur d'abord, puis ce qui
// vient de l'autre) : le même contenu peut donc exister dans deux ordres. Si on
// les jugeait différents, chaque appareil réécrirait le fichier à la réception de
// celui de l'autre, indéfiniment. Les collections d'entités se comparent donc
// par clé, pas par position.
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

// Égalité de deux états de réglages, l'ordre des entités mis à part.
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

/* ------------------------- horodatage des réglages scalaires ---------------- */

const META_KEYS = new Set([TOMBSTONES_KEY, STAMPS_KEY]);

// Valeur canonique de chaque réglage scalaire (tout ce qui n'est ni une
// collection d'entités ni une méta-donnée de synchronisation).
export function snapshotScalars(settings: Obj): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of Object.keys(settings)) {
		if (COLLECTIONS[k] || META_KEYS.has(k) || DEVICE_LOCAL_KEYS.has(k)) continue;
		out[k] = canonical(settings[k]);
	}
	return out;
}

// Date la dernière modification locale de chaque réglage qui a changé depuis
// `prev` (état connu à la dernière écriture/lecture/fusion). Mute `syncStamps`.
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

/* ----------------------- horodatage des listes et des decks ------------------ */

export type EntityPrints = Record<string, Record<string, string>>;

// Empreinte du contenu PROPRE de chaque liste/wantlist/filtre/deck (hors cartes
// d'un deck et hors dateModified lui-même).
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

// Passe `dateModified` à `now` pour toute liste/deck… dont le contenu a changé
// (ou qui vient d'être créée) depuis `prev`. Mute les entités.
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

// Entité horodatée : voir Spec.lww. Les raccourcis "un seul côté a changé" ne
// valent que pour une version distante qui n'est pas plus RÉCENTE que la locale —
// sinon elle a été retouchée (peut-être remise à sa valeur d'origine) après nous.
function resolveByTime(b: Obj | undefined, l: Obj, r: Obj): Obj {
	const lt = modifiedTime(l);
	const rt = modifiedTime(r);
	if (b) {
		// "Un seul côté a changé" : valable seulement si l'autre n'est pas plus ANCIEN que
		// nous. Un fichier livré en retard (version plus vieille que celle déjà vue) ne doit
		// pas écraser une version locale pourtant "inchangée" depuis notre dernière lecture.
		if (sameContent(l, b) && !(lt > rt)) return r;
		if (sameContent(r, b) && !(rt > lt)) return l;
	}
	// Même date, contenus différents : si l'un contient tout l'autre plus des champs
	// en plus (rattrapage d'une version plus récente du plugin, qui ne touche pas
	// à dateModified), c'est le plus complet — jamais l'inverse, sinon le champ
	// ajouté disparaîtrait puis serait rajouté en boucle.
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
		// Même garde que resolveByTime : "l'autre côté n'a pas changé" ne vaut que s'il
		// n'est pas plus récent que nous (sinon il a pu remettre la valeur d'origine).
		else if (b && deepEqual(rv, bv) && !(rt > lt)) v = lv;
		// Conflit réel (ou aucune base) : un champ présent d'un seul côté est
		// conservé — sans base on ne peut pas distinguer "supprimé" de "ajouté
		// par une version plus récente du plugin", et perdre une valeur est
		// pire que d'en garder une en trop.
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
		// Supprimée après sa dernière modification (sur l'un ou l'autre appareil) ?
		const ts = tombColl?.[prefix + key];
		if (ts !== undefined && ts >= entityTime(m)) {
			if (l) ctx.stats.removed++;
			return;
		}
		if (!l) ctx.stats.added++;
		out.push(m);
	};

	// Ordre local d'abord, puis les entités arrivées de l'autre appareil.
	for (const k of L.keys) consider(k, L.byKey.get(k), R.byKey.get(k));
	for (const k of R.keys) if (!L.byKey.has(k)) consider(k, undefined, R.byKey.get(k));
	return out;
}

// Copie superficielle sans certaines clés — et sans leurs horodatages (`syncStamps`). Sert à une source
// qui ne transporte pas tout (GitHub ne reçoit jamais la clé d'API) : ce qu'elle ne porte pas ne doit
// être ni comparé (sinon "il y a toujours quelque chose à lui renvoyer", sans fin) ni fusionné.
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
		// Un champ absent côté distant (appareil sur une version plus ancienne)
		// ne supprime jamais rien ici.
		if (rv === undefined) v = lv;
		else if (lv === undefined) v = rv;
		else if (deepEqual(lv, rv)) v = lv;
		else if (MAX_WINS.has(k) && typeof lv === "number" && typeof rv === "number") v = Math.max(lv, rv);
		else if ((stampsL[k] ?? 0) !== (stampsR[k] ?? 0)) v = (stampsR[k] ?? 0) > (stampsL[k] ?? 0) ? rv : lv;
		// Aucun horodatage (appareil sur une version plus ancienne) : trois voies.
		else if (base && deepEqual(lv, bv)) v = rv;
		else if (base && deepEqual(rv, bv)) v = lv;
		else {
			const lIsDefault = defaults !== undefined && deepEqual(lv, defaults[k]);
			const rIsDefault = defaults !== undefined && deepEqual(rv, defaults[k]);
			// Symétrique : les deux appareils, chacun avec son point de vue local/distant, choisissent la même valeur.
			if (lIsDefault !== rIsDefault) v = lIsDefault ? rv : lv;
			else v = remoteWins(lv, rv, 0, 0) ? rv : lv;
		}
		if (v !== undefined) merged[k] = v;
	}
	const stamps: Record<string, number> = {};
	for (const src of [stampsL, stampsR]) {
		for (const k of Object.keys(src)) {
			if (DEVICE_LOCAL_KEYS.has(k)) continue; // reliquat d'une version qui les synchronisait
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

// Recopie `m` SUR `t` (même objet, nouveau contenu) : une fenêtre ouverte qui
// tient `t` voit la mise à jour ; une entité supprimée, elle, disparaît du tableau.
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

// Reporte `merged` (résultat de mergeSettings, ou une version distante adoptée
// telle quelle) sur `target` en gardant l'identité des objets qui subsistent.
export function applySettingsInPlace(target: Obj, merged: Obj): void {
	for (const k of Object.keys(merged)) {
		const mv = merged[k];
		const tv = target[k];
		const spec = COLLECTIONS[k];
		if (spec && Array.isArray(tv) && Array.isArray(mv)) reconcileArray(tv, mv as Obj[], spec);
		else if (!deepEqual(tv, mv)) target[k] = mv;
	}
}
