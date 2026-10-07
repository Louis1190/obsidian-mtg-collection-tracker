import { DeckCard, getDeckCardCategory } from "./data-model";
import { COLOR_NAMES, GROUP_LABEL_HEX, MAIN_TYPES, RARITY_ORDER, isLand, primaryType } from "./card-sorting";

/* -------------------------------------------------------------------------- */
/*  Deck stats (2026-09-02) — vue "Stats" de My Decks (mana curve/couleurs/  */
/*  types), voir renderDeckStats (view.ts) + deck-stats-fx.ts (dessin SVG). */
/*  Pur/testable : aucune dépendance à Obsidian ou au DOM, comme le reste de */
/*  src/core/.                                                              */
/* -------------------------------------------------------------------------- */

// "Le deck réellement joué" — Mainboard, PAS Sideboard/Maybeboard (des
// cartes "pas dans le deck" par définition, voir DeckCardCategory,
// data-model.ts). Même convention que Moxfield/Archidekt pour leurs
// propres pages de statistiques. Ne teste plus explicitement "ou
// Commander" depuis le 2026-09-07 : Commander est devenu une Function, pas
// une catégorie (voir isDeckCommander) — une carte Commander est déjà,
// structurellement, catégorisée "mainboard" comme n'importe quelle autre
// carte du deck principal.
export function cardsInDeckStatsScope(cards: DeckCard[]): DeckCard[] {
	return cards.filter((c) => getDeckCardCategory(c) === "mainboard");
}

export interface ManaCurveBucket {
	cmc: number; // 0-6, ou 7 pour le bac "7+"
	label: string;
	count: number;
}

// Exclut les terrains (CMC 0 par nature — les compter fausserait complètement
// la courbe) et regroupe tout ce qui dépasse 6 dans un bac "7+" — mêmes deux
// conventions déjà établies par tout deck-builder usuel (Moxfield/
// Archidekt). Pondéré par card.count (le nombre d'exemplaires), pas par
// nombre d'entrées distinctes — une carte à 3 exemplaires compte 3 fois,
// cohérent avec "la courbe du deck tel qu'il sera réellement pioché".
export function computeManaCurve(cards: DeckCard[]): ManaCurveBucket[] {
	const buckets = new Map<number, number>();
	for (let i = 0; i <= 7; i++) buckets.set(i, 0);
	cards.forEach((c) => {
		if (isLand(c.typeLine)) return;
		const cmc = Math.min(7, Math.max(0, Math.round(c.manaValue ?? 0)));
		buckets.set(cmc, (buckets.get(cmc) ?? 0) + c.count);
	});
	return Array.from(buckets.entries()).map(([cmc, count]) => ({
		cmc,
		label: cmc === 7 ? "7+" : String(cmc),
		count,
	}));
}

export interface ColorSlice {
	label: string;
	color: string;
	count: number;
}

// Ordre canonique d'affichage (légende + camembert) — WUBRG puis Multicolor/
// Colorless/Land, jamais trié par nombre décroissant : un ordre fixe reste
// lisible/comparable d'un rendu à l'autre, contrairement à un ordre qui se
// réorganiserait selon le contenu du deck.
const COLOR_SLICE_ORDER = ["White", "Blue", "Black", "Red", "Green", "Multicolor", "Colorless", "Land"];

// Bucketing DÉLIBÉRÉMENT différent de colorGroupLabel (card-sorting.ts, qui
// sous-classe chaque combinaison multicolore exacte, ex. "Green/Red" — bien
// adapté à un en-tête de groupe, mais donnerait un camembert avec autant de
// fines pointes que de paires de couleurs présentes dans le deck) : ici,
// TOUTE carte 2+ couleurs tombe dans un seul bac "Multicolor", comme le fait
// le camembert "Color Breakdown" de Moxfield lui-même. Les terrains gardent
// leur propre bac "Land" (pas exclus, contrairement à computeManaCurve
// ci-dessus) — "quelle proportion du deck est incolore/mono/multi/terrain"
// est une question différente de "quelle est la courbe de coût des sorts".
function colorPieLabel(card: { colors: string[]; typeLine: string }): string {
	if (isLand(card.typeLine)) return "Land";
	const colors = card.colors ?? [];
	if (colors.length === 0) return "Colorless";
	if (colors.length === 1) return COLOR_NAMES[colors[0]] ?? "Colorless";
	return "Multicolor";
}

// Interface volontairement plus étroite que DeckCard — computeColorBreakdown
// ne lit que ces 3 champs, tout aussi présents sur CollectionCard/
// WantlistCard (core/types.ts). Élargi le 2026-09-23 : Home
// (home-render.ts, bloc "By Color") réutilise cette même fonction sur la
// collection entière plutôt que d'en dupliquer une copie scoped à
// DeckCard — DeckCard continue de la satisfaire sans aucun changement à
// ses propres call sites (deck-stats-modal.ts).
export interface ColorBreakdownCard {
	colors: string[];
	typeLine: string;
	count: number;
}

export function computeColorBreakdown(cards: ColorBreakdownCard[]): ColorSlice[] {
	const counts = new Map<string, number>();
	cards.forEach((c) => {
		const label = colorPieLabel(c);
		counts.set(label, (counts.get(label) ?? 0) + c.count);
	});
	return COLOR_SLICE_ORDER.filter((label) => (counts.get(label) ?? 0) > 0).map((label) => ({
		label,
		count: counts.get(label) ?? 0,
		color: GROUP_LABEL_HEX[label] ?? "#9a9a9a",
	}));
}

export interface TypeSlice {
	label: string;
	count: number;
}

