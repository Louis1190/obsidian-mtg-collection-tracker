import {
	CollectionCard,
} from "../core/card-model";
import {
	getArtCropUrl,
	fetchScryfallCollection,
	buildCardTextInfo,
} from "../api/scryfall";
import {
	CollectionList,
	DeckCard,
	genId,
	VIEW_TYPE_MTG_COLLECTION,
} from "../core/data-model";
import { MTGCollectionView } from "../view";
import type MTGCollectionPlugin from "../plugin";

// Des lignes telles qu'une version ANTÉRIEURE du plugin les a écrites : les champs qu'une migration ajoute ou convertit
// peuvent manquer (d'où Partial), et certains n'existent plus dans les types actuels (foilCount, foil, category "commander").
// Plutôt que `any` : une faute de frappe sur un nom de champ reste une erreur de compilation.
type LegacyCard = Partial<CollectionCard> & { foilCount?: number; foil?: boolean };
type LegacyDeckCard = Partial<Omit<DeckCard, "category">> & { category?: DeckCard["category"] | "commander" };

/* -------------------------------------------------------------------------- */
/*  One-shot data migrations/backfills, run once via runSettingsMigrations()
    (plugin.ts) or onload() -- rarely touched outside adding a new one.
    Split out of plugin.ts on 2026-09-10.  */
/* -------------------------------------------------------------------------- */

export function migrateListDateCreated(this: MTGCollectionPlugin) {
	let changed = false;
	this.settings.lists.forEach((list, i) => {
		if (list.dateCreated === undefined) {
			list.dateCreated = Date.now() - (this.settings.lists.length - i) * 1000;
			changed = true;
		}
	});
	if (changed) void this.saveSettings();
}

// Même principe que migrateListDateCreated, pour les decks.

export function migrateDeckDateCreated(this: MTGCollectionPlugin) {
	let changed = false;
	this.settings.decks.forEach((deck, i) => {
		if (deck.dateCreated === undefined) {
			deck.dateCreated = Date.now() - (this.settings.decks.length - i) * 1000;
			changed = true;
		}
	});
	if (changed) void this.saveSettings();
}

// saveSettings() est appelée à chaque petite interaction (incrémenter une
// quantité, cocher foil...) — sur une grosse collection, réécrire tout le
// JSON sur disque à chaque clic peut devenir sensible. On regroupe donc
// les appels rapprochés en une seule écriture différée de courte durée ;
// flushPendingSave() garantit qu'un appel isolé (ou la fermeture du
// plugin) n'attend jamais indéfiniment.

// Incrémenté à chaque appel de saveSettings() (donc à chaque mutation,
// indépendamment du debounce de l'écriture sur disque elle-même) : sert
// de repère pour MTGCollectionView, qui met en cache le résultat du
// tri/groupement d'une liste (coûteux sur une grosse collection) et doit
// savoir quand l'invalider — un changement de ce compteur signifie "les
// données ont bougé depuis le dernier calcul", indépendamment d'un
// changement de filtre/tri/groupement.

// Ids de CollectionCard ajoutés cette session via addCardToCollection/importCsv
// (voir ces méthodes) — jamais persisté (comme legalitiesCache plus haut),
// donc se vide naturellement à chaque redémarrage d'Obsidian. Un Set
// (pas une Map par liste) suffit : chaque CollectionCard porte déjà son propre
// listId, donc le filtrage "par liste" se fait pour gratuitement partout
// où on affiche déjà une liste précise. L'ordre d'insertion d'un Set JS
// est garanti stable, ce qui sert à trier le groupe épinglé "Recently
// Added" du plus récent au plus ancien sans avoir besoin d'un timestamp
// séparé. Volontairement PAS mis à jour par copyCollectionCardToList/moveCollectionCardToList/
// copyWantlistCardToList/moveWantlistCardToCollectionNoSave/copyList —
// ces méthodes déplacent ou dupliquent des cartes déjà existantes dans
// la collection, ce n'est pas un ajout "neuf" au sens de cette
// fonctionnalité.

