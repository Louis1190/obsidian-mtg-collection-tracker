import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

/* -------------------------------------------------------------------------- */
/*  Scryfall API helpers                                                      */
/* -------------------------------------------------------------------------- */

// Résumé d'une édition tel que renvoyé par /sets (liste complète), utilisé
// pour l'autocomplétion du champ "Set" dans la recherche d'ajout.
export interface ScryfallSetSummary {
	code: string;
	name: string;
	set_type: string;
	released_at?: string;
	icon_svg_uri?: string;
	digital: boolean;
}

export interface ScryfallCard {
	id: string;
	name: string;
	set: string;
	set_name: string;
	collector_number: string;
	rarity: string;
	mana_cost?: string;
	cmc?: number;
	type_line: string;
	oracle_text?: string;
	power?: string;
	toughness?: string;
	loyalty?: string;
	artist?: string;
	colors?: string[];
	keywords?: string[];
	released_at?: string;
	// "split" couvre Fire // Ice comme Never // Return (mécanique Aftermath,
	// fusionnée par Scryfall sous ce même layout — voir getSplitCardInfo plus
	// bas) ; "transform"/"modal_dfc"/etc. pour les vraies double-face — voir
	// getDoubleFacedImages, qui ne dépend pas de ce champ (repli sur la
	// présence/absence d'image_uris à la racine, plus fiable, voir son propre
	// commentaire).
	layout?: string;
	image_uris?: { normal?: string; small?: string; art_crop?: string };
	card_faces?: {
		name?: string;
		mana_cost?: string;
		type_line?: string;
		oracle_text?: string;
		power?: string;
		toughness?: string;
		loyalty?: string;
		image_uris?: { normal?: string; small?: string; art_crop?: string };
	}[];
	prices?: {
		usd?: string;
		usd_foil?: string;
		usd_etched?: string;
		eur?: string;
		eur_foil?: string;
		eur_etched?: string;
	};
	legalities?: Record<string, string>;
	purchase_uris?: { tcgplayer?: string };
	// Bordure/cadre (filtre "border:", card-search.ts) — toujours présents au
	// niveau racine, y compris pour une carte double-face (contrairement à
	// oracle_text/power/toughness, voir buildCardTextInfo plus bas), donc pas
	// besoin d'une logique de combinaison de faces ici. Confirmé en direct sur
	// /cards/search le 2026-08-16 : border_color ∈ {black, white, silver,
	// gold, yellow, borderless} (gold existe côté API mais 0 carte connue
	// aujourd'hui) ; frame_effects peut porter plusieurs valeurs à la fois
	// (ex. ["legendary", "showcase"]) — seules "extendedart"/"showcase" nous
	// intéressent, voir BORDER_SEARCH_OPTIONS (card-search.ts) ; le cadre
	// "rétro" n'est ni l'un ni l'autre, c'est frame === "1997".
	border_color?: string;
	frame?: string;
	frame_effects?: string[];
}

// Sous-ensemble de ScryfallCard consommé par MTGCollectionPlugin.getScryfall
// ImmutableSnapshot (plugin.ts) : à l'origine (2026-08-18) les champs
// partagés par buildCardTextInfo/getDoubleFacedImages/getSplitCardInfo +
// purchase_uris.tcgplayer — exactement ce qu'ouvrir une fiche carte a
// besoin de dériver côté "Card Text"/bouton Flip/bouton Rotate/lien
// TCGplayer, en un seul aller-retour Scryfall par carte au lieu des 4
// requêtes indépendantes que faisaient encore, jusque-là, ces 4
// fonctionnalités pour le même id. Élargi deux fois depuis (2026-09-23,
// voir les champs eux-mêmes ci-dessous) pour CardPreviewModal (Home's
// Market Trends, card-preview-modal.ts) : set/set_name/collector_number/
// rarity/mana_cost/type_line, tout aussi immuables par scryfallId
// qu'oracle_text/image_uris (une impression donnée ne change jamais
// d'édition/numéro/rareté/coût/type). Toujours délibérément SANS
// `prices`/`legalities`/`name`/etc. — un objet mis en cache indéfiniment
// (voir SCRYFALL_IMMUTABLE_CACHE_FILENAME, jamais de TTL) ne doit
// structurellement pas pouvoir être relu comme une source de prix/légalité
// fraîche par erreur ; ces deux-là périment (prix quotidien, légalité
// re-vérifiée sous 7 jours) alors que rien dans ce Pick ne change jamais
// une fois l'impression sortie (erratum textuel mis à part). Un objet
// ScryfallCard complet satisfait toujours structurellement ce type plus
// étroit (Pick), donc buildCardTextInfo/getDoubleFacedImages/getSplitCardInfo
// restent appelables sans changement partout ailleurs (import CSV, recherche
// d'ajout...) où un ScryfallCard complet est déjà disponible.
export type ScryfallImmutableSnapshot = Pick<
	ScryfallCard,
	| "oracle_text"
	| "power"
	| "toughness"
	| "loyalty"
	| "card_faces"
	| "purchase_uris"
	| "image_uris"
	| "layout"
	| "keywords"
	| "set"
	| "set_name"
	| "collector_number"
	| "rarity"
	// mana_cost/type_line : root-level only (a multi-face card's own
	// per-face values already come through card_faces[] above, which
	// CardTextInfo.faces/CardTextFace already carry — see buildCardTextInfo
	// below) — needed by CardPreviewModal's single-face path, the first
	// consumer of this type with no CollectionCard/DeckCard/WantlistCard of
	// its own already caching these (see CardTextInfo's own comment for why
	// every earlier consumer never needed them here).
	| "mana_cost"
	| "type_line"
