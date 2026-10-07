import { addIcon, Plugin } from "obsidian";
import { ONE_COLUMN_ICON_SVG } from "./ui/brand-assets";
import {
	ScryfallSetSummary,
	sanitizeSvg,
	ScryfallImmutableSnapshot,
} from "./api/scryfall";
import type { EntityPrints, KeySnapshot } from "./core/settings-merge";
import { CardKingdomPriceEntry } from "./api/card-kingdom";
import { ManaPoolCardPrices } from "./api/manapool";
import {
	CardbasePriceHistory,
	CardmarketNativePrices,
	CardbaseMoversResult,
} from "./api/cardbase";
import { UsdEurRate } from "./api/frankfurter";
import {
	MTGCollectionSettings,
	DEFAULT_SETTINGS,
	VIEW_TYPE_MTG_COLLECTION,
} from "./core/data-model";
import { MTGCollectionSettingTab } from "./setting-tab";
import { MTGCollectionView } from "./view";
import { HIDE_BARS_CLASS } from "./view/mobile-bars";
import * as scryfallCache from "./plugin/scryfall-cache";
import * as storePrices from "./plugin/store-prices";
import * as cardbaseCache from "./plugin/cardbase-cache";
import * as exchangeRate from "./plugin/exchange-rate";
import * as priceRefresh from "./plugin/price-refresh";
import * as lifecycle from "./plugin/lifecycle";
import * as backup from "./plugin/backup";
import * as settingsSync from "./plugin/settings-sync";
import * as githubSync from "./plugin/github-sync";
import * as migrations from "./plugin/migrations";
import * as collectionMutations from "./plugin/collection-mutations";
import * as wantlistMutations from "./plugin/wantlist-mutations";
import * as deckMutations from "./plugin/deck-mutations";
import * as importExport from "./plugin/import-export";
import { setSvgMarkup } from "./ui/svg-markup";


/* -------------------------------------------------------------------------- */
/*  Persistence validators, passed as arguments to loadPersistedMapCache      */
/*  (src/plugin/scryfall-cache.ts, since Phase 5's split on 2026-09-10)       */
/* -------------------------------------------------------------------------- */

