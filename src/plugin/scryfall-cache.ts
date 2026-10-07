import {
	ScryfallSetSummary,
	SCRYFALL_HEADERS,
	sanitizeSvg,
	sleep,
	fetchScryfallCollection,
	CardTextInfo,
	buildCardTextInfo,
	DoubleFacedImages,
	getDoubleFacedImages,
	SplitCardInfo,
	getSplitCardInfo as getSplitCardInfoFromScry,
	requestScryfall,
	ScryfallCard,
	ScryfallImmutableSnapshot,
} from "../api/scryfall";
import {
	VIEW_TYPE_MTG_COLLECTION,
} from "../core/data-model";
import { MTGCollectionView } from "../view";
import type MTGCollectionPlugin from "../plugin";
import { CARDMARKET_ID_CACHE_FILENAME } from "./cardbase-cache";

// fetchScryfallCollection rattrape les statuts HTTP (une map vide, voir son commentaire) mais PAS une erreur de transport : hors
// ligne, inspection TLS d'un réseau d'entreprise, portail captif. Les quatre getters de ce fichier qui s'en servent alimentent
// l'interface (boîtes de la fiche détail, vignettes de Home) et ont déjà un cas « échec confirmé » (null, ou carte absente) :
// une erreur de transport y mène désormais aussi, au lieu de laisser la promesse rejetée — un cadre resté sur ses points de
// chargement, une requête « en vol » (legalitiesInFlight) jamais résolue qui bloquait toute ouverture ultérieure de cette carte.
// Les cartes déjà reçues avant l'erreur sont gardées. Les imports, migrations et rafraîchissements de prix appellent
// fetchScryfallCollection directement et gardent l'exception : l'utilisateur doit y lire l'erreur. Aucun échec n'est mis en cache.
async function fetchCollectionOrPartial(
	ids: string[],
	onChunkResolved?: (chunkResults: Map<string, ScryfallCard>) => void
): Promise<Map<string, ScryfallCard>> {
	const received = new Map<string, ScryfallCard>();
	try {
		await fetchScryfallCollection(ids, undefined, (chunkResults) => {
			chunkResults.forEach((card, id) => received.set(id, card));
			onChunkResolved?.(chunkResults);
		});
	} catch {
		/* voir le commentaire ci-dessus : ce qui a été reçu est rendu, le reste est absent */
	}
	return received;
}

/* -------------------------------------------------------------------------- */
/*  External-data caching layer: Scryfall icons/legalities/symbology/
    immutable snapshot, Card Kingdom/Mana Pool/cardbase/frankfurter.ts
    wrappers, mana symbols, print languages. Split out of plugin.ts on
    2026-09-10 -- see CLAUDE.md's "Scryfall API usage" section.  */
/* -------------------------------------------------------------------------- */

export const ALL_SETS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const ALL_SETS_CACHE_FILENAME = "all-sets-cache.json";
export const PRINT_LANGUAGES_CACHE_FILENAME = "print-languages-cache.json";
export const LEGALITIES_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LEGALITIES_CACHE_FILENAME = "legalities-cache.json";
export const LEGALITIES_PERSIST_DEBOUNCE_MS = 3000;
export const ICON_CACHE_FILENAME = "icon-cache.json";
export const SCRYFALL_IMMUTABLE_CACHE_FILENAME = "scryfall-immutable-cache.json";
export const IMMUTABLE_CACHE_PERSIST_DEBOUNCE_MS = 3000;
export async function getSetIconSvg(this: MTGCollectionPlugin, setCode: string): Promise<string | null> {
	const cached = this.setIconCache.get(setCode);
	if (cached !== undefined) return cached;

	const inFlight = this.setIconInFlight.get(setCode);
	if (inFlight) return inFlight;

	const promise = this.setIconFetchQueue.then(() => this.fetchSetIconSvg(setCode));
	this.setIconInFlight.set(setCode, promise);
	void promise.finally(() => this.setIconInFlight.delete(setCode));
	// Fait avancer la file d'un cran une fois CE fetch lancé (pas
	// seulement une fois résolu, pour ne pas bloquer un appelant déjà en
	// attente derrière lui) : le prochain nouveau code en attente ne
	// pourra démarrer qu'une fois celui-ci terminé, PLUS une pause de
	// 120ms — même pause que fetchScryfallCollection entre ses propres
	// lots (bonne pratique Scryfall). Les deux branches du .then
	// (succès/échec) font la même chose : fetchSetIconSvg ne rejette
	// jamais elle-même (son propre try/catch renvoie toujours null), mais
	// gérer les deux reste une garantie bon marché contre un futur appelant
	// qui romprait cette invariant sans le savoir.
	this.setIconFetchQueue = promise.then(
		() => sleep(120),
		() => sleep(120)
	);
	return promise;
}


export async function fetchSetIconSvg(this: MTGCollectionPlugin, setCode: string): Promise<string | null> {
	try {
		const setRes = await requestScryfall({
			url: `https://api.scryfall.com/sets/${encodeURIComponent(setCode.toLowerCase())}`,
			headers: SCRYFALL_HEADERS,
			throw: false,
		});
		if (setRes.status === 404) {
			this.setIconCache.set(setCode, null);
			this.scheduleMapCachePersist(ICON_CACHE_FILENAME, this.setIconCache);
			return null;
		}
		if (setRes.status !== 200 || !setRes.json?.icon_svg_uri) {
			return null;
		}
		const svgRes = await requestScryfall({
			url: setRes.json.icon_svg_uri,
			headers: SCRYFALL_HEADERS,
			throw: false,
		});
		if (svgRes.status !== 200) {
			return null;
		}
		const svg = sanitizeSvg(svgRes.text);
		this.setIconCache.set(setCode, svg);
		this.scheduleMapCachePersist(ICON_CACHE_FILENAME, this.setIconCache);
		return svg;
	} catch {
		return null;
	}
}

