import type MTGCollectionPlugin from "../plugin";
import { NEIGHBOR_COPY_IMAGES, NeighborImageCard, neighborImageUrls } from "../core/neighbor-prefetch";
import { preloadImages } from "../ui/image-preload";

// How many cards on each side of the displayed one get their pictures fetched ahead (same width as the rules text, see
// CARD_TEXT_PREFETCH_WINDOW in scryfall-cache.ts, and the price files, see prefetchCardbaseNeighbors).
export const NEIGHBOR_IMAGE_WINDOW = 5;

// Fetches ahead the pictures of the cards around `centerIndex` of a detail window's navigation list: the artwork (banner + blurred
// background), the card's own image and a couple of its other copies (the "Copies in lists" tiles). Images only: these come from
// Scryfall's image servers (*.scryfall.io), which have no rate limit, and are kept a year by the HTTP cache, so each costs one download
// per device, ever. The tiles of a card that is walked past are the only waste (~70-90 KB each); nothing is fetched when the device asks
// for less data (Data Saver). Never throws, shows nothing.
export function prefetchNeighborImages(this: MTGCollectionPlugin, cards: NeighborImageCard[], centerIndex: number): void {
	const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
	if (connection?.saveData) return;
	const { collection, wantlist, decks } = this.settings;
	// The other pictures of a name: the collection, the wantlist and the decks, as the carousel itself gathers them.
	const otherCopyImages = (name: string, ownImageUrl: string): string[] => {
		const found: string[] = [];
		const consider = (card: { name: string; imageUrl: string }) => {
			if (found.length >= NEIGHBOR_COPY_IMAGES) return;
			if (card.name === name && card.imageUrl && card.imageUrl !== ownImageUrl && !found.includes(card.imageUrl)) found.push(card.imageUrl);
		};
		collection.forEach(consider);
		wantlist.forEach(consider);
		decks.forEach((deck) => deck.cards.forEach(consider));
		return found;
	};
	preloadImages(neighborImageUrls(cards, centerIndex, NEIGHBOR_IMAGE_WINDOW, otherCopyImages));
}
