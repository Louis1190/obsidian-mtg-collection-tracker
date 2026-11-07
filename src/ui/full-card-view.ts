import { setIcon } from "obsidian";
import { closeOpenPickerMenu } from "./picker-menu";


// How long the closing animation lasts; the element is removed after it (the net timer covers a window that runs no frames).
export const FULL_CARD_CLOSE_MS = 220;

// The longest the card waits for its picture to be decoded, once it has loaded, before rising anyway.
export const FULL_CARD_DECODE_NET_MS = 300;

// The picture shown for the card on display: the back face's when a double-faced card has been flipped, else the card's own.
export async function resolveFullCardUrl(
	getFaces: (scryfallId: string) => Promise<{ back: string } | null>,
	scryfallId: string,
	showingBack: boolean,
	frontUrl: string
): Promise<string> {
	if (showingBack) {
		const faces = await getFaces(scryfallId);
		if (faces?.back) return faces.back;
	}
	return frontUrl;
}

// `alpha`: the card is from Limited Edition Alpha, whose corners are rounder than every other printing's (the scan shows white in them
// unless they are clipped harder, as the classic window does: isAlphaSet).
export interface FullCardOptions {
	alpha?: boolean;
}

// A square button of the condition / language stack (same class, same size), opening the overlay on `contentEl`.
export function addFullCardButton(
	host: HTMLElement,
	contentEl: HTMLElement,
	getUrl: () => Promise<string | undefined>,
	options: FullCardOptions = {}
): HTMLElement {
	const button = host.createDiv({ cls: "mtg-card-detail-image-icon-btn mtg-card-detail-fullcard-btn" });
	setIcon(button, "maximize-2");
	button.setAttribute("title", "View the full card");
	button.addEventListener("click", () => {
		// A Finish / Condition / Language menu lives on <body>, above the window: it would stay over the card.
		closeOpenPickerMenu();
		openFullCardView(contentEl, getUrl, options);
	});
	return button;
}

export function openFullCardView(
	contentEl: HTMLElement,
	getUrl: () => Promise<string | undefined>,
	options: FullCardOptions = {}
): void {
	if (contentEl.querySelector(":scope > .mtg-card-detail-fullcard")) return;

	const overlay = contentEl.createDiv({ cls: "mtg-card-detail-fullcard" });
	const card = overlay.createDiv({ cls: "mtg-card-detail-fullcard-card" });
	card.toggleClass("is-alpha", !!options.alpha);
	// The window's own close button class: same look, same place, so the cross seems to stay where it was.
	const cross = overlay.createDiv({ cls: "mtg-card-detail-close-btn" });
	setIcon(cross, "x");
	cross.setAttribute("title", "Close");

	let closing = false;
	const close = () => {
		if (closing) return;
		closing = true;
		overlay.addClass("is-closing");
		const remove = () => overlay.remove();
		overlay.addEventListener("animationend", (evt) => {
			if (evt.target === overlay) remove();
		});
		window.setTimeout(remove, FULL_CARD_CLOSE_MS + 300);
	};
	// Anywhere on the overlay closes it: the cross, the card, the dark around it.
	overlay.addEventListener("click", close);

	// The card rises once its picture is decoded (the scrim and the cross are there at once), or says why it cannot.
	const reveal = () => {
		if (closing || !overlay.isConnected) return;
		overlay.addClass("is-ready");
	};
	const fail = () => {
		card.addClass("is-error");
		card.empty();
		card.createDiv({ text: "The card picture could not be loaded." });
		reveal();
	};

	void getUrl().then(
		(url) => {
			if (closing || !overlay.isConnected) return;
			if (!url) {
				fail();
				return;
			}
			const img = card.createEl("img", { cls: "mtg-card-detail-fullcard-img" });
			img.addEventListener("error", fail, { once: true });
			img.addEventListener(
				"load",
				() => {
					if (typeof img.decode !== "function") {
						reveal();
						return;
					}
					void img.decode().then(reveal, reveal);
					// A window that draws no frames (hidden, or the app in the background) never finishes decoding: the
					// card must not stay invisible for ever. `reveal` is idempotent.
					window.setTimeout(reveal, FULL_CARD_DECODE_NET_MS);
				},
				{ once: true }
			);
			img.src = url;
		},
		fail
	);
}
