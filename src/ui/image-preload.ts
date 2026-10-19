// Downloads pictures ahead of time so they are in the browser's memory when a window shows them (the neighbouring cards of a detail
// window, see plugin/neighbor-prefetch.ts). A picture is requested through a detached <img>; Scryfall's image servers send
// `Cache-Control: public, max-age=31556952` and have no rate limit (scryfall.com/docs/api/rate-limits: "The direct file origins located
// at *.scryfall.io do not have rate limits"), so the HTTP cache keeps them and later requests cost nothing. The most recent pictures'
// elements are also kept (a bounded list): a decoded picture the page still holds is shown with no gap, an unreferenced one can be
// dropped from memory before the user gets there.
export class ImagePreloader {
	private kept = new Map<string, HTMLImageElement>();

	constructor(
		private capacity = 40,
		private makeImage: () => HTMLImageElement = () => new Image()
	) {}

	preload(urls: string[]): void {
		for (const url of urls) {
			const known = this.kept.get(url);
			if (known) {
				// Seen again: it becomes the most recent.
				this.kept.delete(url);
				this.kept.set(url, known);
				continue;
			}
			const img = this.makeImage();
			img.decoding = "async";
			// Low priority: the picture the user is looking at, and anything else the page is loading, goes first.
			img.setAttribute("fetchpriority", "low");
			img.src = url;
			this.kept.set(url, img);
		}
		while (this.kept.size > this.capacity) {
			const oldest = this.kept.keys().next().value;
			if (oldest === undefined) break;
			this.kept.delete(oldest);
		}
	}

	has(url: string): boolean {
		return this.kept.has(url);
	}

	get size(): number {
		return this.kept.size;
	}
}

const sharedPreloader = new ImagePreloader();

export function preloadImages(urls: string[]): void {
	sharedPreloader.preload(urls);
}
