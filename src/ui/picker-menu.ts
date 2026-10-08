

// Small lightweight context menu, anchored under the clicked element, with
// no visible button around the trigger (language flag, condition stars...).
// Anchor of the currently open picker (if any): makes it possible to detect
// a re-click on the same trigger to close rather than reopen an identical
// menu, without which clicking twice on the same icon (language, condition,
// sort...) gave the impression that nothing happened.
let openPickerAnchorEl: HTMLElement | null = null;
// Cleanup (scroll/resize/click listeners, see below) of the currently open
// picker, if any — stored at module level rather than in a closure local
// to a single call, so that a FOLLOWING call of openPickerMenu (opening a
// different menu while a first one is still open) can remove the old one's
// listeners before removing it from the DOM, rather than letting them
// accumulate silently.
let openPickerCleanup: (() => void) | null = null;

export function openPickerMenu(
	anchor: HTMLElement,
	items: { render: (el: HTMLElement) => void; onSelect: () => void }[],
	options?: { matchAnchorWidth?: boolean; menuClass?: string }
) {
	const reopeningSameAnchor = openPickerAnchorEl === anchor;
	if (openPickerCleanup) openPickerCleanup();
	document.querySelectorAll(".mtg-picker-menu").forEach((el) => el.remove());
	openPickerAnchorEl = null;
	openPickerCleanup = null;
	if (reopeningSameAnchor) return;
	openPickerAnchorEl = anchor;

	const menu = document.body.createDiv({ cls: "mtg-picker-menu" });
	if (options?.menuClass) menu.addClass(options.menuClass);
	if (options?.matchAnchorWidth) menu.addClass("is-match-anchor-width");

	// .mtg-picker-menu is position:fixed (to escape the overflow:hidden of any
	// parent, e.g. .mtg-main) — its top/left coordinates, computed via
	// getBoundingClientRect (relative to the viewport), therefore stay valid
	// as long as nothing moves, but NOT when the element that actually scrolls
	// (never the window/the document itself — see "Floating Back to Top
	// button" in the architecture notes) scrolls: .mtg-main for the overview
	// grid, .mtg-detail-scroll-area once a list/deck/wantlist is open (since
	// 2026-09-07, see its own comment in styles.css) — scrolling inside moves
	// the icon under the menu without the menu, fixed relative to the screen,
	// following it (reported bug: the picker stayed frozen on screen instead
	// of staying "attached" to the icon/button that opened it). Recomputing
	// top/left on every scroll fixes this. A scroll event does NOT bubble up
	// to an ancestor: window must therefore listen in the CAPTURE phase (3rd
	// argument `true`) to intercept the scroll of ANY descendant container —
	// which covers the two elements above (and any other future one) without
	// any change needed here.
	const reposition = () => {
		const r = anchor.getBoundingClientRect();
		menu.style.top = `${r.bottom + 4}px`;
		menu.style.left = `${r.left}px`;
		if (options?.matchAnchorWidth) menu.style.width = `${r.width}px`;
	};
	reposition();

	const cleanup = () => {
		menu.remove();
		window.removeEventListener("scroll", reposition, true);
		window.removeEventListener("resize", reposition);
		document.removeEventListener("click", closeOnOutsideClick);
		openPickerAnchorEl = null;
		openPickerCleanup = null;
	};
	openPickerCleanup = cleanup;

	items.forEach((item) => {
		const el = menu.createDiv({ cls: "mtg-picker-item" });
		item.render(el);
		el.addEventListener("click", (evt) => {
			evt.stopPropagation();
			item.onSelect();
			cleanup();
		});
	});

	const closeOnOutsideClick = (evt: MouseEvent) => {
		if (!menu.contains(evt.target as Node)) cleanup();
	};
	window.addEventListener("scroll", reposition, true);
	window.addEventListener("resize", reposition);
	window.setTimeout(() => document.addEventListener("click", closeOnOutsideClick), 0);
}