>;

// Une face individuelle d'une carte à plusieurs faces (split, adventure,
// flip, transform, modal_dfc, meld...), pour l'affichage "Card Text" du
// panneau de détail (CardDetailModal.renderCardDescriptionBox,
// renderCardDescriptionFaces dans card-detail-fx.ts) — voir CardTextInfo.
// faces plus bas pour le raisonnement complet.
export interface CardTextFace {
	name: string;
	manaCost?: string;
	typeLine?: string;
	oracleText: string;
	power?: string;
	toughness?: string;
	loyalty?: string;
}

// Texte de règles + stats (bloc "Card Text" du panneau de détail, voir
// CardDetailModal.renderCardDescriptionBox) — nom/coût/type sont déjà mis en
// cache sur CollectionCard/DeckCard/WantlistCard (voir "Files" dans
// CLAUDE.md), donc pas besoin de les refaire remonter ici ; seuls
// oracle_text/power/toughness/loyalty n'ont jamais été stockés nulle part
// dans ce plugin avant ce bloc.
export interface CardTextInfo {
	oracleText: string;
	power?: string;
	toughness?: string;
	loyalty?: string;
	// Non-undefined UNIQUEMENT pour une carte à plusieurs faces (voir
	// buildCardTextInfo ci-dessous) — détail par face réelle (chacune avec
	// son propre nom/coût/type/texte/stats), plutôt que la version fusionnée
	// ci-dessus. Ajouté suite à un retour explicite (Fire // Ice affichait
	// ses deux coûts de mana bout à bout et "Instant // Instant" comme type
	// combiné, jugé illisible) — renderCardDescriptionBox préfère ce champ
	// dès qu'il est présent, pour afficher chaque face dans sa propre
	// section séparée d'une ligne discrète plutôt qu'un "//" textuel.
	// oracleText/power/toughness/loyalty ci-dessus restent la version
	// fusionnée, inchangée, pour tout code qui n'a pas besoin de cette
	// séparation.
	faces?: CardTextFace[];
}

