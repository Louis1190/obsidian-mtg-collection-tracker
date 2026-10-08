import type { DeckCardCategory } from "./data-model";


export interface ParsedDecklistLine {
	// Original raw line (trimmed of leading/trailing whitespace) — carried
	// over as is into the import report in case of Scryfall resolution
	// failure, so that the user can compare with their source.
	raw: string;
	quantity: number;
	name: string;
	setCode?: string;
	collectorNumber?: string;
	category: DeckCardCategory;
	// See the header comment above — never true at the same time as a category
	// other than "mainboard" (no Commander marker recognized here ever sets
	// another category).
	isCommander: boolean;
}

export interface ParsedDecklist {
	lines: ParsedDecklistLine[];
	// Non-empty lines whose card name remained empty after extraction (e.g. a
	// line made up only of a tag) — distinct from the lines whose NAME matches no
	// Scryfall card, which can only be known after the network resolution (see
	// MTGCollectionPlugin.importDecklistToDeck).
	unparsedLines: string[];
}

// A "board role" recognized by a marker (section header, inline prefix,
// Archidekt bracket) — the real category it sets PLUS whether it is
// specifically the Commander (see the header comment on
// ParsedDecklistLine.isCommander). A single type shared by the 3 marker
// tables below rather than 3 parallel pairs of fields.
interface BoardRole {
	category: DeckCardCategory;
	isCommander: boolean;
}

const SECTION_HEADERS: { pattern: RegExp; role: BoardRole }[] = [
	{ pattern: /^(commander|commanders|command zone)$/i, role: { category: "mainboard", isCommander: true } },
	{ pattern: /^(sideboard)$/i, role: { category: "sideboard", isCommander: false } },
	{ pattern: /^(maybeboard|maybe board|maybe|considering)$/i, role: { category: "maybeboard", isCommander: false } },
	{ pattern: /^(deck|mainboard|main deck|maindeck|main|library)$/i, role: { category: "mainboard", isCommander: false } },
];

// "Commander: Korvold…"/"SB: 1 Some Card" — a single card outside a block,
// without changing the current section for the following lines (unlike a
// header on its own line, see SECTION_HEADERS above).
const INLINE_PREFIXES: { pattern: RegExp; role: BoardRole }[] = [
	{ pattern: /^(commander|commanders)\s*:\s*/i, role: { category: "mainboard", isCommander: true } },
	{ pattern: /^(sb|sideboard)\s*:\s*/i, role: { category: "sideboard", isCommander: false } },
	{ pattern: /^(maybe|maybeboard)\s*:\s*/i, role: { category: "maybeboard", isCommander: false } },
];

// Archidekt "[Category]" categories recognized as a real board role — any
// other value (e.g. "[Ramp]", a custom deck-building label) is a legitimate
// Archidekt tag but one that no role below can represent: simply removed
// from the line without changing its category.
const BRACKET_ROLE: Record<string, BoardRole> = {
	commander: { category: "mainboard", isCommander: true },
	commanders: { category: "mainboard", isCommander: true },
	sideboard: { category: "sideboard", isCommander: false },
	maybeboard: { category: "maybeboard", isCommander: false },
	maybe: { category: "maybeboard", isCommander: false },
};

interface ParsedCardLine {
	quantity: number;
	name: string;
	setCode?: string;
	collectorNumber?: string;
	bracketRole?: BoardRole;
}

function parseDecklistCardLine(line: string): ParsedCardLine | null {
	let rest = line;

	// Archidekt "^Label,#hex^" label at the end of the line — purely cosmetic
	// on Archidekt's side, simply removed.
	rest = rest.replace(/\s*\^[^^]*\^\s*$/, "").trim();

	// Archidekt "[Category]" at the end of the line.
	let bracketRole: BoardRole | undefined;
	const bracketMatch = rest.match(/\s*\[([^\]]+)\]\s*$/);
	if (bracketMatch) {
		rest = rest.slice(0, bracketMatch.index).trim();
		const key = bracketMatch[1].trim().toLowerCase();
		if (BRACKET_ROLE[key]) bracketRole = BRACKET_ROLE[key];
	}

	// Archidekt foil/etched marker ("*F*", "*E*"…) — DeckCard has no finish
	// field (see "Data model notes" in CLAUDE.md), simply ignored rather than
	// interpreted.
	rest = rest.replace(/\s*\*[A-Za-z]+\*\s*$/, "").trim();

	// Leading quantity ("1x", "4 "…) — 1 by default if absent (a line with no
	// explicit quantity, e.g. a simple "one card per line" export without a
	// counter, remains a single card).
	let quantity = 1;
	const qtyMatch = rest.match(/^(\d+)\s*[xX]?\s+(.+)$/);
	if (qtyMatch) {
		quantity = Math.max(1, parseInt(qtyMatch[1], 10) || 1);
		rest = qtyMatch[2].trim();
	}

	// Set + collector number at the end of the line, e.g. "(C21) 263" — a
	// Scryfall set code is 2 to 5 alphanumeric characters; the number that
	// follows can contain letters/symbols (variants, ★…), deliberately
	// permissive rather than a strict \d+. The card name itself is never
	// confused with this: a real name containing parentheses (e.g. "Erase (Not
	// the Urza's Legacy One)") always has more than a simple short
	// alphanumeric token between the parentheses, so it doesn't match this
	// pattern.
	let setCode: string | undefined;
	let collectorNumber: string | undefined;
	const setMatch = rest.match(/\(([A-Za-z0-9]{2,5})\)\s*([A-Za-z0-9-★]*)\s*$/);
	if (setMatch) {
		setCode = setMatch[1].toLowerCase();
		collectorNumber = setMatch[2] || undefined;
		rest = rest.slice(0, setMatch.index).trim();
	}

	const name = rest.trim();
	if (!name) return null;

	return { quantity, name, setCode, collectorNumber, bracketRole };
}