// primaryType (card-sorting.ts) range déjà chaque ligne de type sous UN SEUL
// type principal (Creature/Instant/Land/etc., voir MAIN_TYPES) — réutilisé
// tel quel plutôt que réinventé, même logique déjà utilisée par "Group by
// Type" ailleurs dans ce plugin. Trié par nombre décroissant (contrairement
// au camembert de couleurs ci-dessus) : ici il n'existe pas d'ordre canonique
// "attendu" comme WUBRG, du plus représenté au moins représenté est ce qui
// se lit le mieux sur un diagramme en barres horizontales.
export function computeTypeBreakdown(cards: DeckCard[]): TypeSlice[] {
	const counts = new Map<string, number>();
	cards.forEach((c) => {
		const type = primaryType(c.typeLine);
		counts.set(type, (counts.get(type) ?? 0) + c.count);
	});
	return Array.from(counts.entries())
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count || MAIN_TYPES.indexOf(a.label) - MAIN_TYPES.indexOf(b.label));
}

// Petit total pratique pour l'en-tête de la vue Stats (view.ts) — même
// pondération par card.count que les 3 fonctions ci-dessus.
export function totalStatsCardCount(cards: DeckCard[]): number {
	return cards.reduce((s, c) => s + c.count, 0);
}

/* -------------------------------------------------------------------------- */
/*  Le reste de ce fichier (2026-09-23) sert Home's "Insights" (par rareté/  */
/*  decks à surveiller — home-render.ts), pas My Decks' propre vue Stats.    */
/*  Toujours pur/testable, dans le même esprit que le reste de ce module.    */
/* -------------------------------------------------------------------------- */

const RARITY_LABELS: Record<string, string> = {
	common: "Common",
	uncommon: "Uncommon",
	rare: "Rare",
	mythic: "Mythic",
	special: "Special",
	bonus: "Bonus",
};

// Palette délibérément différente de RARITY_COLORS (api/scryfall.ts) :
// cette dernière colore un petit symbole d'édition (blanc pour "common",
// cohérent sur une icône fine avec son propre contour) — un "common" blanc
// sur une tranche de camembert PLEINE (ou, depuis 2026-09-23, un mot en
// couleur plein comme le libellé de rareté de CardPreviewModal) serait
// invisible en thème clair. Gris neutre ici à la place ; argent/or/orange
// repris tels quels, ces teintes-là restant lisibles en plein. Exportée
// (renommée depuis RARITY_PIE_COLORS le même jour) pour ce second
// consommateur — le nom d'origine, scopé au camembert, ne décrivait plus
// vraiment ce que la constante fait réellement : "une couleur de rareté
// lisible en aplat", pas seulement "en tranche de camembert".
export const RARITY_SOLID_COLORS: Record<string, string> = {
	common: "#9a9a9a",
	uncommon: "#9fb4c7",
	rare: "#d4af37",
	mythic: "#d9662b",
	special: "#9fb4c7",
	bonus: "#d4af37",
};

export interface RarityBreakdownCard {
	rarity: string;
	count: number;
}

// Trié par RARITY_ORDER (card-sorting.ts, déjà la même table utilisée par
// "Sort by Rarity" ailleurs dans ce plugin) plutôt que par nombre
// décroissant comme computeTypeBreakdown — ici, comme pour les couleurs
// plus haut, un ordre canonique (commun → mythique) reste plus lisible
// qu'un ordre qui se réorganiserait selon le contenu de la collection.
// Renvoie ColorSlice (pas un nouveau type "RaritySlice") : même forme
// exacte ({label, color, count}), donc renderColorPieChart (deck-stats-fx.ts)
// se réutilise tel quel, sans un second dessinateur de camembert redondant.
export function computeRarityBreakdown(cards: RarityBreakdownCard[]): ColorSlice[] {
	const counts = new Map<string, number>();
	cards.forEach((c) => {
		const key = (c.rarity || "common").toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + c.count);
	});
	return Array.from(counts.entries())
		.sort((a, b) => (RARITY_ORDER[a[0]] ?? 0) - (RARITY_ORDER[b[0]] ?? 0))
		.map(([key, count]) => ({
			label: RARITY_LABELS[key] ?? key,
			count,
			color: RARITY_SOLID_COLORS[key] ?? "#9a9a9a",
		}));
}

// Seuil "probablement pas fini" pour le bloc Home "Decks to Finish" —
// délibérément une heuristique à 2 paliers (Commander-like = 100, tout le
// reste = 60), PAS un moteur de légalité par format complet (Oathbreaker=60
// mais avec ses propres règles de sideboard, Tiny Leaders=50, Gladiator=100
// existent aussi mais sont rares dans l'usage réel de ce plugin) — un
// simple signal "à surveiller", pas une vérification de légalité (voir
// déjà legal:/banned:/restricted:, card-search.ts, pour une vraie
// vérification). Format absent = 60 (le cas par défaut le plus courant).
const COMMANDER_LIKE_FORMATS = new Set(["commander", "duel", "paupercommander", "predh"]);

export function deckMinimumSize(format: string | undefined): number {
	return format && COMMANDER_LIKE_FORMATS.has(format) ? 100 : 60;
}

export interface DeckSizeStatus {
	mainboardCount: number;
	minimum: number;
	isBelowMinimum: boolean;
}

// Compte le SCOPE mainboard (cardsInDeckStatsScope, plus haut dans ce
// fichier — exclut sideboard/maybeboard) contre deckMinimumSize(format)
// ci-dessus — même pondération par count que le reste de ce fichier.
export function getDeckSizeStatus(deck: { format?: string; cards: DeckCard[] }): DeckSizeStatus {
	const mainboardCount = totalStatsCardCount(cardsInDeckStatsScope(deck.cards));
	const minimum = deckMinimumSize(deck.format);
	return { mainboardCount, minimum, isBelowMinimum: mainboardCount < minimum };
}