// Même principe que recentlyAddedCollectionCardIds ci-dessus, côté wantlist :
// alimenté uniquement par addCardToWantlist/importWantlistCsv, jamais par
// copyWantlistCardToList/moveWantlistCardToCollectionNoSave (déplacement/
// duplication, pas un ajout neuf).


export function migrateFoilSplit(this: MTGCollectionPlugin) {
	const needsMigration = this.settings.collection.some(
		(c) => (c as LegacyCard).foilCount !== undefined || !c.id
	);
	if (!needsMigration) return;

	const migrated: CollectionCard[] = [];
	(this.settings.collection as LegacyCard[]).forEach((c) => {
		const now = Date.now();
		const base = {
			scryfallId: c.scryfallId,
			name: c.name,
			setCode: c.setCode,
			setName: c.setName,
			collectorNumber: c.collectorNumber,
			rarity: c.rarity,
			manaCost: c.manaCost,
			manaValue: c.manaValue ?? 0,
			typeLine: c.typeLine,
			artist: c.artist ?? "",
			colors: c.colors ?? [],
			keywords: c.keywords ?? [],
			releasedAt: c.releasedAt ?? "",
			imageUrl: c.imageUrl,
			artCropUrl: c.artCropUrl ?? c.imageUrl ?? "",
			priceUsd: c.priceUsd,
			priceUsdFoil: c.priceUsdFoil ?? "",
			priceEur: c.priceEur ?? "",
			priceEurFoil: c.priceEurFoil ?? "",
			priceUsdEtched: c.priceUsdEtched ?? "",
			priceEurEtched: c.priceEurEtched ?? "",
			listId: c.listId,
			language: c.language ?? "en",
			condition: c.condition ?? "",
			dateAdded: c.dateAdded ?? now,
			dateModified: c.dateModified ?? now,
			borderColor: c.borderColor,
			frame: c.frame,
			frameEffects: c.frameEffects,
			oracleText: c.oracleText,
		};
		if (c.foilCount !== undefined) {
			if ((c.count ?? 0) > 0 || c.foilCount === 0) {
				migrated.push({ ...base, id: genId(), count: c.count ?? 0, finish: "regular" } as CollectionCard);
			}
			if (c.foilCount > 0) {
				migrated.push({ ...base, id: genId(), count: c.foilCount, finish: "foiled" } as CollectionCard);
			}
		} else {
			migrated.push({
				...base,
				id: c.id ?? genId(),
				count: c.count ?? 0,
				finish: c.finish ?? (c.foil ? "foiled" : "regular"),
			} as CollectionCard);
		}
	});
	this.settings.collection = migrated;
	void this.saveSettings();
}

// "foil" (booléen) devient "finish" (Regular/Foiled/Etched/Proxy) : Etched
// et Proxy sont de nouvelles valeurs qu'aucune carte existante ne peut déjà
// avoir, donc la conversion est une simple bascule foil ? "foiled" :
// "regular". S'applique à la collection ET à la wantlist (même champ dans
// Garantit qu'exactement une liste "Inbox" (isInbox: true, voir
// CollectionList) existe toujours — appelée depuis runSettingsMigrations,
// donc aussi bien au chargement normal qu'après une restauration de
// sauvegarde (un fichier de sauvegarde plus ancien n'a jamais ce flag,
// tout comme une toute première installation). No-op dès qu'une liste le
// porte déjà, qu'importe laquelle — ce flag n'est posé nulle part
// ailleurs dans le code, donc une fois créée elle ne peut être dupliquée
// que par une modification manuelle de data.json, non gérée ici.
// unshift (pas push) : purement cosmétique, place la liste en tête du
// tableau brut — le vrai épinglage visuel vient de renderListGrid, qui
// l'extrait et l'affiche séparément, indépendamment de sa position ici.