// Une entrée mal formée (fichier corrompu, format d'une version antérieure
// du plugin qui n'écrivait pas encore ce champ...) doit être ignorée en
// silence à la lecture, jamais planter tout le chargement du cache — chacun
// de ces validateurs décrit juste "est-ce la forme attendue", pas un
// prédicat de type TypeScript (loadPersistedMapCache caste après coup, voir
// son propre commentaire) : évite de se battre avec l'exactitude stricte
// des prédicats de type génériques pour un simple filtre au moment de lire
// un fichier JSON.
function isStringOrNull(v: unknown): boolean {
	return v === null || typeof v === "string";
}
function isNumberOrNull(v: unknown): boolean {
	return v === null || typeof v === "number";
}
function isObjectOrNull(v: unknown): boolean {
	return v === null || (typeof v === "object" && !Array.isArray(v));
}
function isStringArray(v: unknown): boolean {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/* -------------------------------------------------------------------------- */
/*  Plugin main class                                                         */
/* -------------------------------------------------------------------------- */

export default class MTGCollectionPlugin extends Plugin {
	settings: MTGCollectionSettings = DEFAULT_SETTINGS;
	collectionRibbonIconEl: HTMLElement | null = null;
	setIconCache: Map<string, string | null> = new Map();
	// Persisté sur disque (voir allSetsCacheFilePath/loadPersistedAllSetsCache/
	// persistAllSetsCache dans src/plugin/scryfall-cache.ts), CONTRAIREMENT aux caches "immuables" à
	// droite de ce commentaire — Scryfall ajoute régulièrement de nouvelles
	// éditions (plusieurs fois par mois), donc cette liste a besoin d'un vrai
	// TTL (ALL_SETS_CACHE_TTL_MS) plutôt que d'être persistée pour toujours
	// comme setIconCache/scryfallImmutableCache/etc. — mécanisme séparé, pas le
	// même que loadPersistedMapCache (générique, sans notion de péremption).
	allSetsCache: ScryfallSetSummary[] | null = null;
	symbologyCache: Map<string, string> | null = null;
	symbologyFetchPromise: Promise<Map<string, string>> | null = null;
	// Persisté sur disque (voir loadPersistedMapCache/scheduleMapCachePersist
	// dans src/plugin/scryfall-cache.ts) — même raisonnement que setIconCache ci-dessus, les langues
	// réellement imprimées pour une impression donnée ne changent pas une
	// fois cette impression sortie.
	printLanguagesCache: Map<string, string[]> = new Map();
	// Requêtes de symboles (set/mana) déjà en vol, indexées par clé de cache :
	// évite que plusieurs lignes affichant le même set/symbole en même temps
	// (rendu initial d'une longue liste, par ex.) ne déclenchent chacune leur
	// propre requête réseau en parallèle pour exactement la même donnée.
	setIconInFlight: Map<string, Promise<string | null>> = new Map();
	setIconFetchQueue: Promise<void> = Promise.resolve();
	manaSymbolInFlight: Map<string, Promise<string | null>> = new Map();
	// Légalités par carte (bloc "Legal Formats" du détail + filtre "legal:"
	// de My Collection, voir card-search.ts) : cache mémoire, alimenté au
	// démarrage depuis un fichier séparé persisté sur disque (voir
	// legalitiesCacheFilePath/loadPersistedLegalitiesCache/
	// scheduleLegalitiesPersist dans src/plugin/scryfall-cache.ts) — PAS dans settings.json/data.json
	// comme le reste du plugin. Deux raisons : (1) c'est un objet volumineux
	// (23 clés par carte désormais, potentiellement plusieurs Mo pour 10k
	// cartes) que saveSettings() réécrirait en entier à CHAQUE mutation non
	// liée (incrémenter une quantité, changer une couleur d'accent…), un
	// vrai coût de perf pour une donnée qui change, elle, très rarement ;
	// (2) contrairement au reste des settings, cette donnée devient
	// obsolète avec le temps réel qui passe (rotations, bannissements), pas
	// avec une action de l'utilisateur — un TTL (legalitiesFetchedAt +
	// LEGALITIES_CACHE_TTL_MS, src/plugin/scryfall-cache.ts) a plus de sens porté par son propre
	// mécanisme que mêlé au blob de settings, qui n'a aucune notion de
	// péremption. On ne met en cache (et ne persiste) qu'un résultat obtenu
	// avec succès (jamais un échec transitoire), même logique que
	// setIconCache/setIconInFlight.
	legalitiesCache: Map<string, Record<string, string>> = new Map();
	legalitiesInFlight: Map<string, Promise<Record<string, string> | null>> = new Map();
	// Horodatage (Date.now()) du dernier fetch RÉUSSI par id — distinct de
	// legalitiesCache elle-même : la valeur affichée reste celle en cache
	// même une fois expirée (une légalité vieille d'une semaine reste très
	// probablement correcte, mieux vaut l'afficher tout de suite qu'un état
	// "chargement" pour re-vérifier une donnée presque sûrement encore
	// bonne) — seule la décision de RE-fetcher (isLegalitiesFresh,
	// bulkFetchLegalities) consulte cette Map, jamais l'affichage.
	legalitiesFetchedAt: Map<string, number> = new Map();
	// Même idiome de regroupement que pendingSaveTimer plus bas (champ) /
	// SAVE_DEBOUNCE_MS (src/plugin/lifecycle.ts) pour saveSettings(), mais sur un délai plus long : un pré-fetch complet
	// de la collection (voir maybeAutoRefreshLegalities) résout un par un
	// beaucoup d'ids sur plusieurs secondes — écrire sur disque à chaque
	// résolution individuelle serait bien plus d'écritures que nécessaire
	// pour une donnée qui n'a pas besoin d'être persistée à la milliseconde
	// près.
	legalitiesPersistTimer: number | null = null;
	// Même idiome que legalitiesPersistTimer ci-dessus / LEGALITIES_PERSIST_DEBOUNCE_MS
	// (src/plugin/scryfall-cache.ts), pour setIconCache (voir son propre commentaire plus haut) —
	// un fichier séparé plutôt qu'une même écriture groupée avec les
	// légalités : chaque cache de ce plugin possède son propre aller-retour
	// de persistance de bout en bout (même raisonnement déjà établi pour
	// scryfallImmutableCache plus bas).
	// Lien produit TCGplayer, texte de règles + stats ("Card Text"), images
	// recto/verso (bouton "flip") et info split (bouton "rotate") — 4
	// fonctionnalités qui, jusqu'à cette fusion (revue du 2026-08-18),
	// avaient chacune leur PROPRE cache + fetch de bout en bout (choix
	// délibéré, documenté à l'époque pour tcgplayerUrlCache : "chaque cache
	// possède son propre aller-retour, pas de promesse partagée entre
	// concepts indépendants"). Ce découplage tenait pour 1-2 caches, mais à 4
	// il avait un coût réel et mesuré : ouvrir une carte jamais vue cette
	// session tirait 4 requêtes /cards/collection quasi simultanées pour le
	// MÊME scryfallId, chacune redemandant en réalité le même objet
	// ScryfallCard déjà récupéré par les 3 autres. Les 4 caches sont donc
	// fusionnés en un seul, `scryfallImmutableCache` (voir aussi getScryfall
	// ImmutableSnapshot dans src/plugin/scryfall-cache.ts) — un seul fetch par carte, dont les 4
	// méthodes publiques (getTcgplayerUrl/getCardTextInfo/getCardFaceImages/
	// getSplitCardInfo, signatures ET comportement inchangés pour leurs
	// appelants) dérivent leur résultat synchronement. legalitiesCache reste
	// volontairement à part (voir plus haut) : seul cache de ce groupe à
	// avoir un vrai TTL, le fusionner aurait ajouté de la complexité
	// ("immuable" + "périssable" dans un seul mécanisme) pour un bénéfice
	// marginal — son propre pré-chauffage en arrière-plan le garde déjà
	// quasiment toujours chaud au moment où une fiche s'ouvre. `null` est
	// une réponse valide et mise en cache (carte trouvée mais confirmée sans
	// verso/sans lien TCGplayer/etc. — un vrai résultat, pas un échec) ;
	// seul un échec confirmé après retentative n'est pas mis en cache.
	// ScryfallImmutableSnapshot (scryfall.ts) exclut délibérément prices/
	// legalities — voir son propre commentaire pour pourquoi.
	scryfallImmutableCache: Map<string, ScryfallImmutableSnapshot | null> = new Map();
	scryfallImmutableInFlight: Map<string, Promise<ScryfallImmutableSnapshot | null>> = new Map();
	// Tarif Card Kingdom (bloc "Store Prices" du détail) : même raisonnement
	// que symbologyCache — un seul fichier pour tout le catalogue, jamais
	// persisté (encore plus vrai ici : ~67 Mo, bien trop volumineux pour
	// settings.json).
	cardKingdomPricesCache: Map<string, CardKingdomPriceEntry> | null = null;
	cardKingdomPricesFetchPromise: Promise<Map<string, CardKingdomPriceEntry>> | null = null;
	// Tarif Mana Pool (3ᵉ ligne "Store Prices") : même raisonnement que
	// cardKingdomPricesCache ci-dessus — un seul fichier pour tout le
	// catalogue (~50 Mo), jamais persisté.
	manaPoolPricesCache: Map<string, ManaPoolCardPrices> | null = null;
	manaPoolPricesFetchPromise: Promise<Map<string, ManaPoolCardPrices>> | null = null;
	// Historique de prix cardbase.dev (boîte "Price History", sous Store
	// Prices) : point d'accès par impression, pas un fichier catalogue
	// complet — donc même forme per-ID que legalitiesCache/scryfallImmutableCache
	// ci-dessus, pas la forme "tout le dataset" de Card Kingdom/Mana Pool.
	// Clé composite scryfallId:finish (une même carte peut être consultée
	// sous plusieurs finitions selon la section — Collection/Wantlist/Deck).
	// Un résultat "succès confirmé" (même une série vide — carte réellement
	// sans historique chez ces deux magasins) est mis en cache ; seul un
	// échec réseau/HTTP ne l'est pas, voir fetchCardbasePriceHistory.
	cardbasePriceHistoryCache: Map<string, CardbasePriceHistory | undefined> = new Map();
	cardbasePriceHistoryInFlight: Map<string, Promise<CardbasePriceHistory | undefined>> = new Map();
	// cardmarket_id (GET /printings/{scryfall_id}) et prix natif Cardmarket
	// (GET /cardmarket/{cardmarket_id}/prices, price_type="trend") — voir
	// cardbase.ts pour pourquoi ces deux endpoints existent en plus de
	// fetchCardbasePriceHistory ci-dessus. `null` = réponse confirmée sans
	// résultat (pas de cardmarket_id pour cette impression, ou prix "trend"
	// absent) ; clé absente = pas encore demandé — même distinction que
	// scryfallImmutableCache plus haut. cardmarketIdCache est scryfallId → id,
	// cardmarketNativePricesCache est cardmarketId → résultat (une même
	// impression Cardmarket peut être visée par plusieurs scryfallId — art
	// variants — donc les deux caches sont volontairement séparés plutôt que
	// composés en une seule clé). Seul cardmarketIdCache est persisté sur
	// disque (un identifiant produit ne change pas) — PAS
	// cardmarketNativePricesCache juste en dessous, qui contient un vrai
	// PRIX (change quotidiennement, même exclusion que cardKingdomPricesCache/
	// manaPoolPricesCache/cardbasePriceHistoryCache ailleurs dans ce fichier).
	cardmarketIdCache: Map<string, number | null> = new Map();
	cardmarketIdInFlight: Map<string, Promise<number | null>> = new Map();
	cardmarketNativePricesCache: Map<number, CardmarketNativePrices | undefined> = new Map();
	cardmarketNativePricesInFlight: Map<number, Promise<CardmarketNativePrices | undefined>> = new Map();
	// Résultats "Market Trends" (GET /movers, bloc du dashboard Home depuis
	// le 2026-09-22 — voir home-render.ts, anciennement sa propre modale) —
	// clé `${period}:${vendor ?? "all"}`, pas de requête-en-vol dédoublonnée
	// (contrairement aux caches ci-dessus) : un seul bloc à la fois déclenche
	// ce fetch, sur interaction utilisateur (changement de période/vendeur)
	// plutôt que potentiellement en concurrence depuis plusieurs lignes
	// d'une même liste comme les autres caches de ce fichier — le risque de
	// doublon en vol est donc négligeable ici.
	cardbaseMoversCache: Map<string, CardbaseMoversResult | undefined> = new Map();
	// Taux de change USD/EUR (frankfurter.dev), pour unifier l'axe Y du
	// graphique "Price History" en une seule devise (voir card-detail-fx.ts) —
	// même forme "un seul fetch par session" que symbologyCache/allSetsCache
	// ci-dessus, pas la forme par-ID de legalitiesCache : ce plugin ne suit
	// qu'une seule paire de devises (voir PriceCurrency, price.ts), un seul
	// taux couvre toute la session.
	usdEurRateCache: UsdEurRate | null = null;
	usdEurRateFetchPromise: Promise<UsdEurRate | undefined> | null = null;

	// Champs déplacés depuis la zone des méthodes lors du découpage Phase 5 (2026-09-10)
	// -- restent des champs d'instance réels, juste relocalisés ici pour rester groupés avec les autres.
	immutableCachePersistTimers: Map<string, number> = new Map();
	cachedArtists: string[] | null = null;
	cachedSets: { code: string; name: string }[] | null = null;
	pendingSaveTimer: number | null = null;
	dataVersion = 0;
	// Synchronisation multi-appareils de data.json (src/plugin/settings-sync.ts).
	// diskText : contenu de data.json tel que CE plugin le connaît (sa dernière
	// écriture ou ce qu'il a lu) ; syncBaseText : dernière version venue d'ailleurs
	// (ou lue au démarrage), point de départ des fusions à trois voies — jamais
	// avancée par nos propres écritures ; diskSig : mtime+taille correspondants,
	// pour éviter de relire 6 Mo à chaque contrôle ; knownKeys : entités connues à la
	// dernière écriture, pour repérer les suppressions ; persistChain : file qui
	// sérialise toute opération disque.
	diskText: string | null = null;
	syncBaseText: string | null = null;
	diskSig: settingsSync.DiskSignature | null = null;
	knownKeys: KeySnapshot | null = null;
	knownScalars: Record<string, string> | null = null;
	knownPrints: EntityPrints | null = null;
	persistChain: Promise<void> = Promise.resolve();
	externalCheckQueued = false;
	mergeWrites: number[] = [];
	settingsLoaded = false;
	saveFailed = false;
	saveRetryTimer: number | null = null;
	lastDeviceLocal: string | null = null;
	// Dossier de la vault qui contient le fichier de données ("" = dossier du plugin), voir settings-sync.ts.
	dataFolderInUse = "";
	// Synchronisation GitHub optionnelle (src/plugin/github-sync.ts).
	github: githubSync.GithubSyncState = githubSync.createGithubState();
	recentlyAddedCollectionCardIds = new Set<string>();
	recentlyAddedWantlistCardIds = new Set<string>();
	async onload() {
		await this.loadSettings();
		// Recharge le cache de légalités persisté d'une session précédente
		// (voir loadPersistedLegalitiesCache) avant maybeAutoRefreshLegalities
		// plus bas, sans quoi ce dernier ne verrait aucune entrée fraîche et
		// re-téléchargerait toute la collection à chaque démarrage.
		await this.loadPersistedLegalitiesCache();
		// Même raisonnement pour les 4 caches "immuables" persistés séparément
		// (voir loadPersistedMapCache/loadPersistedAllSetsCache, et le
		// commentaire de chaque champ de cache concerné plus haut) — avant
		// registerView plus bas, pour qu'une vue restaurée par Obsidian au
		// démarrage (leaf déjà ouvert) affiche son contenu dès son tout
		// premier rendu plutôt que d'attendre un aller-retour Scryfall pour
		// chaque icône/texte/lien.
		await Promise.all([
			this.loadPersistedMapCache(scryfallCache.ICON_CACHE_FILENAME, this.setIconCache, isStringOrNull),
			this.loadPersistedMapCache(
				scryfallCache.SCRYFALL_IMMUTABLE_CACHE_FILENAME,
				this.scryfallImmutableCache,
				isObjectOrNull
			),
			this.loadPersistedMapCache(
				cardbaseCache.CARDMARKET_ID_CACHE_FILENAME,
				this.cardmarketIdCache,
				isNumberOrNull
			),
			this.loadPersistedMapCache(
				scryfallCache.PRINT_LANGUAGES_CACHE_FILENAME,
				this.printLanguagesCache,
				isStringArray
			),
			this.loadPersistedAllSetsCache(),
		]);

		// Icône custom pour le bouton "1 colonne" (view.ts) -- enregistrée une
		// fois ici plutôt qu'à chaque render() de la vue, puisqu'addIcon()
		// ajoute l'icône à la bibliothèque globale d'Obsidian pour la durée de
		// la session.
		addIcon("mtg-one-column", ONE_COLUMN_ICON_SVG);

		this.registerView(
			VIEW_TYPE_MTG_COLLECTION,
			(leaf) => new MTGCollectionView(leaf, this)
		);

		this.refreshCollectionRibbonIcon();

		this.addCommand({
			id: "open-mtg-collection-view",
			name: "Open MTG collection view",
			callback: () => this.activateView(),
		});

		this.addSettingTab(new MTGCollectionSettingTab(this.app, this));

		// Surveille data.json hors écriture (autre appareil via Syncthing) — voir
		// src/plugin/settings-sync.ts. Après loadSettings(), qui amorce l'état de départ.
		this.setupSettingsSync();
		this.setupGithubSync();

		// Vérifie en arrière-plan si le délai configuré est écoulé (ne bloque
		// pas le chargement du plugin). Revérifie ensuite toutes les heures au
		// cas où Obsidian reste ouvert plus longtemps que l'intervalle choisi.
		this.registerInterval(
			window.setInterval(() => void this.maybeAutoRefreshPrices(), 60 * 60 * 1000)
		);

		this.registerInterval(
			window.setInterval(() => void this.maybeAutoRefreshLegalities(), 60 * 60 * 1000)
		);

		// Sauvegardes automatiques (voir maybeAutoBackup juste plus bas /
		// runAutoBackup dans src/plugin/backup.ts) — même mécanique hourly-check que les deux ci-dessus, mais
		// volontairement PAS chaînée dans l'IIFE séquentielle plus bas : cette
		// passe n'appelle jamais Scryfall (une écriture de fichier locale
		// pure), donc rien à sérialiser avec les 4 passes réseau qui suivent.
		this.registerInterval(window.setInterval(() => void this.maybeAutoBackup(), 60 * 60 * 1000));
		void this.maybeAutoBackup();

		void (async () => {
			await this.maybeAutoRefreshPrices();
			await this.maybeAutoRefreshLegalities();
			// Rattrapage ponctuel de bordure/cadre (voir backfillBorderData) —
			// pas d'intervalle horaire contrairement aux légalités ci-dessus :
			// une fois toute la collection couverte, plus jamais besoin de
			// repasser, cette donnée ne périme jamais.
			await this.backfillBorderData();
			// Même raisonnement, pour le texte de règles (voir
			// backfillOracleTextData) — appel séparé plutôt que fusionné avec
			// backfillBorderData, voir son propre commentaire.
			await this.backfillOracleTextData();
			// Rattrapage ponctuel du prix pour les decks existants (voir
			// backfillDeckCardPrices) — contrairement à maybeAutoRefreshPrices
			// tout en haut de cette chaîne (gated par l'intervalle configuré,
			// jamais garanti de tourner juste après cette mise à jour si le
			// dernier rafraîchissement est encore récent), ce rattrapage ne
			// dépend d'aucun intervalle : il ne regarde que "ce deck a-t-il
			// déjà ce champ", une fois pour toutes, comme les deux juste
			// au-dessus.
			await this.backfillDeckCardPrices();
		})();
	}

	onunload() {
		// Écrit immédiatement toute sauvegarde encore en attente (voir
		// saveSettings) : sans ça, désactiver le plugin dans la fenêtre de
		// debounce perdrait la dernière modification.
		void this.flushPendingSave();
		// Envoi au mieux de ce qui attend encore pour GitHub (voir flushGithubSync).
		void this.flushGithubSync();
		// Même raisonnement pour le cache de légalités (voir
		// scheduleLegalitiesPersist) — non attendu (onunload() n'est pas
		// garanti d'attendre une Promise par Obsidian), mais mieux que de
		// perdre silencieusement les dernières entrées résolues juste avant
		// la fermeture.
		if (this.legalitiesPersistTimer !== null) {
			window.clearTimeout(this.legalitiesPersistTimer);
			this.legalitiesPersistTimer = null;
			void this.flushLegalitiesPersist();
		}
		// Même raisonnement pour les 4 caches "immuables" persistés séparément
		// (voir scheduleMapCachePersist/flushPendingImmutableCaches).
		this.flushPendingImmutableCaches();
		// Ceinture et bretelles avec le register() de la vue (src/view/mobile-bars.ts) : une classe
		// restée sur <body> masquerait les barres d'Obsidian dans TOUTE l'appli.
		document.body.removeClass(HIDE_BARS_CLASS);
	}

	refreshCollectionRibbonIcon() {
		if (this.collectionRibbonIconEl) {
			this.collectionRibbonIconEl.remove();
			this.collectionRibbonIconEl = null;
		}

		const el = this.addRibbonIcon("layers", "Open MTG collection", () => {
			void this.activateView();
		});
		el.addClass("mtg-ribbon-icon");

		const svg = this.settings.customIconSvg?.trim();
		if (svg) {
			el.empty();
			setSvgMarkup(el, sanitizeSvg(svg));
			const svgEl = el.querySelector("svg");
			if (svgEl) {
				svgEl.setAttribute("width", "18");
				svgEl.setAttribute("height", "18");
			}
		}

		if (this.settings.customIconColor) {
			el.style.color = this.settings.customIconColor;
		} else {
			el.style.removeProperty("color");
		}

		this.collectionRibbonIconEl = el;
	}

	// Répercute la couleur d'accent choisie dans les réglages sur toutes les
	// vues collection actuellement ouvertes.
	refreshAccentColor() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof MTGCollectionView) {
				view.applyAccentColor();
			}
		});
	}

	// Répercute settings.hideObsidianMobileBars sur toutes les vues collection
	// actuellement ouvertes (mobile-bars.ts, syncMobileBars ne s'applique de
	// toute façon que sur téléphone). Un changement dans Settings ne modifie
	// pas la feuille active — la seule chose qui re-synchronise sinon (voir
	// mobile-bars.ts) — donc il faut le déclencher ici explicitement.
	refreshMobileBars() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof MTGCollectionView) {
				view.syncMobileBars();
			}
		});
	}

	// Force un nouveau rendu de toutes les vues collection ouvertes (ex. après
	// un changement de devise d'affichage dans les réglages).
	refreshOpenViews() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof MTGCollectionView) {
				view.render();
			}
		});
	}

	// Récupère (et met en cache pour la session) le SVG de l'icône d'édition
	// officielle fournie par Scryfall pour un code d'édition donné.
	//
	// Deux pièges évités ici, qui faisaient qu'une icône chargeait "parfois
	// oui, parfois non" selon les sessions :
	// 1. Un échec transitoire (limite de requêtes, coupure réseau...) était
	//    mis en cache comme "pas d'icône" au même titre qu'un vrai 404 — cette
	//    édition ne retentait alors plus jamais de la session, même une fois
	//    la cause du problème disparue. On ne met en cache "pas d'icône" que
	//    sur un 404 confirmé (l'édition n'existe vraiment pas).
	// 2. Plusieurs lignes affichant le même set en même temps (rendu initial
	//    d'une longue liste) déclenchaient chacune leur propre requête pour
	//    la même icône ; setIconInFlight les fait maintenant partager une
	//    seule requête.
	// 3. Plusieurs SETS DIFFÉRENTS encore non mis en cache, affichés en même
	//    temps (même scénario, mais aucun des deux pièges ci-dessus ne s'y
	//    applique puisque ce sont des codes distincts) déclenchaient chacun
	//    leur propre requête EN PARALLÈLE, sans aucun espacement — voir
	//    setIconFetchQueue pour le raisonnement complet et le bug de
	//    rate-limit Scryfall que ça a causé. Un nouveau fetch chaîne
	//    désormais sur cette file plutôt que de partir immédiatement.

	// -------------------------------------------------------------------
	// Method implementations below live in src/plugin/*.ts (split out on
	// 2026-09-10, see CLAUDE.md's "Architecture notes") -- each field is
	// still called exactly as this.plugin.methodName(...) everywhere else
	// in the codebase, unchanged; only WHERE the implementation lives
	// moved. This block is a manifest/index of the whole class's surface.
	// -------------------------------------------------------------------

	// -- Scryfall data: set icons, legalities, immutable per-card snapshot, set list, symbology, mana symbols, print languages (src/plugin/scryfall-cache.ts) --
	getSetIconSvg = scryfallCache.getSetIconSvg;
	fetchSetIconSvg = scryfallCache.fetchSetIconSvg;
	getCardLegalities = scryfallCache.getCardLegalities;
	getCachedLegalities = scryfallCache.getCachedLegalities;
	getLegalitiesCache = scryfallCache.getLegalitiesCache;
	isLegalitiesFresh = scryfallCache.isLegalitiesFresh;
	legalitiesCacheFilePath = scryfallCache.legalitiesCacheFilePath;
	loadPersistedLegalitiesCache = scryfallCache.loadPersistedLegalitiesCache;
	scheduleLegalitiesPersist = scryfallCache.scheduleLegalitiesPersist;
	flushLegalitiesPersist = scryfallCache.flushLegalitiesPersist;
	immutableCacheFilePath = scryfallCache.immutableCacheFilePath;
	scheduleMapCachePersist = scryfallCache.scheduleMapCachePersist;
	flushMapCachePersist = scryfallCache.flushMapCachePersist;
	flushPendingImmutableCaches = scryfallCache.flushPendingImmutableCaches;
	allSetsCacheFilePath = scryfallCache.allSetsCacheFilePath;
	loadPersistedAllSetsCache = scryfallCache.loadPersistedAllSetsCache;
	persistAllSetsCache = scryfallCache.persistAllSetsCache;
	maybeAutoRefreshLegalities = scryfallCache.maybeAutoRefreshLegalities;
	bulkFetchLegalities = scryfallCache.bulkFetchLegalities;
	fetchCardLegalities = scryfallCache.fetchCardLegalities;
	getScryfallImmutableSnapshot = scryfallCache.getScryfallImmutableSnapshot;
	getScryfallImmutableSnapshots = scryfallCache.getScryfallImmutableSnapshots;
	fetchScryfallImmutableSnapshot = scryfallCache.fetchScryfallImmutableSnapshot;
	getTcgplayerUrl = scryfallCache.getTcgplayerUrl;
	getCardTextInfo = scryfallCache.getCardTextInfo;
	getCardFaceImages = scryfallCache.getCardFaceImages;
	getSplitCardInfo = scryfallCache.getSplitCardInfo;
	getAllScryfallSets = scryfallCache.getAllScryfallSets;
	getCachedSetSummary = scryfallCache.getCachedSetSummary;
	loadSymbology = scryfallCache.loadSymbology;
	getManaSymbolSvg = scryfallCache.getManaSymbolSvg;
	fetchManaSymbolSvg = scryfallCache.fetchManaSymbolSvg;
	getAvailableLanguages = scryfallCache.getAvailableLanguages;
	loadPersistedMapCache = scryfallCache.loadPersistedMapCache;

	// -- Card Kingdom / Mana Pool price lists (src/plugin/store-prices.ts) --
	loadCardKingdomPrices = storePrices.loadCardKingdomPrices;
	getCardKingdomPrice = storePrices.getCardKingdomPrice;
	loadManaPoolPrices = storePrices.loadManaPoolPrices;
	getManaPoolPrice = storePrices.getManaPoolPrice;

	// -- cardbase.dev: price history, native Cardmarket prices, market movers (src/plugin/cardbase-cache.ts) --
	getCardbasePriceHistory = cardbaseCache.getCardbasePriceHistory;
	cardbasePrefetchWindow = cardbaseCache.cardbasePrefetchWindow;
	prefetchCardbaseNeighbors = cardbaseCache.prefetchCardbaseNeighbors;
	fetchCardbasePriceHistoryWithRetry = cardbaseCache.fetchCardbasePriceHistoryWithRetry;
	cardbaseDaysForTier = cardbaseCache.cardbaseDaysForTier;
	getCardbaseCardmarketId = cardbaseCache.getCardbaseCardmarketId;
	fetchCardmarketIdWithRetry = cardbaseCache.fetchCardmarketIdWithRetry;
	getCardmarketNativePrices = cardbaseCache.getCardmarketNativePrices;
	fetchCardmarketNativePricesWithRetry = cardbaseCache.fetchCardmarketNativePricesWithRetry;
	getCardbasePriceHistoryWithNativeCardmarket = cardbaseCache.getCardbasePriceHistoryWithNativeCardmarket;
	getCardbaseMovers = cardbaseCache.getCardbaseMovers;

	// -- USD/EUR exchange rate (src/plugin/exchange-rate.ts) --
	getUsdEurRate = exchangeRate.getUsdEurRate;

	// -- Refreshing the stored prices of cards (src/plugin/price-refresh.ts) --
	refreshAllPrices = priceRefresh.refreshAllPrices;
	maybeAutoRefreshPrices = priceRefresh.maybeAutoRefreshPrices;

	// -- Plugin lifecycle and settings load/save (src/plugin/lifecycle.ts) --
	activateView = lifecycle.activateView;
	loadSettings = lifecycle.loadSettings;
	runSettingsMigrations = lifecycle.runSettingsMigrations;
	saveSettings = lifecycle.saveSettings;
	flushPendingSave = lifecycle.flushPendingSave;
	getDistinctArtists = lifecycle.getDistinctArtists;
	getDistinctSets = lifecycle.getDistinctSets;

	// -- Backup / restore (src/plugin/backup.ts) --
	exportBackup = backup.exportBackup;
	parseBackupFile = backup.parseBackupFile;
	restoreBackup = backup.restoreBackup;
	maybeAutoBackup = backup.maybeAutoBackup;
	runAutoBackup = backup.runAutoBackup;
	pruneAutoBackups = backup.pruneAutoBackups;
	listBackupFiles = backup.listBackupFiles;
	readBackupFile = backup.readBackupFile;

	// -- Multi-device sync of data.json (src/plugin/settings-sync.ts) --
	readSettingsFromDisk = settingsSync.readSettingsFromDisk;
	markSettingsLoaded = settingsSync.markSettingsLoaded;
	loadDeviceLocalSettings = settingsSync.loadDeviceLocalSettings;
	saveDeviceLocalSettings = settingsSync.saveDeviceLocalSettings;
	persistSettings = settingsSync.persistSettings;
	checkForExternalChange = settingsSync.checkForExternalChange;
	onExternalSettingsChange = settingsSync.onExternalSettingsChange;
	setupSettingsSync = settingsSync.setupSettingsSync;
	changeDataFolder = settingsSync.changeDataFolder;

	// -- Optional GitHub sync of data.json (src/plugin/github-sync.ts) --
	getGithubToken = githubSync.getGithubToken;
	setGithubToken = githubSync.setGithubToken;
	githubSync = githubSync.githubSync;
	markGithubDirty = githubSync.markGithubDirty;
	flushGithubSync = githubSync.flushGithubSync;
	resetGithubSync = githubSync.resetGithubSync;
	githubTestNow = githubSync.githubTestNow;
	subscribeGithubStatus = githubSync.subscribeGithubStatus;
	githubHomeStatus = githubSync.githubHomeStatus;
	setupGithubSync = githubSync.setupGithubSync;


	// -- One-shot data migrations/backfills (src/plugin/migrations.ts) --
	migrateListDateCreated = migrations.migrateListDateCreated;
	migrateDeckDateCreated = migrations.migrateDeckDateCreated;
	migrateFoilSplit = migrations.migrateFoilSplit;
	ensureInboxList = migrations.ensureInboxList;
	migrateFoilToFinish = migrations.migrateFoilToFinish;
	migrateDamagedCondition = migrations.migrateDamagedCondition;
	migrateDeckCommanderCategory = migrations.migrateDeckCommanderCategory;
	backfillBorderData = migrations.backfillBorderData;
	backfillOracleTextData = migrations.backfillOracleTextData;
	backfillDeckCardPrices = migrations.backfillDeckCardPrices;
	migrateCollectionToLists = migrations.migrateCollectionToLists;
	migrateEnrichMetadata = migrations.migrateEnrichMetadata;
	migrateArtCropUrls = migrations.migrateArtCropUrls;
	migrateDeckCardDefaults = migrations.migrateDeckCardDefaults;
	migrateEnrichDeckMetadata = migrations.migrateEnrichDeckMetadata;

	// -- My Collection: cards + lists (src/plugin/collection-mutations.ts) --
	createListSilent = collectionMutations.createListSilent;
	getOrCreateListByName = collectionMutations.getOrCreateListByName;
	addCardToCollection = collectionMutations.addCardToCollection;
	changeCollectionCardCount = collectionMutations.changeCollectionCardCount;
	removeCollectionCard = collectionMutations.removeCollectionCard;
	undoAddToCollection = collectionMutations.undoAddToCollection;
	setCollectionCardLanguage = collectionMutations.setCollectionCardLanguage;
	setCollectionCardCondition = collectionMutations.setCollectionCardCondition;
	setCollectionCardFinish = collectionMutations.setCollectionCardFinish;
	setCollectionCardGrading = collectionMutations.setCollectionCardGrading;
	setCollectionCardCustomPrice = collectionMutations.setCollectionCardCustomPrice;
	setCollectionCardCount = collectionMutations.setCollectionCardCount;
	changeCollectionCardPrinting = collectionMutations.changeCollectionCardPrinting;
	findListDuplicateGroups = collectionMutations.findListDuplicateGroups;
	mergeListDuplicateGroup = collectionMutations.mergeListDuplicateGroup;
	mergeListDuplicates = collectionMutations.mergeListDuplicates;
	bulkRemoveCollectionCards = collectionMutations.bulkRemoveCollectionCards;
	bulkSetCollectionCardCondition = collectionMutations.bulkSetCollectionCardCondition;
	bulkSetCollectionCardLanguage = collectionMutations.bulkSetCollectionCardLanguage;
	bulkSetCollectionCardFinish = collectionMutations.bulkSetCollectionCardFinish;
	bulkSetCollectionCardCount = collectionMutations.bulkSetCollectionCardCount;
	createList = collectionMutations.createList;
	deleteList = collectionMutations.deleteList;
	clearList = collectionMutations.clearList;
	setListCoverCard = collectionMutations.setListCoverCard;
	setListIcon = collectionMutations.setListIcon;
	bulkDeleteLists = collectionMutations.bulkDeleteLists;
	mergeLists = collectionMutations.mergeLists;
	renameList = collectionMutations.renameList;
	copyCollectionCardToList = collectionMutations.copyCollectionCardToList;
	copyCollectionCardToWantlist = collectionMutations.copyCollectionCardToWantlist;
	moveCollectionCardToList = collectionMutations.moveCollectionCardToList;
	moveCollectionCardToWantlist = collectionMutations.moveCollectionCardToWantlist;

	// -- My Wantlists (src/plugin/wantlist-mutations.ts) --
	getOrCreateWantlistByName = wantlistMutations.getOrCreateWantlistByName;
	changeWantlistCardPrinting = wantlistMutations.changeWantlistCardPrinting;
	addCardToWantlist = wantlistMutations.addCardToWantlist;
	changeWantlistCardCount = wantlistMutations.changeWantlistCardCount;
	setWantlistCardCount = wantlistMutations.setWantlistCardCount;
	removeWantlistCard = wantlistMutations.removeWantlistCard;
	undoAddToWantlist = wantlistMutations.undoAddToWantlist;
	setWantlistCardFinish = wantlistMutations.setWantlistCardFinish;
	createWantlist = wantlistMutations.createWantlist;
	createWantlistSilent = wantlistMutations.createWantlistSilent;
	deleteWantlist = wantlistMutations.deleteWantlist;
	clearWantlist = wantlistMutations.clearWantlist;
	setWantlistCoverCard = wantlistMutations.setWantlistCoverCard;
	setWantlistIcon = wantlistMutations.setWantlistIcon;
	bulkDeleteWantlists = wantlistMutations.bulkDeleteWantlists;
	findWantlistDuplicateGroups = wantlistMutations.findWantlistDuplicateGroups;
	mergeWantlistDuplicateGroup = wantlistMutations.mergeWantlistDuplicateGroup;
	mergeWantlistDuplicates = wantlistMutations.mergeWantlistDuplicates;
	mergeWantlists = wantlistMutations.mergeWantlists;
	renameWantlist = wantlistMutations.renameWantlist;
	copyWantlistCardToWantlist = wantlistMutations.copyWantlistCardToWantlist;
	moveWantlistCardToWantlist = wantlistMutations.moveWantlistCardToWantlist;
	copyWantlistCardToList = wantlistMutations.copyWantlistCardToList;
	bulkRemoveWantlistCards = wantlistMutations.bulkRemoveWantlistCards;
	bulkSetWantlistCardFinish = wantlistMutations.bulkSetWantlistCardFinish;
	bulkSetWantlistCardCount = wantlistMutations.bulkSetWantlistCardCount;
	bulkMoveWantlistCardsToWantlist = wantlistMutations.bulkMoveWantlistCardsToWantlist;
	moveWantlistCardToCollection = wantlistMutations.moveWantlistCardToCollection;
	moveWantlistCardsToCollection = wantlistMutations.moveWantlistCardsToCollection;
	moveWantlistCardToCollectionNoSave = wantlistMutations.moveWantlistCardToCollectionNoSave;

	// -- My Decks (src/plugin/deck-mutations.ts) --
	changeDeckCardPrinting = deckMutations.changeDeckCardPrinting;
	createDeck = deckMutations.createDeck;
	setDeckFormat = deckMutations.setDeckFormat;
	clearDeck = deckMutations.clearDeck;
	setDeckCoverCard = deckMutations.setDeckCoverCard;
	setDeckIcon = deckMutations.setDeckIcon;
	deleteDeck = deckMutations.deleteDeck;
	bulkDeleteDecks = deckMutations.bulkDeleteDecks;
	renameDeck = deckMutations.renameDeck;
	copyDeck = deckMutations.copyDeck;
	createDeckSilent = deckMutations.createDeckSilent;
	mergeDeckDuplicates = deckMutations.mergeDeckDuplicates;
	mergeDecks = deckMutations.mergeDecks;
	addCardToDeck = deckMutations.addCardToDeck;
	addCollectionCardToDeck = deckMutations.addCollectionCardToDeck;
	addWantlistCardToDeck = deckMutations.addWantlistCardToDeck;
	changeDeckCardCount = deckMutations.changeDeckCardCount;
	removeDeckCard = deckMutations.removeDeckCard;
	setDeckCardFinish = deckMutations.setDeckCardFinish;
	setDeckCardCondition = deckMutations.setDeckCardCondition;
	setDeckCardLanguage = deckMutations.setDeckCardLanguage;
	setDeckCardCategory = deckMutations.setDeckCardCategory;
	setDeckCardFunction = deckMutations.setDeckCardFunction;
	setDeckCardGrading = deckMutations.setDeckCardGrading;
	setDeckCardCustomPrice = deckMutations.setDeckCardCustomPrice;
	undoAddToDeck = deckMutations.undoAddToDeck;
	copyDeckCardToList = deckMutations.copyDeckCardToList;
	moveDeckCardToList = deckMutations.moveDeckCardToList;
	copyDeckCardToWantlist = deckMutations.copyDeckCardToWantlist;
	moveDeckCardToWantlist = deckMutations.moveDeckCardToWantlist;
	copyDeckCardToDeck = deckMutations.copyDeckCardToDeck;
	moveDeckCardToDeck = deckMutations.moveDeckCardToDeck;
	bulkRemoveDeckCards = deckMutations.bulkRemoveDeckCards;
	bulkSetDeckCardCount = deckMutations.bulkSetDeckCardCount;
	bulkSetDeckCardCondition = deckMutations.bulkSetDeckCardCondition;
	bulkSetDeckCardLanguage = deckMutations.bulkSetDeckCardLanguage;
	bulkSetDeckCardFinish = deckMutations.bulkSetDeckCardFinish;
	bulkSetDeckCardCategory = deckMutations.bulkSetDeckCardCategory;
	bulkSetDeckCardFunction = deckMutations.bulkSetDeckCardFunction;

	// -- CSV/decklist import, saved search filters (src/plugin/import-export.ts) --
	importDecklistToDeck = importExport.importDecklistToDeck;
	importDeckCsv = importExport.importDeckCsv;
	importDecklistToList = importExport.importDecklistToList;
	importDecklistToWantlist = importExport.importDecklistToWantlist;
	importCsv = importExport.importCsv;
	importWantlistCsv = importExport.importWantlistCsv;
	saveSearchFilter = importExport.saveSearchFilter;
	deleteSearchFilter = importExport.deleteSearchFilter;

}
