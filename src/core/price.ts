import { CollectionCard, WantlistCard, Finish } from "./card-model";
import type { ScryfallCard } from "../api/scryfall";
import type { CollectionList, Wantlist, ListIcon } from "./data-model";
import { LEGALITY_SEARCH_FORMATS } from "./card-search";

export interface ListGroup {
	id: string;
	name: string;
	cards: CollectionCard[];
	totalQty: number;
	totalValue: number;
	coverImage: string;
	// Voir CollectionList.listIcon (data-model.ts) — simple passe-plat,
	// jamais résolu ici (ce module n'a pas accès à Scryfall/au plugin).
	icon?: ListIcon;
}

// Les trois "sources" de prix réellement disponibles chez Scryfall (voir
// discussion : Scryfall n'expose qu'un seul chiffre par devise/finition,
// contrairement à des services comme Delver Lens qui agrègent plusieurs
// sources par devise - TCGPlayer Low/Mid/High, CardKingdom, etc.).
export type PriceCurrency = "usd" | "eur";

export const CURRENCY_LABELS: Record<PriceCurrency, { name: string; symbol: string }> = {
	usd: { name: "USD ($)", symbol: "$" },
	eur: { name: "EUR (€)", symbol: "€" },
};

// Sous-ensemble de champs utilisé par les calculs de prix ci-dessous : aussi
// bien CollectionCard que WantlistCard le satisfont, pas besoin de dupliquer
// cette logique pour la wantlist.
export interface PricedCard {
	finish: Finish;
	priceUsd: string;
	priceUsdFoil: string;
	priceEur: string;
	priceEurFoil: string;
	priceUsdEtched: string;
	priceEurEtched: string;
	count: number;
}

// Renvoie le prix brut (chaîne) pour une carte, selon la devise choisie et sa
// finition — utilise bien usd_foil/eur_foil pour une carte foiled, ou
// usd_etched/eur_etched pour une carte etched (repli sur le prix non-foil si
// cette carte n'a pas d'impression etched connue chez Scryfall), plutôt que
// le prix non-foil par erreur. Surge Foil (surged) n'a PAS de champs de prix
// dédiés côté Scryfall (pas de usd_surge/eur_surge dans leur API, contrairement
// à etched) — chaque impression surge foil est son propre objet carte chez
// Scryfall, disponible en foil seulement pour cette impression précise, donc
// son prix se trouve déjà dans les champs foil habituels : traité comme
// "foiled" ici plutôt que comme "etched" (pas de repli séparé nécessaire).
// Une carte Proxy n'a pas de prix : ce n'est pas un objet réellement possédé/
// échangeable, elle ne doit pas peser dans la valeur totale de la collection.
// Pas de repli silencieux vers une autre devise : si le prix demandé est
// absent, on renvoie "" (plutôt que d'afficher un chiffre trompeur venant
// d'une autre devise).
export function getRawCardPrice(card: PricedCard, currency: PriceCurrency): string {
	if (card.finish === "proxy") return "";
	if (card.finish === "etched") {
		const etched = currency === "eur" ? card.priceEurEtched : card.priceUsdEtched;
		if (etched) return etched;
		return (currency === "eur" ? card.priceEur : card.priceUsd) || "";
	}
	const usesFoilPrice = card.finish === "foiled" || card.finish === "surged";
	if (currency === "eur") return (usesFoilPrice ? card.priceEurFoil : card.priceEur) || "";
	return (usesFoilPrice ? card.priceUsdFoil : card.priceUsd) || card.priceUsd || "";
}

export function getCardPriceNumber(card: PricedCard, currency: PriceCurrency): number {
	return parseFloat(getRawCardPrice(card, currency)) || 0;
}

export function formatCardPrice(card: PricedCard, currency: PriceCurrency): string {
	const raw = getRawCardPrice(card, currency);
	if (!raw) return "—";
	return `${CURRENCY_LABELS[currency].symbol}${raw}`;
}

export function cardValue(card: PricedCard, currency: PriceCurrency = "usd"): number {
	return getCardPriceNumber(card, currency) * card.count;
}