export function ensureInboxList(this: MTGCollectionPlugin) {
	if (this.settings.lists.some((l) => l.isInbox)) return;
	this.settings.lists.unshift({
		id: genId(),
		name: "Inbox",
		dateCreated: Date.now(),
		isInbox: true,
	});
}

// les deux, migrateFoilSplit ne traite que la collection).

export function migrateFoilToFinish(this: MTGCollectionPlugin) {
	let changed = false;
	const convert = (c: LegacyCard) => {
		if (c.finish !== undefined) return;
		c.finish = c.foil ? "foiled" : "regular";
		delete c.foil;
		if (c.priceUsdEtched === undefined) c.priceUsdEtched = "";
		if (c.priceEurEtched === undefined) c.priceEurEtched = "";
		changed = true;
	};
	(this.settings.collection as LegacyCard[]).forEach(convert);
	(this.settings.wantlist as LegacyCard[]).forEach(convert);
	if (changed) void this.saveSettings();
}


export function migrateDamagedCondition(this: MTGCollectionPlugin) {
	let changed = false;
	this.settings.collection.forEach((c) => {
		if (c.condition === "DMG") {
			c.condition = "PO";
			changed = true;
		}
	});
	if (changed) void this.saveSettings();
}


export function migrateDeckCommanderCategory(this: MTGCollectionPlugin) {
	let changed = false;
	this.settings.decks.forEach((deck) => {
		(deck.cards as LegacyDeckCard[]).forEach((c) => {
			if (c.category === "commander") {
				c.category = undefined;
				c.deckFunctionOverride = "Commander";
				changed = true;
			}
		});
	});
	if (changed) void this.saveSettings();
}

// Rattrapage ponctuel de borderColor/frame/frameEffects (filtre "border:",
// card-search.ts) pour toute entrée créée avant cette fonctionnalité —
// contrairement à legalitiesCache/bulkFetchLegalities (voir leur
// commentaire dans src/plugin/scryfall-cache.ts), cette donnée n'est PAS un cache à part avec TTL :
// elle est persistée directement sur chaque CollectionCard/WantlistCard/
// DeckCard (voir leur commentaire dans types.ts/data-model.ts), parce
// qu'une bordure/un cadre de carte imprimée ne change jamais — une fois
// rattrapée pour un scryfallId donné, plus jamais besoin de la
// redemander. Une nouvelle carte l'obtient déjà directement à l'ajout
// (addCardToCollection, addCardToWantlist, addCardToDeck,
// changeCollectionCardPrinting/changeWantlistCardPrinting, importCsv/
// importWantlistCsv) — cette méthode ne rattrape donc que les entrées
// plus anciennes, ou importées depuis un data.json antérieur à cette
// fonctionnalité. Appelée une fois au démarrage (voir onload), SANS
// intervalle horaire contrairement à maybeAutoRefreshLegalities : une
// fois toute la collection couverte, targets ci-dessous est
// systématiquement vide et l'appel devient un no-op immédiat pour le
// reste de la vie du plugin — pas besoin de revérifier périodiquement
// une donnée qui ne périme jamais.

