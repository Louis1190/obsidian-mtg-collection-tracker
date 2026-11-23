import type { MTGCollectionView } from "../view";


export function placeGalleryActionButtons(view: MTGCollectionView) {
	const onPhone = activeDocument.body.classList.contains("is-phone");
	const groups: [HTMLElement, HTMLElement[]][] = [
		[view.collectionActionsEl, [view.newListBtn, view.listGallerySelectBtn]],
		[view.decksActionsEl, [view.newDeckBtn, view.deckGallerySelectBtn]],
		[view.wantlistsActionsEl, [view.newWantlistBtn, view.wantlistGallerySelectBtn]],
	];
	for (const [searchActions, buttons] of groups) {
		const target = onPhone ? view.collectionHeaderEl : searchActions;
		// Appended in this order, which is also the order they were created in, so the header ends up as it always was.
		for (const button of buttons) {
			if (button.parentElement !== target) target.appendChild(button);
		}
	}
}

// Re-places the buttons when the window crosses the phone width without anything being drawn (a desktop window dragged narrower). Obsidian toggles
// `is-phone` on <body>; the observer only looks at that element's class attribute, and the function is a no-op once the buttons are where they belong.
export function watchGalleryActionsPlacement(view: MTGCollectionView) {
	const observer = new MutationObserver(() => placeGalleryActionButtons(view));
	observer.observe(activeDocument.body, { attributes: true, attributeFilter: ["class"] });
	view.register(() => observer.disconnect());
}