// An internal working line, before the final pass ("last block = Commander"
// below) and the final cleanup turn it into a public ParsedDecklistLine.
// `blockIndex` identifies the group of lines separated from the others by at
// least one blank line (0 for the very first); `categoryExplicit`
// distinguishes "mainboard/not Commander because nothing says otherwise"
// (candidate for the heuristic) from "a real marker set this category/this
// Commander status explicitly" (never re-tagged afterwards) — covers
// category AND isCommander at once, a marker always sets both together (see
// BoardRole).
interface InternalLine extends ParsedDecklistLine {
	blockIndex: number;
	categoryExplicit: boolean;
}

export function parseDecklistText(text: string): ParsedDecklist {
	const internalLines: InternalLine[] = [];
	const unparsedLines: string[] = [];
	let currentRole: BoardRole = { category: "mainboard", isCommander: false };
	let justSawAboutHeader = false;
	let blockIndex = 0;
	let pendingBlockBreak = false;
	let sawAnyContent = false;
	let sawAnyHeader = false;

	for (const rawLine of text.split(/\r\n|\r|\n/)) {
		let line = rawLine.trim();
		if (!line) {
			justSawAboutHeader = false;
			// Ignores a blank line as long as no real content has been seen yet (blank
			// lines at the top of the text must never count as a block boundary).
			if (sawAnyContent) pendingBlockBreak = true;
			continue;
		}
		if (pendingBlockBreak) {
			blockIndex++;
			pendingBlockBreak = false;
		}
		sawAnyContent = true;

		if (/^about$/i.test(line)) {
			justSawAboutHeader = true;
			continue;
		}
		if (justSawAboutHeader && /^name\s/i.test(line)) {
			justSawAboutHeader = false;
			continue;
		}
		justSawAboutHeader = false;

		// A "// …" comment can also serve as a section header (a convention seen
		// in several decklist exports/imports) — handled exactly like the line it
		// comments once the "//" is removed.
		if (line.startsWith("//")) {
			line = line.slice(2).trim();
			if (!line) continue;
		}

		// Section header on its own line ("Commander", "Deck (99)", "Sideboard:"…)
		// — never added as a card, just changes the role applied to the following
		// lines until the next header.
		const headerCandidate = line
			.replace(/\s*\(\d+\)\s*$/, "")
			.replace(/:$/, "")
			.trim();
		const header = SECTION_HEADERS.find((h) => h.pattern.test(headerCandidate));
		if (header) {
			currentRole = header.role;
			sawAnyHeader = true;
			continue;
		}

		let lineRoleOverride: BoardRole | undefined;
		for (const p of INLINE_PREFIXES) {
			if (p.pattern.test(line)) {
				lineRoleOverride = p.role;
				line = line.replace(p.pattern, "").trim();
				break;
			}
		}
		if (!line) continue;

		const parsed = parseDecklistCardLine(line);
		if (!parsed) {
			unparsedLines.push(rawLine.trim());
			continue;
		}
		if (parsed.bracketRole) lineRoleOverride = parsed.bracketRole;

		const role = lineRoleOverride ?? currentRole;
		internalLines.push({
			raw: rawLine.trim(),
			quantity: parsed.quantity,
			name: parsed.name,
			setCode: parsed.setCode,
			collectorNumber: parsed.collectorNumber,
			category: role.category,
			isCommander: role.isCommander,
			blockIndex,
			categoryExplicit: lineRoleOverride !== undefined,
		});
	}

	if (!sawAnyHeader && internalLines.length > 0) {
		const lastBlockIndex = internalLines[internalLines.length - 1].blockIndex;
		// lastBlockIndex > 0: there is a previous block separated by a blank line
		// — a text that never had a blank line at all (hence a single block,
		// blockIndex 0 everywhere) never activates this heuristic, even if it
		// contains only 1-2 cards in total.
		if (lastBlockIndex > 0) {
			const lastBlockLines = internalLines.filter((l) => l.blockIndex === lastBlockIndex);
			const eligible =
				lastBlockLines.length > 0 &&
				lastBlockLines.length <= 2 &&
				lastBlockLines.every((l) => !l.categoryExplicit && l.category === "mainboard");
			if (eligible) {
				lastBlockLines.forEach((l) => (l.isCommander = true));
			}
		}
	}

	const lines: ParsedDecklistLine[] = internalLines.map(({ blockIndex: _b, categoryExplicit: _c, ...rest }) => rest);
	return { lines, unparsedLines };
}