// Construit un PricedCard depuis une DeckCard (2026-09-02) — DeckCard.finish/
// priceUsd/etc. sont tous optionnels (voir son propre commentaire, data-
// model.ts : un modèle de données déjà mature, rattrapé une fois pour les
// entrées existantes plutôt que garanti présent dès le départ), donc ne
// satisfont pas structurellement PricedCard (finish/priceUsd/etc. non-
// optionnels) sans ce petit repli — même "Regular"/chaîne vide que
// getDeckCardFinish/etc. (data-model.ts) pour un champ pas encore rattrapé.
// Une fois ce PricedCard construit, getRawCardPrice/formatCardPrice/
// cardValue s'appliquent à une carte de deck exactement comme à une
// CollectionCard/WantlistCard — même gestion etched/surged/proxy, sans
// logique dupliquée.
export function toDeckPricedCard(card: {
	finish?: Finish;
	priceUsd?: string;
	priceUsdFoil?: string;
	priceEur?: string;
	priceEurFoil?: string;
	priceUsdEtched?: string;
	priceEurEtched?: string;
	count: number;
}): PricedCard {
	return {
		finish: card.finish ?? "regular",
		priceUsd: card.priceUsd ?? "",
		priceUsdFoil: card.priceUsdFoil ?? "",
		priceEur: card.priceEur ?? "",
		priceEurFoil: card.priceEurFoil ?? "",
		priceUsdEtched: card.priceUsdEtched ?? "",
		priceEurEtched: card.priceEurEtched ?? "",
		count: card.count,
	};
}

export const LEGALITY_FORMATS: { key: string; label: string }[] = LEGALITY_SEARCH_FORMATS;

// Formate un montant déjà calculé (ex. une somme totale), contrairement à
// formatCardPrice qui lit le prix brut d'une carte précise.
export function formatMoney(amount: number, currency: PriceCurrency): string {
	return `${CURRENCY_LABELS[currency].symbol}${amount.toFixed(2)}`;
}

// Variation signée ("+€2.50" / "-$1.05"), pour un écart de prix plutôt qu'un
// montant absolu — le signe passe AVANT le symbole (convention courante pour
// une variation), et un écart nul s'affiche "+€0.00", jamais "-€0.00" (le
// signe vient du montant arrondi, pas d'un -0 flottant).
export function formatSignedMoney(amount: number, currency: PriceCurrency): string {
	const rounded = Math.abs(amount).toFixed(2);
	const sign = amount < 0 && parseFloat(rounded) !== 0 ? "-" : "+";
	return `${sign}${CURRENCY_LABELS[currency].symbol}${rounded}`;
}

// Même principe que formatCardPrice, mais pour un résultat de recherche brut
// (pas encore une CollectionCard) — utilisé dans les aperçus avant ajout.
export function formatScryfallPrice(card: ScryfallCard, currency: PriceCurrency): string {
	const raw = currency === "eur" ? card.prices?.eur : card.prices?.usd;
	if (!raw) return "";
	return `${CURRENCY_LABELS[currency].symbol}${raw}`;
}

// Règle de couverture d'une liste : vide -> pas d'image, 1 carte -> son
// illustration, 2 cartes ou plus -> l'illustration de la carte la plus chère
// (prix unitaire). On utilise l'illustration seule (art_crop) plutôt que le
// scan de carte entière, bien mieux adaptée à un fond de tuile.
export function pickCoverImage(cards: { artCropUrl: string; imageUrl: string; priceUsd: string }[]): string {
	if (cards.length === 0) return "";
	if (cards.length === 1) return cards[0].artCropUrl || cards[0].imageUrl;
	const mostExpensive = [...cards].sort(
		(a, b) => (parseFloat(b.priceUsd || "0") || 0) - (parseFloat(a.priceUsd || "0") || 0)
	)[0];
	return mostExpensive.artCropUrl || mostExpensive.imageUrl || cards[0].artCropUrl || cards[0].imageUrl;
}