// Ne consulte PAS isLegalitiesFresh (contrairement à bulkFetchLegalities
// plus bas) — délibéré : le pré-chauffage périodique en arrière-plan
// (maybeAutoRefreshLegalities, toutes les heures) garde déjà toute la
// collection sous LEGALITIES_CACHE_TTL_MS dans l'immense majorité des
// cas, donc une entrée trouvée ici est presque toujours fraîche de toute
// façon ; ajouter la vérification ici forcerait un aller-retour réseau
// à l'OUVERTURE de chaque fiche détail dans la rare fenêtre où l'entrée
// vient tout juste d'expirer, pour un gain marginal.

export async function getCardLegalities(this: MTGCollectionPlugin, scryfallId: string): Promise<Record<string, string> | null> {
	const cached = this.legalitiesCache.get(scryfallId);
	if (cached !== undefined) return cached;

	const inFlight = this.legalitiesInFlight.get(scryfallId);
	if (inFlight) return inFlight;

	const promise = this.fetchCardLegalities(scryfallId);
	this.legalitiesInFlight.set(scryfallId, promise);
	void promise.finally(() => this.legalitiesInFlight.delete(scryfallId));
	return promise;
}

// Lecture synchrone du cache, sans passer par une Promise — utilisé par
// renderLegalFormatsBox pour poser les tuiles directement dans leur état
// final (pas d'état neutre intermédiaire, donc pas de transition CSS
// visible) quand la carte a déjà été révélée dans la fenêtre ouverte :
// même un cache hit dans getCardLegalities reste asynchrone (une
// fonction async renvoie toujours une Promise), ce qui suffisait à
// laisser le navigateur peindre l'état neutre une frame avant le
// correctif.

export function getCachedLegalities(this: MTGCollectionPlugin, scryfallId: string): Record<string, string> | undefined {
	return this.legalitiesCache.get(scryfallId);
}

// Exposition en bloc de legalitiesCache pour le filtre "legal:" de My
// Collection (card-search.ts, cardMatchesTokens/legalityTokenMatches) :
// cardMatchesTokens tourne sur potentiellement des milliers de cartes
// d'un coup, un aller-retour par carte via getCachedLegalities serait
// inutilement indirect quand tout ce qu'il faut est une simple lecture
// Map.get(scryfallId). Renvoie la Map elle-même (pas une copie) — lue,
// jamais mutée, par les appelants, même précédent que
// recentlyAddedCollectionCardIds (champ public exposé tel quel) plus haut dans ce
// fichier.

export function getLegalitiesCache(this: MTGCollectionPlugin): Map<string, Record<string, string>> {
	return this.legalitiesCache;
}

// Vrai si legalitiesCache a une entrée pour cet id ET qu'elle n'a pas
// dépassé LEGALITIES_CACHE_TTL_MS — la seule question que se posent les
// méthodes de FETCH ci-dessous ("faut-il redemander ?"). N'est
// délibérément consultée par AUCUN chemin d'affichage (getCachedLegalities,
// getLegalitiesCache, le bloc Legal Formats, le filtre "legal:") : une
// entrée expirée reste un résultat probablement encore correct et vaut
// largement mieux affichée tout de suite qu'un état "chargement" pour
// une donnée qui, la plupart du temps, n'a en réalité pas changé.

export function isLegalitiesFresh(this: MTGCollectionPlugin, scryfallId: string): boolean {
	const fetchedAt = this.legalitiesFetchedAt.get(scryfallId);
	return fetchedAt !== undefined && Date.now() - fetchedAt < LEGALITIES_CACHE_TTL_MS;
}


export function legalitiesCacheFilePath(this: MTGCollectionPlugin): string | null {
	// this.manifest.dir n'est en principe jamais absent pour un plugin
	// effectivement chargé, mais son type Obsidian le déclare optionnel —
	// dégradation silencieuse vers un cache session-only (comportement
	// d'avant cette fonctionnalité) plutôt qu'une erreur si jamais.
	return this.manifest.dir ? `${this.manifest.dir}/${LEGALITIES_CACHE_FILENAME}` : null;
}

// Recharge, au démarrage, le cache écrit par une session précédente
// (voir scheduleLegalitiesPersist/flushLegalitiesPersist plus bas) —
// avant que maybeAutoRefreshLegalities ne décide quoi (re)demander à
// Scryfall. Un fichier absent (première utilisation), corrompu, ou une
// entrée mal formée n'est jamais traité comme une erreur bloquante :
// dans tous ces cas on démarre simplement avec un cache vide, exactement
// le comportement d'avant cette fonctionnalité.