// Cartes double-face (transform/modal/split...) : Scryfall ne renvoie ni
// oracle_text ni power/toughness/loyalty au niveau racine pour ces cartes-là
// (contrairement à type_line, toujours une combinaison des deux faces même
// au niveau racine) — le texte de chaque face vit dans card_faces[]. La
// version fusionnée (oracleText/power/toughness/loyalty) reste volontaire-
// ment simple plutôt qu'une mise en page recto/verso complète (repli
// d'origine, avant que `faces` n'existe) : concatène le texte de chaque
// face (précédé de son propre nom pour rester lisible), et reprend les
// stats de la première face qui en a — un DFC créature/planeswalker n'a
// quasiment jamais ses deux faces avec des stats différentes en même
// temps, donc ce choix couvre déjà l'immense majorité des cas réels.
// `faces` (ajouté ensuite) expose en plus le détail par face telle quelle,
// sans fusion — nom/coût/type propres à CHAQUE face, pas de "//" ni de
// coûts de mana bout à bout, pour un affichage qui sépare vraiment "Fire"
// de "Ice" (ou le recto du verso d'une vraie double-face) plutôt que de
// les combiner dans un seul bloc.
export function buildCardTextInfo(card: ScryfallImmutableSnapshot): CardTextInfo {
	if (card.oracle_text !== undefined || !card.card_faces || card.card_faces.length === 0) {
		return {
			oracleText: card.oracle_text ?? "",
			power: card.power,
			toughness: card.toughness,
			loyalty: card.loyalty,
		};
	}
	const oracleText = card.card_faces
		.map((face) => {
			if (!face.oracle_text) return null;
			return face.name ? `${face.name}\n${face.oracle_text}` : face.oracle_text;
		})
		.filter((text): text is string => !!text)
		.join("\n\n// \n\n");
	const faceWithStats = card.card_faces.find(
		(face) => face.power !== undefined || face.toughness !== undefined || face.loyalty !== undefined
	);
	const faces: CardTextFace[] = card.card_faces.map((face) => ({
		name: face.name ?? "",
		manaCost: face.mana_cost,
		typeLine: face.type_line,
		oracleText: face.oracle_text ?? "",
		power: face.power,
		toughness: face.toughness,
		loyalty: face.loyalty,
	}));
	return {
		oracleText,
		power: faceWithStats?.power,
		toughness: faceWithStats?.toughness,
		loyalty: faceWithStats?.loyalty,
		faces,
	};
}

// Images recto/verso d'une VRAIE carte double-face physique (transform,
// modal_dfc, reversible_card, double_faced_token — deux illustrations
// imprimées sur les deux faces d'une même carte), pour le bouton "flip" 3D
// sous l'image dans les 3 modales de détail. À NE PAS confondre avec les
// layouts split/adventure/flip/meld, qui ont eux aussi une card_faces[] non
// vide mais un seul visuel réellement imprimé (les "faces" y décrivent des
// composants textuels d'une même carte physique, ex. Fire // Ice ou Brazen
// Borrower/Petty Theft) — vérifié en direct sur /cards/named le 2026-08-16
// pour les 6 layouts concernés : une vraie carte double-face n'a JAMAIS
// image_uris au niveau racine (seulement sur chacune de ses 2 card_faces),
// alors que split/adventure/flip/meld ont TOUJOURS image_uris à la racine
// (et, pour split/adventure/flip, des card_faces SANS image_uris propre).
// C'est ce signal — racine sans image, les deux premières faces avec — qui
// distingue fiablement "il existe un vrai verso à révéler" du reste, sans
// avoir besoin du champ `layout` lui-même.
export interface DoubleFacedImages {
	front: string;
	back: string;
}

export function getDoubleFacedImages(card: ScryfallImmutableSnapshot): DoubleFacedImages | null {
	if (card.image_uris?.normal) return null;
	const faces = card.card_faces;
	if (!faces || faces.length < 2) return null;
	const front = faces[0].image_uris?.normal;
	const back = faces[1].image_uris?.normal;
	if (!front || !back) return null;
	return { front, back };
}

// Cartes "split" (Fire // Ice, Dusk // Dawn...), y compris la mécanique
// Aftermath (Never // Return) — fusionnée par Scryfall sous ce même layout
// "split", il n'existe plus de layout "aftermath" séparé (vérifié en direct
// sur /cards/named le 2026-08-17, pour les deux sous-cas). Contrairement aux
// vraies cartes double-face ci-dessus, il n'y a ici qu'UN SEUL visuel
// imprimé dont le texte est tourné à 90° dans le cadre — c'est donc
// l'AFFICHAGE qu'il faut tourner, pas un second visuel à révéler (voir
// setupSplitCardRotation, card-detail-fx.ts).
// Les deux sous-cas ont un comportement différent une fois tournés, d'où le
// besoin de les distinguer plutôt que de traiter tout layout "split" pareil :
// sur un split classique, les deux moitiés sont imprimées tournées dans le
// MÊME sens (confirmé en comparant les images réelles de Fire // Ice) — une
// seule rotation à 90° les rend donc TOUTES LES DEUX lisibles en même temps.
// Sur un split Aftermath, SEULE la seconde moitié est tournée (la première
// reste lisible en portrait — c'est celle qu'on lance normalement depuis la
// main, avant que la seconde ne devienne castable depuis le cimetière) :
// aucune rotation unique ne rend les deux lisibles à la fois, donc il n'y a
// pas d'orientation par défaut universellement correcte pour ce sous-cas —
// setupSplitCardRotation part donc de portrait pour celui-ci (première
// moitié déjà lisible sans manipulation), rotation manuelle uniquement.
// Détecté via keywords ∋ "Aftermath" plutôt qu'un nom de carte ou une
// heuristique de texte — confirmé en direct : présent au niveau racine de
// la carte (keywords: ["Aftermath"]), absent des faces elles-mêmes.
export interface SplitCardInfo {
	isAftermath: boolean;
}