export async function backfillBorderData(this: MTGCollectionPlugin): Promise<void> {
	// scryfallId → TOUTES les entrées qui le partagent (pas une seule) :
	// une même impression peut apparaître plusieurs fois à la fois (deux
	// lignes de collection en états différents, un deck ET la collection,
	// etc.), et chacune doit recevoir la donnée une fois son lot résolu.
	const targets = new Map<string, { borderColor?: string; frame?: string; frameEffects?: string[] }[]>();
	const register = (id: string, entry: { borderColor?: string; frame?: string; frameEffects?: string[] }) => {
		if (!id || entry.borderColor !== undefined) return;
		const list = targets.get(id);
		if (list) list.push(entry);
		else targets.set(id, [entry]);
	};
	this.settings.collection.forEach((c) => register(c.scryfallId, c));
	this.settings.wantlist.forEach((c) => register(c.scryfallId, c));
	this.settings.decks.forEach((d) => d.cards.forEach((c) => register(c.scryfallId, c)));

	const missingIds = Array.from(targets.keys());
	if (missingIds.length === 0) return;

	// Même mécanisme onChunkResolved que bulkFetchLegalities (voir
	// src/plugin/scryfall-cache.ts) — résout chaque lot de 75 dès qu'il revient, pas seulement le
	// tout dernier. Moins critique ici qu'une réponse "instantanée" au
	// clavier puisque rien n'attend cette donnée en synchrone, mais
	// applique quand même les résultats progressivement plutôt que
	// d'attendre la toute fin d'une collection de 10k cartes avant le
	// premier octet écrit.
	let changed = false;
	await fetchScryfallCollection(missingIds, undefined, (chunkResults) => {
		chunkResults.forEach((card, id) => {
			const entries = targets.get(id);
			if (!entries) return;
			entries.forEach((entry) => {
				entry.borderColor = card.border_color ?? "";
				entry.frame = card.frame ?? "";
				entry.frameEffects = card.frame_effects ?? [];
			});
			changed = true;
		});
	});

	if (!changed) return;
	void this.saveSettings();
	// Même geste que maybeAutoRefreshLegalities/maybeAutoRefreshPrices :
	// une vue déjà ouverte (restaurée par Obsidian au démarrage) doit
	// refléter la donnée fraîchement rattrapée.
	this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
		if (leaf.view instanceof MTGCollectionView) leaf.view.render();
	});
}

// Rattrapage ponctuel d'oracleText (filtre "oracle:", card-search.ts),
// même conception que backfillBorderData juste au-dessus — donnée
// intrinsèque IMMUABLE (le texte de règles d'une impression ne change
// jamais, sauf erratum), donc un simple rattrapage une fois suffit,
// pas de TTL comme les légalités. Fonction séparée plutôt que fusionnée
// dans backfillBorderData : une entrée déjà rattrapée par une version
// antérieure du plugin (avant l'ajout de ce champ) a déjà borderColor
// !== undefined, donc ne serait jamais réenregistrée si le filtre
// "manquant" de cette fonction réutilisait le même test — chaque champ
// immuable ajouté après coup a besoin de son propre passage. Une
// nouvelle carte l'obtient déjà directement à l'ajout (mêmes 14 sites
// que borderColor/frame/frameEffects — voir leur propre commentaire) ;
// cette méthode ne rattrape donc que les entrées plus anciennes.

export async function backfillOracleTextData(this: MTGCollectionPlugin): Promise<void> {
	const targets = new Map<string, { oracleText?: string }[]>();
	const register = (id: string, entry: { oracleText?: string }) => {
		if (!id || entry.oracleText !== undefined) return;
		const list = targets.get(id);
		if (list) list.push(entry);
		else targets.set(id, [entry]);
	};
	this.settings.collection.forEach((c) => register(c.scryfallId, c));
	this.settings.wantlist.forEach((c) => register(c.scryfallId, c));
	this.settings.decks.forEach((d) => d.cards.forEach((c) => register(c.scryfallId, c)));

	const missingIds = Array.from(targets.keys());
	if (missingIds.length === 0) return;

	// Même mécanisme onChunkResolved que backfillBorderData ci-dessus/
	// bulkFetchLegalities (src/plugin/scryfall-cache.ts).
	let changed = false;
	await fetchScryfallCollection(missingIds, undefined, (chunkResults) => {
		chunkResults.forEach((card, id) => {
			const entries = targets.get(id);
			if (!entries) return;
			const oracleText = buildCardTextInfo(card).oracleText;
			entries.forEach((entry) => {
				entry.oracleText = oracleText;
			});
			changed = true;
		});
	});

	if (!changed) return;
	void this.saveSettings();
	this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
		if (leaf.view instanceof MTGCollectionView) leaf.view.render();
	});
}