export async function loadPersistedLegalitiesCache(this: MTGCollectionPlugin): Promise<void> {
	const path = this.legalitiesCacheFilePath();
	if (!path) return;
	try {
		if (!(await this.app.vault.adapter.exists(path))) return;
		const raw = await this.app.vault.adapter.read(path);
		const parsed = JSON.parse(raw) as Record<
			string,
			{ legalities?: Record<string, string>; fetchedAt?: number }
		>;
		for (const [scryfallId, entry] of Object.entries(parsed)) {
			if (!entry?.legalities || typeof entry.fetchedAt !== "number") continue;
			this.legalitiesCache.set(scryfallId, entry.legalities);
			this.legalitiesFetchedAt.set(scryfallId, entry.fetchedAt);
		}
	} catch {
		// Silencieux par design — voir le commentaire de la méthode.
	}
}

// Écriture différée (voir LEGALITIES_PERSIST_DEBOUNCE_MS) déclenchée par
// tout fetch réussi (fetchCardLegalities/bulkFetchLegalities ci-dessous),
// même idiome que pendingSaveTimer/saveSettings (src/plugin/lifecycle.ts)
// — regrouper les résolutions rapprochées d'un pré-fetch en une
// seule écriture, pas une par carte.

export function scheduleLegalitiesPersist(this: MTGCollectionPlugin) {
	if (this.legalitiesPersistTimer !== null) window.clearTimeout(this.legalitiesPersistTimer);
	this.legalitiesPersistTimer = window.setTimeout(() => {
		this.legalitiesPersistTimer = null;
		void this.flushLegalitiesPersist();
	}, LEGALITIES_PERSIST_DEBOUNCE_MS);
}


export async function flushLegalitiesPersist(this: MTGCollectionPlugin): Promise<void> {
	const path = this.legalitiesCacheFilePath();
	if (!path) return;
	const out: Record<string, { legalities: Record<string, string>; fetchedAt: number }> = {};
	this.legalitiesCache.forEach((legalities, scryfallId) => {
		const fetchedAt = this.legalitiesFetchedAt.get(scryfallId);
		// Une entrée sans horodatage ne peut venir que d'un futur appelant
		// qui écrirait dans legalitiesCache sans passer par
		// fetchCardLegalities/bulkFetchLegalities — n'existe pas
		// aujourd'hui, mais mieux vaut l'omettre silencieusement du
		// fichier persisté que planter sur une entrée mal formée.
		if (fetchedAt !== undefined) out[scryfallId] = { legalities, fetchedAt };
	});
	try {
		await this.app.vault.adapter.write(path, JSON.stringify(out));
	} catch {
		// Écriture ratée (disque plein, synchronisation en cours…) : la
		// Map en mémoire reste correcte pour le reste de la session, et
		// la prochaine mutation du cache retentera l'écriture.
	}
}

/* ------------------------------------------------------------------ */
/*  Generic persistence for small, effectively-immutable Scryfall      */
/*  caches (set icons/mana symbols, card text, TCGplayer/Cardmarket    */
/*  links, double-faced/split-card info, print languages) — factored   */
/*  into one shared mechanism once the same load/schedule/flush trio   */
/*  would otherwise have been hand-copied 7 times over (icon cache     */
/*  first, then 6 more requested the same session) — same "extract     */
/*  once duplication would reach one copy too many" reasoning already  */
/*  applied once in this plugin for addModalCloseButton/               */
/*  modal-animation.ts. legalitiesCache keeps its OWN separate          */
/*  mechanism (above): it genuinely needs a per-entry TTL/fetchedAt    */
/*  wrapper none of these 4 caches do, forcing it into this simpler    */
/*  shape would have complicated both for no benefit. allSetsCache     */
/*  (below) also stays separate — it needs a TTL too (new sets get     */
/*  added regularly), just a single one for the whole list rather      */
/*  than per-entry.                                                    */
/* ------------------------------------------------------------------ */

// Un seul Map de timers de debounce, partagé par les 4 caches ci-dessus —
// clé = nom de fichier, évite un champ de timer dédié par cache (7
// aujourd'hui, potentiellement plus demain).


export function immutableCacheFilePath(this: MTGCollectionPlugin, filename: string): string | null {
	// Même dégradation silencieuse que legalitiesCacheFilePath ci-dessus
	// (manifest.dir absent -> cache session-only, comportement d'avant
	// cette fonctionnalité) si jamais.
	return this.manifest.dir ? `${this.manifest.dir}/${filename}` : null;
}

// Recharge, au démarrage, un cache écrit par une session précédente —
// avant le premier rendu de la vue, pour qu'un maximum de lignes/boîtes
// affichent leur contenu dès la première frame plutôt que d'attendre un
// aller-retour Scryfall. Un fichier absent (première utilisation),
// corrompu, ou une entrée mal formée (isValid) n'est jamais traité comme
// une erreur bloquante : dans tous ces cas on démarre simplement avec un
// cache vide pour cette clé — même posture que loadPersistedLegalitiesCache.
// isValid est un simple prédicat booléen (pas un garde de type TypeScript)
// — voir le commentaire des validateurs isStringOrNull/isNumberOrNull/
// isObjectOrNull/isStringArray en tête de fichier pour pourquoi.

export function scheduleMapCachePersist(this: MTGCollectionPlugin, filename: string, map: ReadonlyMap<string, unknown>): void {
	const existing = this.immutableCachePersistTimers.get(filename);
	if (existing !== undefined) window.clearTimeout(existing);
	const timer = window.setTimeout(() => {
		this.immutableCachePersistTimers.delete(filename);
		void this.flushMapCachePersist(filename, map);
	}, IMMUTABLE_CACHE_PERSIST_DEBOUNCE_MS);
	this.immutableCachePersistTimers.set(filename, timer);
}