export function getSplitCardInfo(card: ScryfallImmutableSnapshot): SplitCardInfo | null {
	if (card.layout !== "split") return null;
	return { isAftermath: !!card.keywords?.includes("Aftermath") };
}

export const SCRYFALL_HEADERS = {
	"User-Agent": "ObsidianMTGCollectionTracker/1.0 (+https://github.com/Louis1190/obsidian-mtg-collection-tracker)",
	Accept: "application/json;q=0.9,*/*;q=0.8",
};

export class ScryfallError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

let scryfallGateChain: Promise<void> = Promise.resolve();
// <10 requêtes/seconde avec une marge réelle (≈9 req/s max), pas seulement
// au ras de la limite documentée par Scryfall.
const SCRYFALL_MIN_GAP_MS = 110;

function reserveScryfallSlot(): Promise<void> {
	const slot = scryfallGateChain.then(() => sleep(SCRYFALL_MIN_GAP_MS));
	scryfallGateChain = slot;
	return slot;
}

export async function requestScryfall(params: RequestUrlParam): Promise<RequestUrlResponse> {
	await reserveScryfallSlot();
	const res = await requestUrl({ ...params, throw: false });
	if (res.status === 429) {
		const header = res.headers?.["retry-after"] ?? res.headers?.["Retry-After"];
		const seconds = header ? Number(header) : NaN;
		// Retry-After valide (secondes, borné à 5s pour ne jamais figer l'UI
		// trop longtemps) sinon un repli raisonnable — Scryfall n'envoie pas
		// toujours ce header malgré sa propre documentation.
		const waitMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 5000) : 2000;
		await sleep(waitMs);
	}
	return res;
}

// Résultat d'une recherche paginée — `hasMore` reflète le `has_more` brut de
// la réponse Scryfall (une page fait jusqu'à 175 cartes ; au-delà, une
// recherche large en a plus à offrir), `totalCards` son `total_cards`
// (nombre total de résultats de la recherche, toutes pages confondues — pas
// juste `cards.length`, qui ne compte que CETTE page). Utilisé par
// searchScryfall et fetchLatestPaperPrintings ci-dessous, tous deux paginés
// de la même façon via un paramètre `page` optionnel — un seul type de
// résultat partagé plutôt qu'un par fonction, puisque le call site
// (AddCardsModal, "Load more") traite les deux de façon interchangeable.
export interface ScryfallPagedResult {
	cards: ScryfallCard[];
	hasMore: boolean;
	totalCards: number;
}

// Corps JSON des réponses de recherche et d'erreur de Scryfall (`res.json` est `any` : on le type ici, une fois).
interface ScryfallListBody {
	data?: ScryfallCard[];
	has_more?: boolean;
	total_cards?: number;
}
interface ScryfallErrorBody {
	details?: string;
}

