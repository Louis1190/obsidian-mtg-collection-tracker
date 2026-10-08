// Automatic detection of a card's "function" in a deck (Ramp, Removal,
// Draw, Counters, Tokens, etc.) — inspired by Archidekt's "Categories"
// (see the Stacks view, view.ts/renderDeckStacksView), but derived
// automatically from the rules text already cached
// (DeckCard.oracleText/keywords, see "Card Text" in CLAUDE.md) rather than
// a full manual tagging system — scoping explicitly confirmed
// (2026-09-02): auto-detection first, adjustable afterwards card by card
// (see DeckCard.deckFunctionOverride, data-model.ts), not a
// free-form/multi-tag editor. A card still gets only ONE function — the
// first rule that matches wins (order below), never several at once (same
// choice as "a single pile" for the Stacks view: stays within the existing
// grouping engine, which assumes a single group per card, rather than an
// architecture change shared by the plugin's 3 sections).
//
// Deliberately standalone file (no import from card-sorting.ts, even
// though its own "Land"/primaryType already live there): card-sorting.ts
// imports THIS file (not the reverse) for its "function" case in
// groupSortValue/groupLabelFor — an import the other way would create a
// real cycle. Hence the small "Land" rule duplicated below rather than
// reused from isLand (card-sorting.ts): a simple regex, not worth risking
// a cycle for.
//
// Each rule has been deliberately kept simple/readable (a single main
// pattern per category) rather than over-optimized to capture every
// existing card — false negatives (a card that deserved a category but
// matches no rule) fall back to the card's type (see the call to
// primaryType on the card-sorting.ts side), occasional false positives are
// corrected manually via deckFunctionOverride.

// Order = display order of the piles AND detection priority order (the 1st
// rule that matches wins) — functional categories first (the most
// "interesting" ones to see grouped), type fallbacks after (same labels as
// primaryType/MAIN_TYPES, card-sorting.ts, to stay consistent with "Group
// by Type"). "Commander" (2026-09-07, explicitly requested — "Commander is
// a Function", not a board category, see DeckCardCategory in
// data-model.ts) comes very first: unlike all the other entries below, it
// has NO detection rule in FUNCTION_RULES/EVASION_KEYWORDS further down —
// nothing in a card's text allows guessing "this is THE commander of THIS
// specific deck", so it only exists through deckFunctionOverride, a purely
// manual designation (see isDeckCommander, data-model.ts). Its position at
// the head therefore plays no role in the detection priority order (never
// reached by a rule) — only in the display order of the piles/the
// "Function" picker (deck-card-detail-modal.ts).
export const DECK_FUNCTION_CATEGORIES = [
	"Commander",
	"Land",
	"Counterspell",
	"Removal",
	"Tokens",
	"Counters",
	"Reanimation",
	"Sacrifice",
	"Ramp",
	"Tutor",
	"Draw",
	"Discard",
	"Mill",
	"Lifegain",
	"Evasion",
	"Creature",
	"Artifact",
	"Enchantment",
	"Instant",
	"Sorcery",
	"Planeswalker",
	"Battle",
	"Kindred",
	"Tribal",
	"Other",
] as const;

interface DeckFunctionRule {
	label: string;
	test: (oracleText: string) => boolean;
}

// Patterns deliberately lowercase (oracleText is lowercased once by
// detectDeckCardFunction, not re-tested per rule) — [^.\n] rather than .*:
// stays within the SAME sentence/line, prevents a pattern from mistakenly
// "crossing" two unrelated abilities separated by a period.
const FUNCTION_RULES: DeckFunctionRule[] = [
	// Precise pattern (start of sentence): "counter target spell" elsewhere in
	// the text (e.g. "unless that player pays {2}, counter target spell") is
	// still a real counterspell, this pattern captures it too through
	// \bcounter target spell\b without strict anchoring at the start.
	{ label: "Counterspell", test: (t) => /\bcounter target spell\b/.test(t) },
	{
		label: "Removal",
		test: (t) =>
			/\b(destroy|exile) target (creature|permanent|artifact|enchantment|planeswalker|land)\b/.test(t) ||
			/gets? -\d+\/-\d+/.test(t),
	},
	{ label: "Tokens", test: (t) => /\bcreate[^.\n]*\btokens?\b/.test(t) },
	{ label: "Counters", test: (t) => /\+1\/\+1 counter/.test(t) || /\bproliferate\b/.test(t) },
	{ label: "Reanimation", test: (t) => /from (your|a) graveyard to the battlefield/.test(t) },
	{ label: "Sacrifice", test: (t) => /\bsacrifice (a|an|another)\b/.test(t) },
	// Land first (a land search = mana, not a real "tutor" for a specific
	// card) — hence Ramp before Tutor in this order.
	{
		label: "Ramp",
		test: (t) => /search your library for [^.\n]*\bland card\b/.test(t) || /^\{t\}: add \{[wubrgc]\}/m.test(t),
	},
	{ label: "Tutor", test: (t) => /search your library for [^.\n]*\bcard\b/.test(t) },
	{ label: "Draw", test: (t) => /\bdraws? [^.\n]*\bcards?\b/.test(t) },
	{ label: "Discard", test: (t) => /\bdiscards? [^.\n]*\bcards?\b/.test(t) },
	{ label: "Mill", test: (t) => /\bmill(s|ed|ing)?\b/.test(t) || /into (his or her|their|your) graveyard/.test(t) },
	{ label: "Lifegain", test: (t) => /\bgains? \d+ life\b/.test(t) || /\byou gain life\b/.test(t) },
];

const EVASION_KEYWORDS = new Set([
	"flying",
	"trample",
	"menace",
	"unblockable",
	"skulk",
	"shadow",
	"horsemanship",
	"fear",
	"intimidate",
	"daunt",
]);

// Returns undefined if no rule matches (and it isn't a land) — the "card
// type" fallback (primaryType) remains the caller's responsibility
// (card-sorting.ts), see the header comment above for why this file stays
// standalone.
export function detectDeckCardFunction(card: {
	typeLine: string;
	oracleText?: string;
	keywords?: string[];
}): string | undefined {
	// A land always keeps its own label, even if its rules text otherwise
	// matches another category (e.g. a fetchland also matches the "Ramp"
	// pattern above) — predictable, all lands stay grouped together rather
	// than scattered according to their side ability. Regex duplicated from
	// isLand (card-sorting.ts) rather than imported — see the header comment.
	if (/\bLand\b/.test(card.typeLine || "")) return "Land";

	const text = (card.oracleText || "").toLowerCase();
	for (const rule of FUNCTION_RULES) {
		if (rule.test(text)) return rule.label;
	}

	if ((card.keywords || []).some((k) => EVASION_KEYWORDS.has(k.toLowerCase()))) return "Evasion";

	return undefined;
}

// Stable sort key for "Group by Function" (groupSortValue, card-sorting.ts)
// — a zero-padded numeric prefix followed by the label itself, compared as
// a STRING (String.localeCompare): avoids mixing numbers/strings in the
// same groupBy (see the comment on groupSortValue, card-sorting.ts, for why
// this file never returns a bare number here). A label absent from
// DECK_FUNCTION_CATEGORIES (e.g. "Other", already in the list, or an
// unforeseen future fallback) sorts after all the known ones.
export function deckFunctionSortKey(label: string): string {
	const idx = (DECK_FUNCTION_CATEGORIES as readonly string[]).indexOf(label);
	const rank = idx === -1 ? DECK_FUNCTION_CATEGORIES.length : idx;
	return `${String(rank).padStart(3, "0")}_${label}`;
}