// Même règle que pickCoverImage ci-dessus, sauf qu'un choix manuel
// (CollectionList.coverCardId, "Choose cover image" de ListSettingsModal)
// gagne s'il pointe encore vers une carte réellement présente dans la
// liste — sinon (carte déplacée/supprimée depuis) repli silencieux sur
// l'auto-sélection habituelle plutôt qu'une image cassée ou une exception.
export function resolveCoverImage(
	cards: { id: string; artCropUrl: string; imageUrl: string; priceUsd: string }[],
	coverCardId?: string
): string {
	if (coverCardId) {
		const chosen = cards.find((c) => c.id === coverCardId);
		if (chosen) return chosen.artCropUrl || chosen.imageUrl;
	}
	return pickCoverImage(cards);
}

// Même principe que pickCoverImage ci-dessus, mais pour un Deck : repli sur
// la Commander du deck si elle en a une (concept idiomatique pour un deck
// Commander/EDH — voir isDeckCommander, data-model.ts) plutôt que "la
// carte la plus chère" comme pickCoverImage, sinon la première carte du
// deck (ordre d'ajout). DeckCard porte désormais un vrai prix persisté
// (2026-09-02, voir "Data model notes", CLAUDE.md), donc "la carte la plus
// chère" serait maintenant calculable ici sans aller-retour réseau — mais
// ce repli-Commander reste délibéré, pas une limitation technique : plus
// idiomatique pour un deck, et pas remis en cause par le seul fait que le
// prix soit désormais disponible. Lit deckFunctionOverride directement
// (pas isDeckCommander/getDeckCardFunction, data-model.ts) plutôt que
// d'élargir cette interface déjà volontairement étroite avec typeLine/
// oracleText/keywords — Commander n'existe de toute façon jamais QUE via
// cette désignation manuelle (voir son propre commentaire), jamais via la
// détection automatique/le repli type de carte.
export function pickDeckCoverImage(
	cards: { artCropUrl: string; imageUrl: string; deckFunctionOverride?: string }[]
): string {
	if (cards.length === 0) return "";
	const commander = cards.find((c) => c.deckFunctionOverride === "Commander");
	const chosen = commander ?? cards[0];
	return chosen.artCropUrl || chosen.imageUrl;
}

// Même principe que resolveCoverImage ci-dessus — un choix manuel
// (Deck.coverCardId, "Choose cover image" de DeckSettingsModal) gagne s'il
// pointe encore vers une carte réellement présente dans le deck, identifiée
// par scryfallId (DeckCard n'a pas de champ id propre) plutôt que par id
// comme pour une liste.
export function resolveDeckCoverImage(
	cards: { scryfallId: string; artCropUrl: string; imageUrl: string; deckFunctionOverride?: string }[],
	coverCardId?: string
): string {
	if (coverCardId) {
		const chosen = cards.find((c) => c.scryfallId === coverCardId);
		if (chosen) return chosen.artCropUrl || chosen.imageUrl;
	}
	return pickDeckCoverImage(cards);
}

export function groupByList(
	lists: CollectionList[],
	collection: CollectionCard[],
	currency: PriceCurrency = "usd"
): ListGroup[] {
	return lists
		.map((list) => {
			const cards = collection.filter((c) => c.listId === list.id);
			return {
				id: list.id,
				name: list.name,
				cards,
				totalQty: cards.reduce((s, c) => s + c.count, 0),
				totalValue: cards.reduce((s, c) => s + cardValue(c, currency), 0),
				coverImage: resolveCoverImage(cards, list.coverCardId),
				icon: list.listIcon,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export interface WantlistGroup {
	id: string;
	name: string;
	cards: WantlistCard[];
	totalQty: number;
	totalValue: number;
	coverImage: string;
	// Voir ListGroup.icon ci-dessus — même passe-plat, côté wantlist.
	icon?: ListIcon;
}

export function groupByWantlist(
	wantlists: Wantlist[],
	wantlistCards: WantlistCard[],
	currency: PriceCurrency = "usd"
): WantlistGroup[] {
	return wantlists
		.map((wantlist) => {
			const cards = wantlistCards.filter((c) => c.listId === wantlist.id);
			return {
				id: wantlist.id,
				name: wantlist.name,
				cards,
				totalQty: cards.reduce((s, c) => s + c.count, 0),
				totalValue: cards.reduce((s, c) => s + cardValue(c, currency), 0),
				coverImage: resolveCoverImage(cards, wantlist.coverCardId),
				icon: wantlist.listIcon,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}