// order/dir : mêmes valeurs que le paramètre `order` de l'API Scryfall
// (ex. "usd" pour trier par prix). Sert aux suggestions "Price up"/"Price
// down" de AddCardsModal (add-cards-modal.ts) — quand fourni, prime sur le
// choix automatique (tri par édition si un filtre "set:" est actif, sinon
// par date de sortie) plutôt que de s'y ajouter : un tri explicitement
// choisi par l'utilisateur doit gagner sur l'heuristique par défaut.
// `page` (1-indexé, comme l'API Scryfall elle-même) sert au "Load more" de
// AddCardsModal — une recherche large peut dépasser les 175 résultats
// qu'une seule page Scryfall renvoie ; jamais transmis par les 2 call sites
// CSV import de plugin.ts, qui ne veulent toujours que le premier résultat
// d'un lookup par nom, donc reste implicitement à 1 (défaut) pour eux.
export async function searchScryfall(
	name: string,
	setCode: string,
	collectorNumber: string,
	chipQuery = "",
	sortOverride?: { order: string; dir: "asc" | "desc" },
	page = 1
): Promise<ScryfallPagedResult> {
	// Si un numéro de collector ET un set sont fournis, on peut interroger
	// directement l'endpoint "cards/{set}/{number}", exact et rapide — un
	// set+numéro identifie déjà une impression unique, donc les éventuelles
	// autres puces actives sont de toute façon redondantes dans ce cas.
	// Pas de pagination possible ici (une seule carte au plus) — page est
	// ignoré sur cette branche.
	if (setCode && collectorNumber) {
		const res = await requestScryfall({
			url: `https://api.scryfall.com/cards/${encodeURIComponent(
				setCode.toLowerCase()
			)}/${encodeURIComponent(collectorNumber)}`,
			headers: SCRYFALL_HEADERS,
			throw: false,
		});
		if (res.status === 200) {
			return { cards: [res.json as ScryfallCard], hasMore: false, totalCards: 1 };
		}
		if (res.status !== 404) {
			throw new ScryfallError(
				res.status,
				(res.json as ScryfallErrorBody | undefined)?.details ?? `Scryfall returned HTTP ${res.status}`
			);
		}
		// 404 sur cet endpoint exact -> on retombe sur la recherche classique
	}

	const parts: string[] = [];
	if (name) parts.push(name);
	if (setCode) parts.push(`set:${setCode}`);
	if (collectorNumber) parts.push(`cn:${collectorNumber}`);
	if (chipQuery) parts.push(chipQuery);

	if (parts.length === 0) return { cards: [], hasMore: false, totalCards: 0 };

	const fullQuery = parts.join(" ");
	// Quand un filtre d'édition est actif, trier par édition+numéro croissant
	// (la première carte du set en premier) est plus utile que le tri par
	// date de sortie par défaut — toutes les cartes d'une même édition
	// partagent de toute façon la même date.
	const hasSetFilter = /\b(set|s):\S+/i.test(fullQuery);
	const orderParams = sortOverride
		? `order=${sortOverride.order}&dir=${sortOverride.dir}`
		: hasSetFilter
		? "order=set&dir=asc"
		: "order=released";

	const query = encodeURIComponent(fullQuery);
	const pageParam = page > 1 ? `&page=${page}` : "";
	const res = await requestScryfall({
		url: `https://api.scryfall.com/cards/search?q=${query}&${orderParams}&unique=prints${pageParam}`,
		headers: SCRYFALL_HEADERS,
		throw: false,
	});

	if (res.status === 404) return { cards: [], hasMore: false, totalCards: 0 }; // aucune carte trouvée, réponse normale de Scryfall
	if (res.status !== 200) {
		throw new ScryfallError(
			res.status,
			(res.json as ScryfallErrorBody | undefined)?.details ?? `Scryfall returned HTTP ${res.status}`
		);
	}
	const data = res.json as ScryfallListBody;
	const cards = data.data ?? [];
	return {
		cards,
		hasMore: !!data.has_more,
		totalCards: typeof data.total_cards === "number" ? data.total_cards : cards.length,
	};
}

// Cartes les plus récemment sorties, en version papier uniquement (le
// plugin ne gère que les cartes physiques). Sert de contenu par défaut à
// l'ouverture de la recherche, avant que l'utilisateur ne tape quoi que ce
// soit — évite un champ de résultats vide qui grandirait d'un coup une fois
// la première recherche lancée. `page` — voir searchScryfall ci-dessus,
// même raisonnement/mécanisme.
export async function fetchLatestPaperPrintings(
	sortOverride?: { order: string; dir: "asc" | "desc" },
	page = 1
): Promise<ScryfallPagedResult> {
	const order = sortOverride?.order ?? "released";
	const dir = sortOverride?.dir ?? "desc";
	const query = encodeURIComponent("game:paper");
	const pageParam = page > 1 ? `&page=${page}` : "";
	const res = await requestScryfall({
		url: `https://api.scryfall.com/cards/search?q=${query}&order=${order}&dir=${dir}&unique=prints${pageParam}`,
		headers: SCRYFALL_HEADERS,
		throw: false,
	});
	if (res.status !== 200) return { cards: [], hasMore: false, totalCards: 0 };
	const body = res.json as ScryfallListBody;
	const cards = body.data ?? [];
	return {
		cards,
		hasMore: !!body.has_more,
		totalCards: typeof body.total_cards === "number" ? body.total_cards : cards.length,
	};
}