// Rattrapage ponctuel du prix (voir DeckCard.priceUsd/etc., data-model.ts)
// pour les decks créés avant cette fonctionnalité — scopé aux decks
// SEULEMENT, contrairement à backfillBorderData/backfillOracleTextData
// juste au-dessus : une CollectionCard/WantlistCard a toujours ce prix
// dès sa création (champ non-optionnel, jamais absent), seul DeckCard en
// a besoin. Même mécanisme onChunkResolved que ses deux voisins — mais
// contrairement à eux, le prix N'EST PAS immuable : ce rattrapage ne
// couvre que "jamais encore rattrapé une seule fois" (comme border/
// oracleText), la fraîcheur continue est assurée séparément par
// refreshAllPrices/maybeAutoRefreshPrices (qui incluent déjà les decks,
// voir leur propre commentaire) — un deck déjà rattrapé une fois ne
// repasse jamais par ici, mais reste tenu à jour par ce mécanisme-là.

export async function backfillDeckCardPrices(this: MTGCollectionPlugin): Promise<void> {
	interface PriceTarget {
		priceUsd?: string;
		priceUsdFoil?: string;
		priceEur?: string;
		priceEurFoil?: string;
		priceUsdEtched?: string;
		priceEurEtched?: string;
	}
	const targets = new Map<string, PriceTarget[]>();
	const register = (id: string, entry: PriceTarget) => {
		if (!id || entry.priceUsd !== undefined) return;
		const list = targets.get(id);
		if (list) list.push(entry);
		else targets.set(id, [entry]);
	};
	this.settings.decks.forEach((d) => d.cards.forEach((c) => register(c.scryfallId, c)));

	const missingIds = Array.from(targets.keys());
	if (missingIds.length === 0) return;

	let changed = false;
	await fetchScryfallCollection(missingIds, undefined, (chunkResults) => {
		chunkResults.forEach((card, id) => {
			const entries = targets.get(id);
			if (!entries) return;
			entries.forEach((entry) => {
				entry.priceUsd = card.prices?.usd ?? "";
				entry.priceUsdFoil = card.prices?.usd_foil ?? "";
				entry.priceEur = card.prices?.eur ?? "";
				entry.priceEurFoil = card.prices?.eur_foil ?? "";
				entry.priceUsdEtched = card.prices?.usd_etched ?? "";
				entry.priceEurEtched = card.prices?.eur_etched ?? "";
			});
			changed = true;
		});
	});

	if (!changed) return;
	void this.saveSettings();
	this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
		if (leaf.view instanceof MTGCollectionView) leaf.view.render();
	});
}

// Anciennes versions du plugin regroupaient automatiquement par édition.
// On convertit une fois pour toutes ces regroupements en vraies "Lists"
// nommées d'après l'édition, pour que les données existantes restent visibles.

export function migrateCollectionToLists(this: MTGCollectionPlugin) {
	const orphans = this.settings.collection.filter((c) => !c.listId);
	if (orphans.length === 0) return;

	const bySet = new Map<string, CollectionList>();
	orphans.forEach((card) => {
		let list = bySet.get(card.setCode);
		if (!list) {
			list =
				this.settings.lists.find((l) => l.name === card.setName) ??
				this.createListSilent(card.setName || card.setCode || "Unsorted");
			bySet.set(card.setCode, list);
		}
		card.listId = list.id;
	});
	void this.saveSettings();
}


export async function migrateEnrichMetadata(this: MTGCollectionPlugin) {
	const missing = this.settings.collection.filter((c) => !c.artist && c.scryfallId);
	if (missing.length === 0) return;

	const uniqueIds = Array.from(new Set(missing.map((c) => c.scryfallId)));
	const enrichMap = await fetchScryfallCollection(uniqueIds);
	if (enrichMap.size === 0) return;

	missing.forEach((card) => {
		const scry = enrichMap.get(card.scryfallId);
		if (!scry) return;
		card.artist = scry.artist ?? "";
		card.colors = scry.colors ?? [];
		card.manaValue = scry.cmc ?? 0;
		card.releasedAt = scry.released_at ?? "";
	});
	await this.saveSettings();
}

