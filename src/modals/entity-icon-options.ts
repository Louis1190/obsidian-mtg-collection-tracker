
/* ---------------------------------------------------------------------------- */
/* Pictograms offered for a list, a wantlist or a deck (mana, hybrids, others). */
/* ---------------------------------------------------------------------------- */

// Mana symbols offered by "Choose icon" (ListSettingsModal) — the 5 colors
// + colorless, each a letter recognized by
// MTGCollectionPlugin.getManaSymbolSvg (Scryfall's /symbology endpoint). No
// "multicolor" in the sense of the lists' grouping by color (which can show
// several symbols side by side for a multicolor group, view.ts): that would
// remain out of scope here, a list pictogram being deliberately a single
// icon at a time — but the 10 HYBRID symbols below are not affected by this
// same restriction: "W/B" is not 2 combined icons, it is a single Scryfall
// symbol in its own right (checked live on /symbology, represents_mana:
// true), which goes through the same getManaSymbolSvg(letter) as the pure
// colors just above — its value ("W/B") serves as is as the `{W/B}` key in
// the symbology, no change of mechanism needed to accommodate it.
export const MANA_ICON_LETTERS: { letter: string; label: string; }[] = [
	{ letter: "W", label: "White" },
	{ letter: "U", label: "Blue" },
	{ letter: "B", label: "Black" },
	{ letter: "R", label: "Red" },
	{ letter: "G", label: "Green" },
	{ letter: "C", label: "Colorless" },
	{ letter: "W/U", label: "White/Blue" },
	{ letter: "W/B", label: "White/Black" },
	{ letter: "U/B", label: "Blue/Black" },
	{ letter: "U/R", label: "Blue/Red" },
	{ letter: "B/R", label: "Black/Red" },
	{ letter: "B/G", label: "Black/Green" },
	{ letter: "R/G", label: "Red/Green" },
	{ letter: "R/W", label: "Red/White" },
	{ letter: "G/W", label: "Green/White" },
	{ letter: "G/U", label: "Green/Blue" },
	// Colorless hybrid (diamond + color) — one colorless mana OR a given
	// color. Same mechanism, checked live on /symbology.
	{ letter: "C/W", label: "Colorless/White" },
	{ letter: "C/U", label: "Colorless/Blue" },
	{ letter: "C/B", label: "Colorless/Black" },
	{ letter: "C/R", label: "Colorless/Red" },
	{ letter: "C/G", label: "Colorless/Green" },
	// "Generic 2" hybrid (digit 2 + color) — 2 generic mana OR a given color.
	// Same mechanism, checked live on /symbology.
	{ letter: "2/W", label: "Two/White" },
	{ letter: "2/U", label: "Two/Blue" },
	{ letter: "2/B", label: "Two/Black" },
	{ letter: "2/R", label: "Two/Red" },
	{ letter: "2/G", label: "Two/Green" },
	// Phyrexian (pure color) — same Scryfall symbol as a color/life hybrid,
	// checked live on /symbology (represents_mana: true).
	{ letter: "W/P", label: "Phyrexian White" },
	{ letter: "U/P", label: "Phyrexian Blue" },
	{ letter: "B/P", label: "Phyrexian Black" },
	{ letter: "R/P", label: "Phyrexian Red" },
	{ letter: "G/P", label: "Phyrexian Green" },
	{ letter: "C/P", label: "Phyrexian Colorless" },
	// Phyrexian hybrid (2 colors or life) — 10 combinations, same mechanism,
	// checked live in the same way.
	{ letter: "W/U/P", label: "Phyrexian White/Blue" },
	{ letter: "W/B/P", label: "Phyrexian White/Black" },
	{ letter: "U/B/P", label: "Phyrexian Blue/Black" },
	{ letter: "U/R/P", label: "Phyrexian Blue/Red" },
	{ letter: "B/R/P", label: "Phyrexian Black/Red" },
	{ letter: "B/G/P", label: "Phyrexian Black/Green" },
	{ letter: "R/G/P", label: "Phyrexian Red/Green" },
	{ letter: "R/W/P", label: "Phyrexian Red/White" },
	{ letter: "G/W/P", label: "Phyrexian Green/White" },
	{ letter: "G/U/P", label: "Phyrexian Green/Blue" },
	// Snow (Coldsnap) — un seul symbole.
	{ letter: "S", label: "Snow" },
	// Generic mana — X/Y/Z (variable costs) + 0-9, the range actually common
	// on a card (chosen explicitly rather than the exhaustive
	// 0-20/100/1000000/½/∞ that Scryfall also knows: these very large values
	// only appear on joke cards/Un-sets, not enough to justify weighing down
	// this grid for a list pictogram).
	{ letter: "X", label: "X generic mana" },
	{ letter: "Y", label: "Y generic mana" },
	{ letter: "Z", label: "Z generic mana" },
	{ letter: "0", label: "0 generic mana" },
	{ letter: "1", label: "1 generic mana" },
	{ letter: "2", label: "2 generic mana" },
	{ letter: "3", label: "3 generic mana" },
	{ letter: "4", label: "4 generic mana" },
	{ letter: "5", label: "5 generic mana" },
	{ letter: "6", label: "6 generic mana" },
	{ letter: "7", label: "7 generic mana" },
	{ letter: "8", label: "8 generic mana" },
	{ letter: "9", label: "9 generic mana" },
];
// 3rd tab "Other symbol" of "Choose icon" — the Scryfall symbols that have nothing to do with a
// card's mana cost (represents_mana: false on the /symbology endpoint, checked live: 9 in all out
// of the 84 known symbols), game mechanics found literally printed on a card (tapping/untapping a
// creature, an energy counter...). Same fetch function as the mana colors above
// (MTGCollectionPlugin.getManaSymbolSvg already just looks for `{${letter}}` in the symbology,
// without distinguishing mana/non-mana). `recolor: true` marks the symbols whose Scryfall SVG uses
// only one color (pure #000, no background — checked live on each of the 9 files
// svgs.scryfall.io/card-symbols/*.svg): nearly invisible on a dark theme unless recolored, unlike
// Tap/Untap/Energy/Acorn (2 colors each, a circular background badge + a glyph — recoloring those
// would overwrite that background in the process, so deliberately left as is). See
// renderSymbolGrid (in each *-settings-modal.ts), which applies applySvgColor only when this field
// is true.
export const OTHER_ICON_SYMBOLS: { letter: string; label: string; recolor?: boolean; }[] = [
	{ letter: "T", label: "Tap" },
	{ letter: "Q", label: "Untap" },
	{ letter: "E", label: "Energy" },
	{ letter: "PW", label: "Planeswalker", recolor: true },
	{ letter: "CHAOS", label: "Chaos", recolor: true },
	{ letter: "A", label: "Acorn counter" },
	{ letter: "TK", label: "Ticket counter", recolor: true },
	{ letter: "D", label: "Land drop", recolor: true },
	{ letter: "P", label: "Modal budget pawprint", recolor: true },
];