export async function flushMapCachePersist(this: MTGCollectionPlugin, filename: string, map: ReadonlyMap<string, unknown>): Promise<void> {
	const path = this.immutableCacheFilePath(filename);
	if (!path) return;
	try {
		await this.app.vault.adapter.write(path, JSON.stringify(Object.fromEntries(map)));
	} catch {
		// Écriture ratée : la Map en mémoire reste correcte pour le reste de
		// la session, la prochaine mutation retentera l'écriture — même
		// raisonnement que flushLegalitiesPersist ci-dessus.
	}
}

// Force l'écriture immédiate de tout debounce encore en attente pour l'un
// des 4 caches ci-dessus (voir onunload) — non attendu (onunload() n'est
// pas garanti d'attendre une Promise par Obsidian), mais mieux que de
// perdre silencieusement les dernières entrées résolues juste avant la
// fermeture. Liste explicite plutôt qu'un registre dynamique
// filename->Map : seulement 4 entrées, plus lisible/grep-able qu'une
// indirection pour un si petit nombre.

export function flushPendingImmutableCaches(this: MTGCollectionPlugin): void {
	const caches: [string, ReadonlyMap<string, unknown>][] = [
		[ICON_CACHE_FILENAME, this.setIconCache],
		[SCRYFALL_IMMUTABLE_CACHE_FILENAME, this.scryfallImmutableCache],
		[CARDMARKET_ID_CACHE_FILENAME, this.cardmarketIdCache],
		[PRINT_LANGUAGES_CACHE_FILENAME, this.printLanguagesCache],
	];
	caches.forEach(([filename, map]) => {
		const timer = this.immutableCachePersistTimers.get(filename);
		if (timer === undefined) return;
		window.clearTimeout(timer);
		this.immutableCachePersistTimers.delete(filename);
		void this.flushMapCachePersist(filename, map);
	});
}


export function allSetsCacheFilePath(this: MTGCollectionPlugin): string | null {
	return this.manifest.dir ? `${this.manifest.dir}/${ALL_SETS_CACHE_FILENAME}` : null;
}

// Recharge, au démarrage, la liste d'éditions persistée si elle est
// encore fraîche (ALL_SETS_CACHE_TTL_MS) — contrairement aux 4 caches
// ci-dessus, une liste expirée n'est PAS chargée du tout : allSetsCache
// reste `null`, et getAllScryfallSets() (plus bas) retombe alors sur son
// comportement déjà existant (fetch réseau au premier appel de la
// session). Un fichier absent, corrompu, ou une entrée mal formée n'est
// jamais traité comme une erreur bloquante — même posture que les autres
// caches persistés de ce fichier.

export async function loadPersistedAllSetsCache(this: MTGCollectionPlugin): Promise<void> {
	const path = this.allSetsCacheFilePath();
	if (!path) return;
	try {
		if (!(await this.app.vault.adapter.exists(path))) return;
		const raw = await this.app.vault.adapter.read(path);
		const parsed = JSON.parse(raw) as { fetchedAt?: number; sets?: ScryfallSetSummary[] };
		if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.sets)) return;
		if (Date.now() - parsed.fetchedAt >= ALL_SETS_CACHE_TTL_MS) return;
		this.allSetsCache = parsed.sets;
	} catch {
		// Silencieux par design — voir le commentaire de la méthode.
	}
}

// Écrit immédiatement (pas de debounce ici, contrairement aux 4 caches
// ci-dessus) : un seul appel par session au maximum déclenche ceci
// (getAllScryfallSets ne re-fetch qu'une fois allSetsCache vidé/expiré),
// pas une rafale de résolutions rapprochées à regrouper. Fire-and-forget
// depuis son unique appelant (getAllScryfallSets) — ne doit pas retarder
// la réponse déjà obtenue pour l'appelant réel.

export async function persistAllSetsCache(this: MTGCollectionPlugin): Promise<void> {
	const path = this.allSetsCacheFilePath();
	if (!path || !this.allSetsCache) return;
	try {
		await this.app.vault.adapter.write(
			path,
			JSON.stringify({ fetchedAt: Date.now(), sets: this.allSetsCache })
		);
	} catch {
		// Écriture ratée : allSetsCache reste correct en mémoire pour le
		// reste de la session, seule la persistance sur disque a échoué.
	}
}


export async function maybeAutoRefreshLegalities(this: MTGCollectionPlugin): Promise<void> {
	const uniqueIds = Array.from(
		new Set(
			[...this.settings.collection, ...this.settings.wantlist]
				.filter((c) => c.scryfallId)
				.map((c) => c.scryfallId)
		)
	);
	if (uniqueIds.length === 0) return;
	const fetchedSomething = await this.bulkFetchLegalities(uniqueIds);
	// Même geste que maybeAutoRefreshPrices (price-refresh.ts) : une vue déjà
	// ouverte (restaurée par Obsidian au démarrage) doit refléter les
	// données fraîchement arrivées — un simple render(), rien de plus
	// intrusif qu'un rafraîchissement de prix ne l'est déjà.
	if (fetchedSomething) {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
			if (leaf.view instanceof MTGCollectionView) leaf.view.render();
		});
	}
}