export function getImageUrl(card: ScryfallCard): string {
	if (card.image_uris?.normal) return card.image_uris.normal;
	if (card.card_faces?.[0]?.image_uris?.normal)
		return card.card_faces[0].image_uris.normal;
	if (card.image_uris?.small) return card.image_uris.small;
	return "";
}

// Juste l'illustration de la carte, sans le cadre ni le texte : bien mieux
// adapté à une image de fond (tuile de liste) qu'un scan de carte entière.
export function getArtCropUrl(card: ScryfallCard): string {
	if (card.image_uris?.art_crop) return card.image_uris.art_crop;
	if (card.card_faces?.[0]?.image_uris?.art_crop)
		return card.card_faces[0].image_uris.art_crop;
	return getImageUrl(card);
}

// Couleur du symbole d'édition selon la rareté, comme sur les vraies cartes /
// dans Delver : or pour rare, argent pour uncommon, blanc pour common.
export const RARITY_COLORS: Record<string, string> = {
	mythic: "#d9662b",
	rare: "#d4af37",
	uncommon: "#9fb4c7",
	common: "#ffffff",
	special: "#9fb4c7",
	bonus: "#d4af37",
};

export function getRarityColor(rarity: string): string {
	return RARITY_COLORS[rarity?.toLowerCase()] ?? "#ffffff";
}

// Toutes les impressions existantes d'une carte, par nom exact (`!"Nom"`),
// utilisé pour proposer un changement d'édition sur une carte déjà en
// collection (le physique peut appartenir à une autre édition que celle
// enregistrée par erreur, ou on veut simplement la changer).
export async function searchAllPrintings(name: string): Promise<ScryfallCard[]> {
	const query = encodeURIComponent(`!"${name}" unique:prints`);
	const res = await requestScryfall({
		url: `https://api.scryfall.com/cards/search?q=${query}&order=released&dir=desc`,
		headers: SCRYFALL_HEADERS,
		throw: false,
	});
	if (res.status !== 200) return [];
	return (res.json as ScryfallListBody).data ?? [];
}

// Applique une couleur à un SVG déjà inséré dans le DOM, directement sur
// chaque forme (path/circle/rect/polygon/g) plutôt que de compter sur
// `currentColor`, qui peut échouer selon la structure interne du SVG source
// (ex : fill défini sur un <g> parent plutôt que sur chaque <path>).
export function applySvgColor(container: HTMLElement, color: string) {
	container.style.color = color;
	container
		.querySelectorAll("path, circle, rect, polygon, ellipse, g")
		.forEach((el) => {
			(el as HTMLElement).style.fill = color;
		});
}

export function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

// Genres de set jugés "accessoires" plutôt que le produit principal — un
// symbole d'édition Scryfall est très souvent partagé entre l'expansion
// elle-même et ses propres tokens/promos/art series (vérifié en direct sur
// /sets : 987 éditions non-numériques, seulement 337 symboles distincts).
// Utilisé par dedupeSetsByIcon ci-dessous pour ne garder que l'entrée la
// plus "principale" par symbole, plutôt que de lister chaque variante
// séparément pour une icône visuellement identique (ListSettingsModal,
// "Choose icon", grille "Set Symbol").
const SET_TYPE_DEPRIORITIZED = new Set(["token", "memorabilia", "promo", "minigame"]);

// sets.icon_svg_uri sert de clé de regroupement ; un set sans icône connue
// (aucun cas réel trouvé au moment d'écrire ceci, mais l'API ne le garantit
// pas explicitement) retombe sur son propre code, jamais fusionné avec un
// autre. Ordre d'entrée préservé au sein de chaque groupe : l'entrée
// gagnante est la première "non accessoire" rencontrée, ou sinon la toute
// première tout court.
export function dedupeSetsByIcon(sets: ScryfallSetSummary[]): ScryfallSetSummary[] {
	const byIcon = new Map<string, ScryfallSetSummary>();
	sets.forEach((s) => {
		const key = s.icon_svg_uri ?? `code:${s.code}`;
		const existing = byIcon.get(key);
		if (!existing) {
			byIcon.set(key, s);
			return;
		}
		if (SET_TYPE_DEPRIORITIZED.has(existing.set_type) && !SET_TYPE_DEPRIORITIZED.has(s.set_type)) {
			byIcon.set(key, s);
		}
	});
	return Array.from(byIcon.values());
}

