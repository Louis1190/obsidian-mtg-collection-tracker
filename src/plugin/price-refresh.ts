import { fetchScryfallCollection } from "../api/scryfall";
import { VIEW_TYPE_MTG_COLLECTION } from "../core/data-model";
import { PricedCard } from "../core/price";
import type MTGCollectionPlugin from "../plugin";
import { MTGCollectionView } from "../view";

/* ---------------------------------------------------------------------------- */
/* Refresh of the stored prices of cards, manual and automatic (MTGCollectionPlugin). */
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

	// Decks included since 2026-09-02 (see DeckCard.priceUsd/etc.,
	// data-model.ts) — a same id counts for a single round trip, even if it
	// appears in the collection, in the wantlist AND in one or more decks at
	// once.
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
	// DeckCard isn't assigned directly via applyPrices above: its 6 fields are
	// optional (see its own comment, data-model.ts), so don't structurally
	// satisfy PricedCard (which requires them non-optional) — same values,
	// simply written by hand rather than via this generic function.
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
// Checks whether the configured delay (Settings > Interface) has elapsed
// since the last refresh, and launches an update in the background if
// needed. "0" disables the feature entirely.

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
