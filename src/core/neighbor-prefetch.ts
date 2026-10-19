import { hasDistinctArtCrop } from "./card-model";


// The indexes on each side of `centerIndex`, nearest first (+1, -1, +2, -2...), `window` on each side, inside the list.
export function neighborIndexes(centerIndex: number, length: number, window: number): number[] {
	const out: number[] = [];
	for (let d = 1; d <= window; d++) {
		if (centerIndex + d < length) out.push(centerIndex + d);
		if (centerIndex - d >= 0) out.push(centerIndex - d);
	}
	return out;
}

export interface NeighborImageCard {
	name: string;
	artCropUrl: string;
	imageUrl: string;
}

// At most this many OTHER copies' pictures per neighbour (the carousel shows three tiles at a time: the card itself and two copies).
export const NEIGHBOR_COPY_IMAGES = 2;

export function isFetchableImageUrl(url: string): boolean {
	return /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url);
}

// The pictures to download, in the order they matter: first every neighbour's artwork (the banner and the blurred background of the
// window, nearest first), then each neighbour's own full image (its tile in "Copies in lists") followed by up to two other copies of
// the same name. `otherCopyImages(name, ownUrl)` says where the other copies' pictures are (the settings, the plugin's business).
// Only https addresses (and the loopback host, which the Android test setup serves its pictures from: `tools/android/`), each once:
// the addresses come from Scryfall's data, stored in the settings, and a picture is never fetched from anywhere else.
export function neighborImageUrls(
	cards: NeighborImageCard[],
	centerIndex: number,
	window: number,
	otherCopyImages: (name: string, ownImageUrl: string) => string[]
): string[] {
	const indexes = neighborIndexes(centerIndex, cards.length, window);
	const urls: string[] = [];
	const add = (url: string | undefined) => {
		if (url && isFetchableImageUrl(url) && !urls.includes(url)) urls.push(url);
	};
	indexes.forEach((i) => {
		if (hasDistinctArtCrop(cards[i])) add(cards[i].artCropUrl);
	});
	indexes.forEach((i) => {
		add(cards[i].imageUrl);
		otherCopyImages(cards[i].name, cards[i].imageUrl).slice(0, NEIGHBOR_COPY_IMAGES).forEach(add);
	});
	return urls;
}