// Regroupement de haut niveau de la grille "Set Symbol" (ListSettingsModal,
// "Choose icon") — demandé sur le modèle de la page de référence Keyrune
// (https://keyrune.andrewgioia.com/icons.html, 16 catégories), mais dérivé
// du champ set_type de Scryfall plutôt que copié tel quel : Keyrune tient sa
// propre liste à la main, set par set, ce qui casserait la mise à jour 100%
// automatique déjà en place ici (un nouveau set tombe dans le bon groupe
// tout seul via son set_type, sans qu'aucun code n'ait besoin d'être
// modifié). 9 groupes plutôt que les 16 de Keyrune — plusieurs de ses
// catégories (ex. "Global Series", "Guild Kits") n'existent pas comme
// set_type distinct et ne seraient donc dérivables qu'à la main. Les 22
// valeurs de set_type réellement observées sur /sets (vérifié en direct)
// sont toutes couvertes ci-dessous.
const SET_TYPE_GROUPS: { label: string; types: string[] }[] = [
	{ label: "Core sets", types: ["core"] },
	{ label: "Expansion sets", types: ["expansion"] },
	{ label: "Commander & multiplayer", types: ["commander", "planechase", "archenemy", "vanguard", "arsenal"] },
	{
		label: "Draft innovations & masters",
		types: ["masters", "draft_innovation", "duel_deck", "from_the_vault", "premium_deck", "spellbook"],
	},
	{ label: "Starter & box sets", types: ["starter", "box"] },
	{ label: "Masterpiece series", types: ["masterpiece"] },
	{ label: "Promos & tokens", types: ["promo", "token", "memorabilia"] },
	{ label: "Minigames & other", types: ["minigame", "eternal"] },
	{ label: "Un-Sets", types: ["funny"] },
];

// Repli explicite pour un set_type non couvert ci-dessus (une nouvelle
// catégorie que Scryfall introduirait après l'écriture de ce fichier) —
// affiché dans son propre groupe "Other" plutôt qu'exclu silencieusement de
// la grille.
export function getSetGroupLabel(setType: string): string {
	const found = SET_TYPE_GROUPS.find((g) => g.types.includes(setType));
	return found ? found.label : "Other";
}

// Ordre d'affichage des groupes dans la grille — "Other" toujours en
// dernier, pour le même repli que ci-dessus.
export const SET_GROUP_ORDER: string[] = [...SET_TYPE_GROUPS.map((g) => g.label), "Other"];

// Nettoyage minimal du SVG avant sa mise en cache / son insertion dans le DOM — utilisé
// aussi bien pour l'icône personnalisable du ruban (customIconSvg, saisie
// libre) que pour les SVG d'édition/symbole récupérés chez Scryfall
// (fetchSetIconSvg/fetchManaSymbolSvg, plugin.ts). Retire :
// - les balises <script> ;
// - les attributs de gestion d'évènements (onclick, onload…) ;
// - les URIs javascript:/data: dans href/xlink:href (ex. <a href="javascript:
//   ...">, <use href="data:image/svg+xml;base64,...">) — un <script>-less SVG
//   peut quand même exécuter du code via ces attributs ;
// - <foreignObject> (peut embarquer du HTML/JS arbitraire dans un contexte
//   SVG) et les balises d'animation SMIL (<animate>/<set>/<animateTransform>/
//   <animateMotion>), un vecteur XSS SVG historique via leurs attributs
//   values/to/from.
// Reste un nettoyage par regex, pas une garantie : la vraie barrière est
// setSvgMarkup (ui/svg-markup.ts), qui reconstruit le DOM à partir d'une liste
// d'autorisations et ne laisse donc passer ni <script>, ni attribut on*, ni
// href, quoi que ce nettoyage ait laissé. Il reste utile en amont : ce qui est
// mis en cache sur disque est déjà propre.
export function sanitizeSvg(svg: string): string {
	let clean = svg.replace(/<script[\s\S]*?<\/script>/gi, "");
	clean = clean.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
	clean = clean.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
	clean = clean.replace(/\s(?:xlink:)?href\s*=\s*"\s*(?:javascript|data):[^"]*"/gi, "");
	clean = clean.replace(/\s(?:xlink:)?href\s*=\s*'\s*(?:javascript|data):[^']*'/gi, "");
	clean = clean.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
	clean = clean.replace(/<(animate|animatetransform|animatemotion|set)\b[^>]*\/?>(?:[\s\S]*?<\/\1>)?/gi, "");
	return clean;
}