// Pré-remplissage en arrière-plan de legalitiesCache pour toute une
// liste, déclenché par MTGCollectionView dès qu'un jeton "legal:" est
// actif dans le filtre de My Collection (voir tokensNeedLegalityData,
// card-search.ts) — contrairement à getCardLegalities/fetchCardLegalities
// ci-dessus (un aller-retour par carte, pour le bloc "Legal Formats" d'une
// seule fiche détail), ce filtre a potentiellement besoin des légalités de
// toute une liste (voire "All Cards") d'un coup. Également le point
// d'entrée du pré-chauffage silencieux au démarrage (voir
// maybeAutoRefreshLegalities juste au-dessus) — un seul chemin de fetch
// groupé pour les deux usages plutôt que deux implémentations à tenir
// synchronisées. fetchScryfallCollection segmente déjà en lots de 75
// avec une pause entre chaque lot (bonne pratique Scryfall) — pas besoin
// de reproduire cette logique ici, un seul appel suffit quelle que soit
// la taille de la liste.
// "Manquant" veut maintenant dire "absent OU expiré" (voir
// isLegalitiesFresh), pas seulement "absent" comme avant l'ajout du
// cache persisté/TTL — une entrée fraîche (chargée depuis le disque ou
// déjà refetchée cette session) est un no-op immédiat.
// Renvoie `true` seulement si au moins un id manquant/expiré a été
// demandé (donc si le cache a effectivement pu changer) : les deux
// appelants (renderListDetail, maybeAutoRefreshLegalities) s'en servent
// pour ne déclencher un nouveau rendu que lorsque c'est réellement
// utile, plutôt qu'à chaque passage (un rendu inconditionnel depuis
// renderListDetail bouclerait, puisque ce rendu lui-même rappelle cette
// méthode).
// Bug rapporté deux fois — une carte nouvellement ajoutée n'affichait
// aucune légalité, et plus généralement rien ne s'affichait avant que
// TOUT le fetch (potentiellement toute la collection, ~134 lots de 75)
// soit terminé — root-causé jusqu'à `fetchScryfallCollection` : la
// version précédente de cette méthode dérivait la Promise de CHAQUE id
// d'une seule Promise partagée sur tout `missing`, elle-même résolue
// seulement après le TOUT DERNIER lot — même la carte dont les données
// arrivaient dans le premier lot devait donc attendre les ~133 lots
// suivants (plusieurs dizaines de secondes sur une grosse collection).
// Une carte nouvellement ajoutée n'était pas différente en soi — elle
// se retrouvait simplement, par malchance, à faire partie d'un même
// gros lot partagé (le pré-chauffage silencieux au démarrage, ou le
// fetch de toute une liste filtrée par "legal:") plutôt que d'obtenir
// sa propre requête isolée. Fixé en résolvant chaque id dès que SON
// PROPRE lot de 75 revient (voir onChunkResolved, fetchScryfallCollection)
// plutôt qu'à la toute fin de l'ensemble.

export async function bulkFetchLegalities(this: MTGCollectionPlugin, scryfallIds: string[]): Promise<boolean> {
	const missing = Array.from(new Set(scryfallIds)).filter(
		(id) => id && !this.isLegalitiesFresh(id) && !this.legalitiesInFlight.has(id)
	);
	if (missing.length === 0) return false;

	// Un resolver par id (motif Promise-avec-executor-externe) plutôt
	// qu'une Promise dérivée d'un résultat final unique — c'est ce qui
	// permet à onChunkResolved ci-dessous de résoudre chaque id
	// individuellement, dès que son propre lot revient, au lieu de tout
	// le monde attendant le dernier lot ensemble.
	const resolvers = new Map<string, (legalities: Record<string, string> | null) => void>();
	missing.forEach((id) => {
		const perId = new Promise<Record<string, string> | null>((resolve) => resolvers.set(id, resolve));
		this.legalitiesInFlight.set(id, perId);
		void perId.finally(() => this.legalitiesInFlight.delete(id));
	});

	await fetchCollectionOrPartial(missing, (chunkResults) => {
		const now = Date.now();
		chunkResults.forEach((card, id) => {
			if (!card.legalities) return;
			this.legalitiesCache.set(id, card.legalities);
			this.legalitiesFetchedAt.set(id, now);
			resolvers.get(id)?.(card.legalities);
			resolvers.delete(id);
		});
	});

	// Un id encore non résolu ici (lot raté — voir le commentaire de
	// fetchCardLegalities plus bas — ou carte introuvable côté Scryfall)
	// doit quand même voir sa Promise se terminer, sans quoi
	// legalitiesInFlight le garderait "en vol" indéfiniment, bloquant
	// silencieusement tout futur appel pour ce même id.
	resolvers.forEach((resolve) => resolve(null));

	this.scheduleLegalitiesPersist();
	return true;
}

// Un aller-retour raté (limite de requêtes, coupure réseau) sur ce point
// d'accès groupé renvoie une map vide sans lever d'erreur (voir
// fetchScryfallCollection) — sans nouvelle tentative, la carte ratait
// alors silencieusement sa légalité pour toute la durée de cette fenêtre
// (aucun cache écrit sur échec, donc un futur réouverture aurait fini par
// réessayer, mais pas l'ouverture en cours). Une unique retentative après
// une courte pause suffit à absorber l'immense majorité des ratés
// purement transitoires.

export async function fetchCardLegalities(this: MTGCollectionPlugin, scryfallId: string): Promise<Record<string, string> | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const map = await fetchCollectionOrPartial([scryfallId]);
		const card = map.get(scryfallId);
		if (card?.legalities) {
			this.legalitiesCache.set(scryfallId, card.legalities);
			this.legalitiesFetchedAt.set(scryfallId, Date.now());
			this.scheduleLegalitiesPersist();
			return card.legalities;
		}
		if (attempt === 0) await sleep(300);
	}
	return null;
}

