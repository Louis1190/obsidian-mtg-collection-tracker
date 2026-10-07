import { fetchScryfallCollection } from "../api/scryfall";
import { VIEW_TYPE_MTG_COLLECTION } from "../core/data-model";
import { PricedCard } from "../core/price";
import type MTGCollectionPlugin from "../plugin";
import { MTGCollectionView } from "../view";

/* ---------------------------------------------------------------------------- */
/*  Rafraîchissement des prix stockés des cartes, manuel et automatique (MTGCollectionPlugin).*/
/* ---------------------------------------------------------------------------- */

export const MANUAL_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
export async function refreshAllPrices(this: MTGCollectionPlugin, 
	onProgress?: (msg: string) => void,
	options: { respectCooldown?: boolean } = {}
): Promise<{ updated: number; skipped?: boolean; retryInMs?: number }> {
	if (options.respectCooldown) {
		const elapsed = Date.now() - this.settings.lastPriceRefresh;
		if (elapsed < MANUAL_REFRESH_COOLDOWN_MS) {
			return {
				updated: 0,
				skipped: true,
				retryInMs: MANUAL_REFRESH_COOLDOWN_MS - elapsed,
			};
		}
	}

	// Decks inclus depuis 2026-09-02 (voir DeckCard.priceUsd/etc.,
	// data-model.ts) — un même id compte pour un seul aller-retour, même
	// s'il apparaît à la fois en collection, en wantlist ET dans un ou
	// plusieurs decks.
	const deckCards = this.settings.decks.flatMap((d) => d.cards);
	const uniqueIds = Array.from(
		new Set(
			[...this.settings.collection, ...this.settings.wantlist, ...deckCards]
				.filter((c) => c.scryfallId)
				.map((c) => c.scryfallId)
		)
	);
	if (uniqueIds.length === 0) return { updated: 0 };

	const priceMap = await fetchScryfallCollection(uniqueIds, onProgress);
	let updated = 0;
	const applyPrices = (c: PricedCard & { scryfallId: string }) => {
		const scry = priceMap.get(c.scryfallId);
		if (!scry) return;
		const newUsd = scry.prices?.usd ?? "";
		const newUsdFoil = scry.prices?.usd_foil ?? "";
		const newEur = scry.prices?.eur ?? "";
		const newEurFoil = scry.prices?.eur_foil ?? "";
		const newUsdEtched = scry.prices?.usd_etched ?? "";
		const newEurEtched = scry.prices?.eur_etched ?? "";
		if (
			newUsd !== c.priceUsd ||
			newUsdFoil !== c.priceUsdFoil ||
			newEur !== c.priceEur ||
			newEurFoil !== c.priceEurFoil ||
			newUsdEtched !== c.priceUsdEtched ||
			newEurEtched !== c.priceEurEtched
		) {
			updated++;
		}
		c.priceUsd = newUsd;
		c.priceUsdFoil = newUsdFoil;
		c.priceEur = newEur;
		c.priceEurFoil = newEurFoil;
		c.priceUsdEtched = newUsdEtched;
		c.priceEurEtched = newEurEtched;
	};
	this.settings.collection.forEach(applyPrices);
	this.settings.wantlist.forEach(applyPrices);
	// DeckCard n'affecte pas directement via applyPrices ci-dessus : ses 6
	// champs sont optionnels (voir son propre commentaire, data-model.ts),
	// donc ne satisfont pas structurellement PricedCard (qui les exige
	// non-optionnels) — même valeurs, simplement écrites à la main plutôt
	// que via cette fonction générique.
	deckCards.forEach((c) => {
		const scry = priceMap.get(c.scryfallId);
		if (!scry) return;
		const newUsd = scry.prices?.usd ?? "";
		const newUsdFoil = scry.prices?.usd_foil ?? "";
		const newEur = scry.prices?.eur ?? "";
		const newEurFoil = scry.prices?.eur_foil ?? "";
		const newUsdEtched = scry.prices?.usd_etched ?? "";
		const newEurEtched = scry.prices?.eur_etched ?? "";
		if (
			newUsd !== (c.priceUsd ?? "") ||
			newUsdFoil !== (c.priceUsdFoil ?? "") ||
			newEur !== (c.priceEur ?? "") ||
			newEurFoil !== (c.priceEurFoil ?? "") ||
			newUsdEtched !== (c.priceUsdEtched ?? "") ||
			newEurEtched !== (c.priceEurEtched ?? "")
		) {
			updated++;
		}
		c.priceUsd = newUsd;
		c.priceUsdFoil = newUsdFoil;
		c.priceEur = newEur;
		c.priceEurFoil = newEurFoil;
		c.priceUsdEtched = newUsdEtched;
		c.priceEurEtched = newEurEtched;
	});

	this.settings.lastPriceRefresh = Date.now();
	await this.saveSettings();
	return { updated };
}
// Vérifie si le délai configuré (Settings > Interface) est écoulé depuis
// le dernier rafraîchissement, et lance une mise à jour en arrière-plan si
// besoin. "0" désactive complètement la fonctionnalité.

export async function maybeAutoRefreshPrices(this: MTGCollectionPlugin) {
	const hours = this.settings.priceRefreshIntervalHours;
	if (hours <= 0) return;
	const elapsedMs = Date.now() - this.settings.lastPriceRefresh;
	if (elapsedMs < hours * 60 * 60 * 1000) return;
	await this.refreshAllPrices();
	this.app.workspace.getLeavesOfType(VIEW_TYPE_MTG_COLLECTION).forEach((leaf) => {
		if (leaf.view instanceof MTGCollectionView) leaf.view.render();
	});
}