// Parseur CSV "RFC 4180" minimal : gère les champs entre guillemets contenant
// des virgules, des retours à la ligne et des guillemets échappés ("").
// Nécessaire car les exports Delver contiennent du texte de règles multi-lignes.
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let i = 0;
	const len = text.length;

	while (i < len) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
				} else {
					inQuotes = false;
					i++;
				}
			} else {
				field += ch;
				i++;
			}
		} else if (ch === '"') {
			inQuotes = true;
			i++;
		} else if (ch === ",") {
			row.push(field);
			field = "";
			i++;
		} else if (ch === "\r") {
			i++;
		} else if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
		} else {
			field += ch;
			i++;
		}
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

// Échappe un champ pour l'export CSV (downloadListCsv/downloadWantlistCsv,
// view.ts) : double les guillemets internes (RFC 4180, symétrique de
// parseCsv ci-dessus) ET protège contre l'injection de formule CSV (CWE-1236)
// — un champ dont le PREMIER caractère est =, +, -, @, tab ou CR est
// interprété comme une formule par Excel/LibreOffice/Google Sheets à
// l'ouverture, pas comme du texte. La plupart des colonnes exportées ici
// viennent de Scryfall (jamais de risque), mais "Custom Price"/"Grading
// Label" sont du texte librement tapé — un préfixe apostrophe (convention
// standard OWASP/GitHub pour ce problème) neutralise la formule tout en
// restant invisible à l'affichage dans un tableur.
const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r]/;
export function toCsvField(value: string): string {
	const escaped = value.replace(/"/g, '""');
	const defanged = CSV_FORMULA_TRIGGER.test(escaped) ? `'${escaped}` : escaped;
	return `"${defanged}"`;
}

// Récupère en un minimum de requêtes les données à jour (image, prix) pour un
// lot d'identifiants Scryfall via l'endpoint /cards/collection (75 max/appel).
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function fetchScryfallCollection(
	ids: string[],
	onProgress?: (msg: string) => void,
	// Appelé après CHAQUE lot de 75 avec uniquement les cartes de ce lot —
	// ajouté pour MTGCollectionPlugin.bulkFetchLegalities (voir ce fichier),
	// dont un bug rapporté ("la légalité ne s'affiche qu'une fois tout le
	// fetch terminé") venait exactement d'ici : sans ce callback, un
	// appelant qui dérive une Promise par id à partir de la seule Promise
	// renvoyée par cette fonction voit TOUS ses ids résolus seulement au
	// tout dernier lot, même ceux dont les données sont arrivées dans le
	// premier — sur une collection de ~10k cartes (134 lots, ~120ms de
	// pause entre chacun), ça peut représenter plusieurs dizaines de
	// secondes d'attente pour rien. Optionnel et sans effet sur les autres
	// appelants existants (refreshAllPrices, getCardLegalities…), qui ne le
	// passent pas.
	onChunkResolved?: (chunkResults: Map<string, ScryfallCard>) => void
): Promise<Map<string, ScryfallCard>> {
	const map = new Map<string, ScryfallCard>();
	const chunks = chunk(ids, 75);
	for (let i = 0; i < chunks.length; i++) {
		onProgress?.(`Fetching card data… batch ${i + 1}/${chunks.length}`);
		const res = await requestScryfall({
			url: "https://api.scryfall.com/cards/collection",
			method: "POST",
			headers: { ...SCRYFALL_HEADERS, "Content-Type": "application/json" },
			body: JSON.stringify({
				identifiers: chunks[i].map((id) => ({ id })),
			}),
			throw: false,
		});
		const chunkMap = new Map<string, ScryfallCard>();
		if (res.status === 200) {
			const data = res.json as { data: ScryfallCard[] };
			data.data.forEach((c) => {
				map.set(c.id, c);
				chunkMap.set(c.id, c);
			});
		}
		onChunkResolved?.(chunkMap);
		// Petite pause entre les lots : bonne pratique demandée par Scryfall
		// (50-100ms minimum entre requêtes), sans effet perceptible puisque tout
		// ça tourne en arrière-plan.
		if (i < chunks.length - 1) await sleep(120);
	}
	return map;
}