// Point d'entrée partagé par les 4 dérivations ci-dessous (getTcgplayerUrl/
// getCardTextInfo/getCardFaceImages/getSplitCardInfo) — cache + requête en
// vol partagée + retentative, même idiome que getCardLegalities plus haut.
// L'in-flight dedup fait tout le travail pour éviter une rafale : les 4
// méthodes publiques appellent chacune celle-ci indépendamment (elles
// n'ont pas connaissance les unes des autres) quand une fiche carte
// s'ouvre, mais comme aucune n'attend de résultat réseau avant que les 3
// autres n'aient elles-mêmes appelé cette méthode dans le même tick
// synchrone, seule la PREMIÈRE déclenche réellement fetchScryfallCollection
// — les 3 suivantes retrouvent la promesse déjà posée dans
// scryfallImmutableInFlight et l'attendent à la place d'un nouvel appel
// réseau. Voir ScryfallImmutableSnapshot (scryfall.ts) pour le détail des
// champs conservés/exclus.

export async function getScryfallImmutableSnapshot(this: MTGCollectionPlugin, 
	scryfallId: string
): Promise<ScryfallImmutableSnapshot | null> {
	const cached = this.scryfallImmutableCache.get(scryfallId);
	if (cached !== undefined) return cached;

	const inFlight = this.scryfallImmutableInFlight.get(scryfallId);
	if (inFlight) return inFlight;

	const promise = this.fetchScryfallImmutableSnapshot(scryfallId);
	this.scryfallImmutableInFlight.set(scryfallId, promise);
	void promise.finally(() => this.scryfallImmutableInFlight.delete(scryfallId));
	return promise;
}

// Même logique de retentative que fetchCardLegalities ci-dessus.

export async function fetchScryfallImmutableSnapshot(this: MTGCollectionPlugin, 
	scryfallId: string
): Promise<ScryfallImmutableSnapshot | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const map = await fetchCollectionOrPartial([scryfallId]);
		const card = map.get(scryfallId);
		if (card) {
			const snapshot: ScryfallImmutableSnapshot = {
				oracle_text: card.oracle_text,
				power: card.power,
				toughness: card.toughness,
				loyalty: card.loyalty,
				card_faces: card.card_faces,
				purchase_uris: card.purchase_uris,
				image_uris: card.image_uris,
				layout: card.layout,
				keywords: card.keywords,
				set: card.set,
				set_name: card.set_name,
				collector_number: card.collector_number,
				rarity: card.rarity,
				mana_cost: card.mana_cost,
				type_line: card.type_line,
			};
			this.scryfallImmutableCache.set(scryfallId, snapshot);
			this.scheduleMapCachePersist(
				SCRYFALL_IMMUTABLE_CACHE_FILENAME,
				this.scryfallImmutableCache
			);
			return snapshot;
		}
		if (attempt === 0) await sleep(300);
	}
	return null;
}

// Variante lot de la fonction ci-dessus, pour Home's Market Trends
// (renderHomeMarketTrends, view/home-render.ts) : jusqu'à 10 movers
// (gainers+losers) affichés à la fois, chacun avec sa propre image/édition/
// rareté à afficher — les résoudre un par un via getScryfallImmutableSnapshot
// ferait 10 aller-retours HTTP séquentiels (même goulet que
// fetchScryfallImmutableSnapshot ci-dessus, qui appelle déjà /cards/
// collection mais avec un seul id à chaque fois) alors qu'un seul appel à
// fetchScryfallCollection avec tous les ids couvre déjà ce volume en un seul
// lot de 75. Partage le MÊME cache que la version singulière (un id résolu
// par l'une profite à l'autre) plutôt qu'un cache séparé — voir "Scryfall API
// usage" dans CLAUDE.md ("un seul cache partagé plutôt que N séparés").
// cached.set !== undefined (pas juste cached !== undefined) : un snapshot mis
// en cache par une session AVANT l'élargissement de ScryfallImmutableSnapshot
// (set/set_name/collector_number/rarity, voir son propre commentaire dans
// scryfall.ts) n'a pas ces champs en pratique — le traiter comme un cache miss
// re-fetch et complète cette entrée pour de bon, plutôt que de renvoyer un
// snapshot incomplet ou d'invalider tout le cache disque existant.
export async function getScryfallImmutableSnapshots(this: MTGCollectionPlugin,
	scryfallIds: string[]
): Promise<Map<string, ScryfallImmutableSnapshot>> {
	const result = new Map<string, ScryfallImmutableSnapshot>();
	const missing: string[] = [];
	for (const id of new Set(scryfallIds)) {
		const cached = this.scryfallImmutableCache.get(id);
		if (cached && cached.set !== undefined) result.set(id, cached);
		else missing.push(id);
	}
	if (missing.length === 0) return result;

	const fetched = await fetchCollectionOrPartial(missing);
	for (const id of missing) {
		const card = fetched.get(id);
		if (!card) continue;
		const snapshot: ScryfallImmutableSnapshot = {
			oracle_text: card.oracle_text,
			power: card.power,
			toughness: card.toughness,
			loyalty: card.loyalty,
			card_faces: card.card_faces,
			purchase_uris: card.purchase_uris,
			image_uris: card.image_uris,
			layout: card.layout,
			keywords: card.keywords,
			set: card.set,
			set_name: card.set_name,
			collector_number: card.collector_number,
			rarity: card.rarity,
			mana_cost: card.mana_cost,
			type_line: card.type_line,
		};
		this.scryfallImmutableCache.set(id, snapshot);
		result.set(id, snapshot);
	}
	this.scheduleMapCachePersist(SCRYFALL_IMMUTABLE_CACHE_FILENAME, this.scryfallImmutableCache);
	return result;
}