// Récupère la vraie illustration seule (art_crop) et les capacités-clés
// (keywords) pour les cartes qui n'en ont pas encore (créées avant
// l'introduction de ces champs).

export async function migrateArtCropUrls(this: MTGCollectionPlugin) {
	const missing = this.settings.collection.filter(
		(c) =>
			c.scryfallId &&
			(!c.artCropUrl ||
				c.artCropUrl === c.imageUrl ||
				c.keywords === undefined ||
				c.priceUsdFoil === undefined)
	);
	if (missing.length === 0) return;

	const uniqueIds = Array.from(new Set(missing.map((c) => c.scryfallId)));
	const enrichMap = await fetchScryfallCollection(uniqueIds);
	if (enrichMap.size === 0) return;

	missing.forEach((card) => {
		const scry = enrichMap.get(card.scryfallId);
		if (!scry) return;
		card.artCropUrl = getArtCropUrl(scry);
		card.keywords = scry.keywords ?? [];
		card.priceUsdFoil = scry.prices?.usd_foil ?? "";
		card.priceEur = scry.prices?.eur ?? "";
		card.priceEurFoil = scry.prices?.eur_foil ?? "";
		card.priceUsdEtched = scry.prices?.usd_etched ?? "";
		card.priceEurEtched = scry.prices?.eur_etched ?? "";
	});
	await this.saveSettings();
}

// Complète les cartes de deck créées avant l'introduction du tri/groupement
// avec des valeurs par défaut sûres (avant l'enrichissement via Scryfall).

export function migrateDeckCardDefaults(this: MTGCollectionPlugin) {
	let changed = false;
	const now = Date.now();
	this.settings.decks.forEach((deck) => {
		(deck.cards as LegacyDeckCard[]).forEach((c) => {
			if (c.dateAdded === undefined) {
				c.dateAdded = now;
				changed = true;
			}
			if (c.dateModified === undefined) {
				c.dateModified = now;
				changed = true;
			}
			if (c.manaValue === undefined) {
				c.manaValue = 0;
				changed = true;
			}
			if (c.artist === undefined) {
				c.artist = "";
				changed = true;
			}
			if (c.colors === undefined) {
				c.colors = [];
				changed = true;
			}
			if (c.setName === undefined) {
				c.setName = "";
				changed = true;
			}
			if (c.artCropUrl === undefined) {
				c.artCropUrl = c.imageUrl ?? "";
				changed = true;
			}
			if (c.keywords === undefined) {
				c.keywords = [];
				changed = true;
			}
		});
	});
	if (changed) void this.saveSettings();
}

// Récupère l'artiste, les couleurs, la valeur de mana, l'illustration seule
// et les capacités-clés manquants pour les cartes de deck existantes, en
// une poignée de requêtes groupées.

export async function migrateEnrichDeckMetadata(this: MTGCollectionPlugin) {
	const allDeckCards = this.settings.decks.flatMap((d) => d.cards);
	const missing = allDeckCards.filter(
		(c) =>
			c.scryfallId &&
			(!c.artist ||
				!c.artCropUrl ||
				c.artCropUrl === c.imageUrl ||
				c.keywords === undefined)
	);
	if (missing.length === 0) return;

	const uniqueIds = Array.from(new Set(missing.map((c) => c.scryfallId)));
	const enrichMap = await fetchScryfallCollection(uniqueIds);
	if (enrichMap.size === 0) return;

	missing.forEach((card) => {
		const scry = enrichMap.get(card.scryfallId);
		if (!scry) return;
		card.artist = scry.artist ?? "";
		card.colors = scry.colors ?? [];
		card.manaValue = scry.cmc ?? 0;
		card.artCropUrl = getArtCropUrl(scry);
		card.keywords = scry.keywords ?? [];
		if (!card.setName) card.setName = scry.set_name ?? "";
	});
	await this.saveSettings();
}

