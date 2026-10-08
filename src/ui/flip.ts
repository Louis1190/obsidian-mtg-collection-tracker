/* -------------------------------------------------------------------------- */
/* The two gestures of the FLIP technique (First-Last-Invert-Play) */
/* -------------------------------------------------------------------------- */

// Shared by the collapse of the card groups (view/group-collapse.ts) and by the history of the add window
// (modals/add-cards-modal.ts), which each wrote the same assignments inline. The principle: AFTER the real
// layout change, the element is visually put back at its place from BEFORE (holdAtOffset: no transition, offset
// in Y), then released (releaseOffset: transition on transform only) — it then glides toward its real place.
// Only "transform" animates, so no layout recalculation during the glide.
//
// The styles live in styles.css (.mtg-flip-hold / .mtg-flip-play), no longer in `el.style.…` (the plugin
// directory rejects them). An inline style beat any rule of the stylesheet, and the row or tile already has its
// own transition/transform (.mtg-card-row-outer, .mtg-row-collapsed…): the two classes are therefore written
// `:is(.class, #identifier)`, which weighs like an identifier (see .mtg-hidden) — without !important, which the
// directory flags. They are NEVER set together: these two functions remove one before adding the other.
//
// As before, the element KEEPS the release class afterwards: its transition stays "transform only" (the old code
// likewise left `transition: transform …` inline, never removed) — not to be "cleaned up" without looking at
// what that changes for the opacity and margin of the rows that collapse.

export function holdAtOffset(el: HTMLElement, deltaY: number): void {
	el.removeClass("mtg-flip-play");
	el.setCssProps({ "--mtg-flip-dy": `${deltaY}px` });
	el.addClass("mtg-flip-hold");
}

export function releaseOffset(el: HTMLElement): void {
	el.removeClass("mtg-flip-hold");
	el.addClass("mtg-flip-play");
}
