import type { DeckCardCategory } from "./data-model";


export interface ParsedDecklistLine {
	// Ligne brute d'origine (nettoyée des espaces de début/fin) — reprise
	// telle quelle dans le rapport d'import en cas d'échec de résolution
	// Scryfall, pour que l'utilisateur puisse comparer avec sa source.
	raw: string;
	quantity: number;
	name: string;
	setCode?: string;
	collectorNumber?: string;
	category: DeckCardCategory;
	// Voir le commentaire d'en-tête ci-dessus — jamais vrai en même temps
	// qu'une catégorie autre que "mainboard" (aucun marqueur Commander
	// reconnu ici ne pose jamais une autre catégorie).
	isCommander: boolean;
}

export interface ParsedDecklist {
	lines: ParsedDecklistLine[];
	// Lignes non vides dont le nom de carte est resté vide après extraction
	// (ex. une ligne composée uniquement d'un tag) — distinct des lignes dont
	// le NOM ne correspond à aucune carte Scryfall, qui ne peut être su qu'
	// après la résolution réseau (voir MTGCollectionPlugin.importDecklistToDeck).
	unparsedLines: string[];
}

// Un "rôle de board" reconnu par un marqueur (en-tête de section, préfixe
// inline, crochet Archidekt) — la catégorie réelle qu'il pose PLUS s'il
// s'agit spécifiquement du Commander (voir le commentaire d'en-tête sur
// ParsedDecklistLine.isCommander). Un seul type partagé par les 3 tables de
// marqueurs ci-dessous plutôt que 3 paires de champs parallèles.
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

// "Commander: Korvold…"/"SB: 1 Some Card" — une carte isolée hors bloc, sans
// changer la section en cours pour les lignes suivantes (contrairement à un
// en-tête sur sa propre ligne, voir SECTION_HEADERS ci-dessus).
const INLINE_PREFIXES: { pattern: RegExp; role: BoardRole }[] = [
	{ pattern: /^(commander|commanders)\s*:\s*/i, role: { category: "mainboard", isCommander: true } },
	{ pattern: /^(sb|sideboard)\s*:\s*/i, role: { category: "sideboard", isCommander: false } },
	{ pattern: /^(maybe|maybeboard)\s*:\s*/i, role: { category: "maybeboard", isCommander: false } },
];

// Catégories Archidekt "[Category]" reconnues comme un vrai rôle de board —
// toute autre valeur (ex. "[Ramp]", une étiquette de construction de deck
// perso) est un tag Archidekt légitime mais qu'aucun rôle ci-dessous ne sait
// représenter : simplement retirée de la ligne sans changer sa catégorie.
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

	// Étiquette Archidekt "^Label,#hex^" en fin de ligne — purement
	// cosmétique côté Archidekt, simplement retirée.
	rest = rest.replace(/\s*\^[^^]*\^\s*$/, "").trim();

	// Catégorie Archidekt "[Category]" en fin de ligne.
	let bracketRole: BoardRole | undefined;
	const bracketMatch = rest.match(/\s*\[([^\]]+)\]\s*$/);
	if (bracketMatch) {
		rest = rest.slice(0, bracketMatch.index).trim();
		const key = bracketMatch[1].trim().toLowerCase();
		if (BRACKET_ROLE[key]) bracketRole = BRACKET_ROLE[key];
	}

	// Marqueur foil/etched Archidekt ("*F*", "*E*"…) — DeckCard n'a pas de
	// champ finish (voir "Data model notes" dans CLAUDE.md), simplement
	// ignoré plutôt qu'interprété.
	rest = rest.replace(/\s*\*[A-Za-z]+\*\s*$/, "").trim();

	// Quantité en tête ("1x", "4 "…) — 1 par défaut si absente (une ligne
	// sans quantité explicite, ex. un simple export "carte par ligne" sans
	// compteur, reste une carte unique).
	let quantity = 1;
	const qtyMatch = rest.match(/^(\d+)\s*[xX]?\s+(.+)$/);
	if (qtyMatch) {
		quantity = Math.max(1, parseInt(qtyMatch[1], 10) || 1);
		rest = qtyMatch[2].trim();
	}

	// Édition + numéro de collection en fin de ligne, ex. "(C21) 263" — un
	// code d'édition Scryfall fait 2 à 5 caractères alphanumériques ; le
	// numéro qui suit peut contenir des lettres/symboles (variantes, ★…),
	// volontairement permissif plutôt que \d+ strict. Le nom de carte lui-même
	// n'est jamais confondu avec ceci : un nom réel contenant des parenthèses
	// (ex. "Erase (Not the Urza's Legacy One)") a toujours plus qu'un simple
	// token alphanumérique court entre les parenthèses, donc ne matche pas ce
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

// Une ligne interne de travail, avant que la dernière passe ("dernier bloc =
// Commander" ci-dessous) et le nettoyage final n'en fassent un
// ParsedDecklistLine public. `blockIndex` identifie le groupe de lignes
// séparé des autres par au moins une ligne vide (0 pour le tout premier) ;
// `categoryExplicit` distingue "mainboard/pas Commander parce que rien ne
// dit le contraire" (candidate à l'heuristique) de "un vrai marqueur a posé
// cette catégorie/ce statut Commander explicitement" (jamais retaguée après
// coup) — couvre category ET isCommander à la fois, un marqueur pose
// toujours les deux ensemble (voir BoardRole).
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
			// Ignore une ligne vide tant qu'aucun contenu réel n'a encore été vu
			// (des lignes vides en tête de texte ne doivent jamais compter comme
			// une frontière de bloc).
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

		// Un commentaire "// …" peut aussi servir d'en-tête de section (une
		// convention vue dans plusieurs exports/import de decklists) — traité
		// exactement comme la ligne qu'il commente une fois "//" retiré.
		if (line.startsWith("//")) {
			line = line.slice(2).trim();
			if (!line) continue;
		}

		// En-tête de section sur sa propre ligne ("Commander", "Deck (99)",
		// "Sideboard:"…) — jamais ajouté comme carte, change juste le rôle
		// appliqué aux lignes suivantes jusqu'au prochain en-tête.
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
		// lastBlockIndex > 0 : il existe un bloc précédent séparé par une
		// ligne vide — un texte qui n'a jamais eu de ligne vide du tout (donc
		// un seul bloc, blockIndex 0 partout) n'active jamais cette
		// heuristique, même s'il ne contient que 1-2 cartes au total.
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