// Lien produit TCGplayer (ligne "TCGplayer" de la box Store Prices).
// `null` est une réponse valide (carte sans lien TCGplayer, ex. token/art
// card) ; un snapshot introuvable après retentative renvoie aussi `null`
// mais sans être mis en cache par getScryfallImmutableSnapshot lui-même,
// pour permettre une nouvelle tentative plus tard dans la session.

export async function getTcgplayerUrl(this: MTGCollectionPlugin, scryfallId: string): Promise<string | null> {
	const snapshot = await this.getScryfallImmutableSnapshot(scryfallId);
	return snapshot?.purchase_uris?.tcgplayer ?? null;
}

// Texte de règles + stats (bloc "Card Text" du détail) — voir
// buildCardTextInfo (scryfall.ts) pour le repli card_faces sur les cartes
// double-face. `null` uniquement si le snapshot lui-même est introuvable ;
// un oracle_text vide (créature vanille) est un CardTextInfo bien réel.

export async function getCardTextInfo(this: MTGCollectionPlugin, scryfallId: string): Promise<CardTextInfo | null> {
	const snapshot = await this.getScryfallImmutableSnapshot(scryfallId);
	return snapshot ? buildCardTextInfo(snapshot) : null;
}

// Bouton "flip" 3D sous la carte (transform/modal_dfc uniquement — voir
// getDoubleFacedImages, scryfall.ts, pour comment cette fonction
// distingue une vraie carte recto/verso physique d'un layout split/
// adventure/flip/meld, qui a aussi une card_faces[] mais un seul visuel
// imprimé).

export async function getCardFaceImages(this: MTGCollectionPlugin, scryfallId: string): Promise<DoubleFacedImages | null> {
	const snapshot = await this.getScryfallImmutableSnapshot(scryfallId);
	return snapshot ? getDoubleFacedImages(snapshot) : null;
}

// Bouton "rotation" des cartes split (voir getSplitCardInfo, scryfall.ts,
// et setupSplitCardRotation, card-detail-fx.ts).

export async function getSplitCardInfo(this: MTGCollectionPlugin, scryfallId: string): Promise<SplitCardInfo | null> {
	const snapshot = await this.getScryfallImmutableSnapshot(scryfallId);
	return snapshot ? getSplitCardInfoFromScry(snapshot) : null;
}

// Liste complète des éditions existantes (nom + code + symbole), récupérée
// une seule fois par session via l'unique point d'accès groupé de Scryfall
// — évite un aller-retour par édition. Sert à l'autocomplétion du champ
// "Set" dans la recherche d'ajout, à la place d'un code à connaître par
// cœur.

export async function getAllScryfallSets(this: MTGCollectionPlugin): Promise<ScryfallSetSummary[]> {
	if (this.allSetsCache) return this.allSetsCache;
	try {
		const res = await requestScryfall({
			url: "https://api.scryfall.com/sets",
			headers: SCRYFALL_HEADERS,
			throw: false,
		});
		if (res.status !== 200) return [];
		const sets = (res.json.data as ScryfallSetSummary[]) ?? [];
		// Les éditions numériques (Arena) n'ont pas de sens pour un plugin de
		// cartes physiques.
		this.allSetsCache = sets.filter((s) => !s.digital);
		// Fire-and-forget : ne retarde pas la réponse déjà obtenue pour
		// l'appelant réel, voir le commentaire de persistAllSetsCache.
		void this.persistAllSetsCache();
		return this.allSetsCache;
	} catch {
		return [];
	}
}

// Lecture synchrone du cache déjà chargé (pour l'affichage immédiat d'une
// puce "set:xyz" sans attendre un aller-retour réseau). Renvoie undefined
// si le cache n'est pas encore chaud — l'appelant se rabat alors sur le
// code brut en majuscules.

export function getCachedSetSummary(this: MTGCollectionPlugin, code: string): ScryfallSetSummary | undefined {
	return this.allSetsCache?.find((s) => s.code.toLowerCase() === code.toLowerCase());
}

// Charge (une fois par session) la table complète des symboles Scryfall.
// N'écrit symbologyCache qu'en cas de succès confirmé : un échec
// transitoire ne doit pas figer une table vide pour le reste de la
// session (ça privait alors TOUS les symboles de mana d'icône, pas
// seulement celui demandé au moment de l'échec).

export async function loadSymbology(this: MTGCollectionPlugin): Promise<Map<string, string>> {
	if (this.symbologyCache) return this.symbologyCache;
	if (!this.symbologyFetchPromise) {
		this.symbologyFetchPromise = (async () => {
			const res = await requestScryfall({
				url: "https://api.scryfall.com/symbology",
				headers: SCRYFALL_HEADERS,
				throw: false,
			});
			if (res.status !== 200) {
				this.symbologyFetchPromise = null;
				throw new Error(`Scryfall symbology request failed (${res.status})`);
			}
			const map = new Map<string, string>();
			(res.json.data as { symbol: string; svg_uri: string }[]).forEach((sym) => {
				map.set(sym.symbol, sym.svg_uri);
			});
			this.symbologyCache = map;
			return map;
		})();
	}
	return this.symbologyFetchPromise;
}

// Récupère l'icône officielle d'un symbole de mana (W/U/B/R/G/C...) fournie
// par Scryfall via son endpoint "symbology", prévu pour cet usage tiers.

export async function getManaSymbolSvg(this: MTGCollectionPlugin, colorLetter: string): Promise<string | null> {
	const cacheKey = `mana:${colorLetter}`;
	const cached = this.setIconCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const inFlight = this.manaSymbolInFlight.get(cacheKey);
	if (inFlight) return inFlight;

	const promise = this.fetchManaSymbolSvg(colorLetter, cacheKey);
	this.manaSymbolInFlight.set(cacheKey, promise);
	void promise.finally(() => this.manaSymbolInFlight.delete(cacheKey));
	return promise;
}


export async function fetchManaSymbolSvg(this: MTGCollectionPlugin, colorLetter: string, cacheKey: string): Promise<string | null> {
	try {
		const symbology = await this.loadSymbology();
		const uri = symbology.get(`{${colorLetter}}`);
		if (!uri) {
			// Lettre qui ne correspond à aucun symbole Scryfall connu : pas
			// une histoire de réseau, pas la peine de réessayer.
			this.setIconCache.set(cacheKey, null);
			this.scheduleMapCachePersist(ICON_CACHE_FILENAME, this.setIconCache);
			return null;
		}
		const svgRes = await requestScryfall({ url: uri, headers: SCRYFALL_HEADERS, throw: false });
		if (svgRes.status !== 200) {
			return null;
		}
		const svg = sanitizeSvg(svgRes.text);
		this.setIconCache.set(cacheKey, svg);
		this.scheduleMapCachePersist(ICON_CACHE_FILENAME, this.setIconCache);
		return svg;
	} catch {
		return null;
	}
}

// Certaines éditions (Alpha, Beta...) n'ont existé qu'en anglais. On
// interroge Scryfall pour ne proposer, dans le sélecteur de langue, que
// les langues réellement imprimées pour cette édition + numéro donnés.

export async function getAvailableLanguages(this: MTGCollectionPlugin, setCode: string, collectorNumber: string): Promise<string[]> {
	const cacheKey = `${setCode.toLowerCase()}:${collectorNumber}`;
	const cached = this.printLanguagesCache.get(cacheKey);
	if (cached) return cached;

	try {
		const query = encodeURIComponent(
			`set:${setCode.toLowerCase()} cn:${collectorNumber} lang:any`
		);
		const res = await requestScryfall({
			url: `https://api.scryfall.com/cards/search?q=${query}&unique=prints`,
			headers: SCRYFALL_HEADERS,
			throw: false,
		});
		if (res.status !== 200) {
			// Échec HTTP — pas forcément transitoire (ex. 404 pour une
			// combinaison set/numéro invalide) mais pas non plus une réponse
			// Scryfall confirmée. Bug trouvé en ajoutant la persistance sur
			// disque de ce cache : cette branche mettait ["en"] en cache
			// jusqu'ici, ce qui — en mémoire, le temps d'une session — était
			// déjà discutable (une panne réseau ponctuelle pouvait figer
			// ["en"] pour le reste de la session), mais serait devenu bien
			// pire une fois persisté (une panne ponctuelle aurait figé
			// ["en"] pour cette impression dans TOUTES les sessions futures).
			// Corrigé : ne met plus rien en cache ici, seul un 200 confirmé
			// (même avec un résultat vide, voir plus bas) est mémorisé.
			return ["en"];
		}
		const langs = Array.from(
			new Set((res.json.data as { lang: string }[]).map((c) => c.lang))
		);
		const result = langs.length > 0 ? langs : ["en"];
		this.printLanguagesCache.set(cacheKey, result);
		this.scheduleMapCachePersist(
			PRINT_LANGUAGES_CACHE_FILENAME,
			this.printLanguagesCache
		);
		return result;
	} catch {
		// Échec réseau/parsing — transitoire par nature, jamais mis en
		// cache (même règle que getSetIconSvg/getCardLegalities ailleurs
		// dans ce fichier, et même raisonnement que la branche ci-dessus).
		return ["en"];
	}
}


/* --------------------------- Bulk actions ------------------------------ */


export async function loadPersistedMapCache<T>(this: MTGCollectionPlugin, 
	filename: string,
	map: Map<string, T>,
	isValid: (value: unknown) => boolean
): Promise<void> {
	const path = this.immutableCacheFilePath(filename);
	if (!path) return;
	try {
		if (!(await this.app.vault.adapter.exists(path))) return;
		const raw = await this.app.vault.adapter.read(path);
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		for (const [key, value] of Object.entries(parsed)) {
			if (!isValid(value)) continue;
			map.set(key, value as T);
		}
	} catch {
		// Silencieux par design — voir le commentaire de la méthode.
	}
}

// Écriture différée (regroupe les résolutions rapprochées d'un rendu
// initial en une seule écriture, même idiome que scheduleLegalitiesPersist)
// — map est déjà exactement la forme qu'on veut écrire (clé -> valeur),
// pas besoin d'un wrapper {valeur, horodatage} par entrée comme pour les
// légalités, qui ont un TTL à faire respecter.
