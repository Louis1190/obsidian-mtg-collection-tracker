import { Finish, LANGUAGES, getCondition } from "./card-model";
import { MAIN_TYPES, isLand } from "./card-sorting";

// Recherche enrichie par mots-clés, à facettes : les mots-clés de MÊME
// catégorie se combinent en OU ("green" + "blue" = vert OU bleu), tandis que
// des catégories différentes se combinent en ET ("rare" + "blue" = rare ET
// bleu). C'est le fonctionnement habituel des filtres à facettes (Scryfall,
// la plupart des deckbuilders). Le texte libre (nom/édition/artiste/type)
// reste en ET : chaque mot doit se retrouver quelque part.
export const COLOR_SEARCH_KEYWORDS: Record<string, string> = {
	white: "W",
	blue: "U",
	black: "B",
	red: "R",
	green: "G",
};

export const RARITY_SEARCH_KEYWORDS = ["common", "uncommon", "rare", "mythic"];

export interface SearchableCard {
	name: string;
	rarity: string;
	typeLine: string;
	setName: string;
	setCode?: string;
	collectorNumber?: string;
	artist: string;
	colors: string[];
	language?: string;
	condition?: string;
	finish?: Finish;
	keywords?: string[];
	manaValue?: number;
	priceUsd?: string;
	count?: number;
	dateAdded?: number;
	// Bordure/cadre (catégorie "border", voir BORDER_SEARCH_OPTIONS et
	// borderTokenMatches plus bas) — contrairement à "legality", cette donnée
	// EST un champ intrinsèque de la carte (persisté sur CollectionCard/DeckCard/
	// WantlistCard eux-mêmes, voir leur propre commentaire dans types.ts/
	// data-model.ts), donc pas besoin d'une Map fournie à part par l'appelant
	// — borderTokenMatches peut rejoindre TOKEN_MATCHERS directement.
	borderColor?: string;
	frame?: string;
	frameEffects?: string[];
	// Texte de règles (catégorie "oracle", filtre "oracle:") — même raison
	// d'être optionnelle que borderColor/frame/frameEffects ci-dessus : une
	// donnée intrinsèque et IMMUABLE de la carte (le texte oracle d'une
	// impression ne change jamais, sauf erratum — très rare), donc persistée
	// directement sur la carte plutôt que via une Map à part comme
	// "legality" ci-dessous. Combine les deux faces pour une carte recto-
	// verso (voir buildCardTextInfo, scryfall.ts, déjà utilisé par la boîte
	// "Card Text" du détail carte — même fonction, même résultat, juste
	// persisté ici plutôt que refetché à chaque ouverture de modale).
	oracleText?: string;
	// Nécessaire uniquement pour la catégorie "legality" (voir
	// legalityTokenMatches ci-dessous) : la légalité elle-même n'est jamais
	// stockée sur la carte (voir MTGCollectionPlugin.legalitiesCache, jamais
	// persisté), donc le matcher doit la résoudre à part via cet id, dans une
	// Map fournie séparément par l'appelant — même raison d'être que
	// recentlyAddedIds un peu plus bas dans ce fichier.
	scryfallId?: string;
}

export type TokenCategory =
	| "color"
	| "rarity"
	| "language"
	| "condition"
	| "foil"
	| "type"
	| "keyword"
	| "artist"
	| "set"
	| "cardnum"
	| "numeric_cmc"
	| "numeric_price"
	| "numeric_qty"
	| "numeric_added"
	| "recentlyadded"
	| "legality"
	| "border"
	| "oracle"
	| "text";

export const TYPE_SEARCH_KEYWORDS = [...MAIN_TYPES, "Legendary", "Basic", "Snow", "World"];

// "mint" pointait vers NM avant l'ajout du palier MT distinct (voir
// CONDITIONS, types.ts) — désormais réservé à MT seul, pour éviter que
// recognizeKeywordToken() (un .find(), le premier match dans l'ordre du
// tableau gagne) ne résolve "mint" vers le mauvais palier.
export const CONDITION_SEARCH_ENTRIES: { value: string; keywords: string[] }[] = [
	{ value: "MT", keywords: ["mt", "mint"] },
	{ value: "NM", keywords: ["nm", "near"] },
	{ value: "EX", keywords: ["ex", "excellent"] },
	{ value: "GD", keywords: ["gd", "good"] },
	{ value: "LP", keywords: ["lp", "light"] },
	{ value: "PL", keywords: ["pl", "played"] },
	{ value: "PO", keywords: ["po", "poor"] },
];

export const LEGALITY_SEARCH_FORMATS: { key: string; label: string }[] = [
	{ key: "standard", label: "Standard" },
	{ key: "pioneer", label: "Pioneer" },
	{ key: "modern", label: "Modern" },
	{ key: "legacy", label: "Legacy" },
	{ key: "vintage", label: "Vintage" },
	{ key: "commander", label: "Commander" },
	{ key: "pauper", label: "Pauper" },
	{ key: "brawl", label: "Brawl" },
	{ key: "gladiator", label: "Gladiator" },
	{ key: "timeless", label: "Timeless" },
	{ key: "future", label: "Future" },
	{ key: "historic", label: "Historic" },
	{ key: "penny", label: "Penny Dreadful" },
	{ key: "oathbreaker", label: "Oathbreaker" },
	{ key: "standardbrawl", label: "Standard Brawl" },
	{ key: "competitivebrawl", label: "Competitive Brawl" },
	{ key: "alchemy", label: "Alchemy" },
	{ key: "paupercommander", label: "Pauper Commander" },
	{ key: "duel", label: "Duel Commander" },
	{ key: "oldschool", label: "Old School" },
	{ key: "premodern", label: "Premodern" },
	{ key: "predh", label: "PreDH" },
	{ key: "tlr", label: "Tiny Leaders" },
];

// Les 3 préfixes de recherche de légalité — "legal:"/"banned:"/"restricted:"
// existent TOUS les trois tels quels côté Scryfall (confirmé en direct sur
// /cards/search le 2026-08-21 : banned:legacy et restricted:vintage
// renvoient de vrais résultats, pas juste legal:). Une seule catégorie
// "legality" pour les 3 plutôt que 3 catégories séparées — la mécanique
// sous-jacente est identique (format + Map de légalités fournie par
// l'appelant, voir legalityTokenMatches), seul le statut recherché diffère.
// Aucun préfixe n'est un préfixe d'un autre, donc l'ordre de ce tableau n'a
// pas d'importance pour matchLegalityPrefix ci-dessous.
const LEGALITY_STATUS_PREFIXES: { prefix: string; status: string }[] = [
	{ prefix: "legal:", status: "legal" },
	{ prefix: "banned:", status: "banned" },
	{ prefix: "restricted:", status: "restricted" },
];

function matchLegalityPrefix(q: string): { prefix: string; status: string } | undefined {
	return LEGALITY_STATUS_PREFIXES.find((p) => q.startsWith(p.prefix));
}

// Traduit un statut brut Scryfall (legalities[format], ex. "legal"/
// "banned"/"restricted"/"not_legal") vers la classe CSS de la tuile
// correspondante dans le bloc "Legal Formats" (voir .mtg-legal-format-tile
// .is-* dans styles.css, et renderLegalityColorLegend, card-detail-fx.ts,
// pour la légende qui explique ce code couleur). "not_legal" et toute
// valeur absente/inconnue restent sur l'apparence neutre par défaut de la
// tuile (pas de classe ajoutée) — pas besoin d'un 4ᵉ cas spécial, l'état
// "au repos" de la tuile EST déjà ce rendu. Fonction pure (pas de DOM)
// plutôt qu'inline dans les 2 modales qui l'utilisent : partagée entre
// CardDetailModal et WantlistCardDetailModal, et couverte par un test
// (contrairement au reste de ces 2 fichiers, voir "Conventions" du
// CLAUDE.md du projet).
export function legalityStatusClass(status: string | undefined): string | null {
	if (status === "legal") return "is-legal";
	if (status === "restricted") return "is-restricted";
	if (status === "banned") return "is-banned";
	return null;
}

// Petit badge de légalité par carte dans My Decks (voir buildDeckCardRow/
// buildDeckCardTile, view.ts) — distinct de legalityStatusClass ci-dessus :
// ce badge ne concerne qu'UN SEUL format à la fois (celui choisi pour le
// deck, Deck.format), donc contrairement à la grille des 23 tuiles "Legal
// Formats" (où "not_legal" est l'état neutre attendu pour la plupart des
// formats, jamais mis en avant), "not_legal" ICI est une information réelle
// et voulue — la carte casse la légalité du format que le deck s'est
// lui-même donné, ça vaut la peine de le signaler. `status` undefined =
// légalité pas encore chargée (voir MTGCollectionPlugin.getCachedLegalities)
// ou format non reconnu : renvoie null, pour ne rien afficher plutôt qu'un
// badge neutre trompeur.
export function deckLegalityBadge(
	status: string | undefined,
	formatLabel: string
): { cls: string; title: string } | null {
	if (status === "legal") return { cls: "is-legal", title: `Legal in ${formatLabel}` };
	if (status === "restricted") return { cls: "is-restricted", title: `Restricted in ${formatLabel}` };
	if (status === "banned") return { cls: "is-banned", title: `Banned in ${formatLabel}` };
	if (status === "not_legal") return { cls: "is-not-legal", title: `Not legal in ${formatLabel}` };
	return null;
}

export interface BorderSearchOption {
	value: string; // suffixe après "border:", ex. "border:showcase"
	label: string;
	scryfallClause: string;
	matches: (card: SearchableCard) => boolean;
}

export const BORDER_SEARCH_OPTIONS: BorderSearchOption[] = [
	{
		value: "borderless",
		label: "Borderless",
		scryfallClause: "border:borderless",
		matches: (c) => c.borderColor === "borderless",
	},
	{
		value: "extended",
		label: "Extended art",
		scryfallClause: "frame:extendedart",
		matches: (c) => !!c.frameEffects?.includes("extendedart"),
	},
	{
		value: "showcase",
		label: "Showcase",
		scryfallClause: "frame:showcase",
		matches: (c) => !!c.frameEffects?.includes("showcase"),
	},
	// Ni une couleur de bordure ni un frame_effect — c'est l'ancien cadre
	// (frame === "1997"), utilisé par les réimpressions "cadre rétro" (ex.
	// Dominaria Remastered).
	{
		value: "retro",
		label: "Retro frame",
		scryfallClause: "frame:1997",
		matches: (c) => c.frame === "1997",
	},
	{
		value: "black",
		label: "Black border",
		scryfallClause: "border:black",
		matches: (c) => c.borderColor === "black",
	},
	{
		value: "white",
		label: "White border",
		scryfallClause: "border:white",
		matches: (c) => c.borderColor === "white",
	},
	{
		value: "silver",
		label: "Silver border",
		scryfallClause: "border:silver",
		matches: (c) => c.borderColor === "silver",
	},
	// 0 carte connue avec cette valeur au 2026-08-16 (confirmée en direct sur
	// /cards/search), mais c'est une valeur border_color réellement reconnue
	// par Scryfall — gardée pour rester correct si une future carte l'utilise.
	{
		value: "gold",
		label: "Gold border",
		scryfallClause: "border:gold",
		matches: (c) => c.borderColor === "gold",
	},
	{
		value: "yellow",
		label: "Yellow border",
		scryfallClause: "border:yellow",
		matches: (c) => c.borderColor === "yellow",
	},
];

// Capacités-clés les plus courantes, utilisées pour l'autocomplétion et le
// rendu "reconnu" des puces. La correspondance réelle (tokenMatchesCard) se
// fait directement sur le tableau "keywords" fourni par Scryfall pour chaque
// carte, donc une capacité absente de cette liste reste quand même
// cherchable (juste sans puce dédiée ni suggestion).
export const KEYWORD_ABILITIES = [
	"Flying",
	"Trample",
	"Haste",
	"Vigilance",
	"Deathtouch",
	"Lifelink",
	"Reach",
	"Menace",
	"Hexproof",
	"Indestructible",
	"First strike",
	"Double strike",
	"Defender",
	"Flash",
	"Prowess",
	"Ward",
	"Flashback",
	"Convoke",
	"Delve",
	"Cycling",
	"Regenerate",
	"Shroud",
	"Fear",
	"Intimidate",
	"Cascade",
	"Persist",
	"Undying",
	"Wither",
	"Infect",
	"Exalted",
	"Extort",
	"Bestow",
	"Outlast",
	"Dash",
	"Renown",
	"Skulk",
	"Afterlife",
	"Mentor",
	"Foretell",
	"Blitz",
	"Training",
	"Reconfigure",
	"Enlist",
	"Riot",
	"Adamant",
];

// Champs numériques filtrables. "aliases" sert à reconnaître le mot tapé
// (pour déclencher le compositeur visuel) ; le jeton final stocké est
// toujours "<field><operator><value>" (ex. "cmc>3"), qu'il ait été construit
// via les boutons d'opérateur ou tapé directement par un utilisateur averti.
export interface NumericFieldDef {
	key: "cmc" | "price" | "qty" | "added";
	label: string;
	category: TokenCategory;
	aliases: string[];
	valueType: "number" | "date";
}

export const NUMERIC_FIELDS: NumericFieldDef[] = [
	{
		key: "cmc",
		label: "Mana value",
		category: "numeric_cmc",
		aliases: ["cmc", "mana value", "manavalue", "mv"],
		valueType: "number",
	},
	{
		key: "price",
		label: "Price",
		category: "numeric_price",
		aliases: ["price", "cost"],
		valueType: "number",
	},
	{
		key: "qty",
		label: "Quantity",
		category: "numeric_qty",
		aliases: ["qty", "quantity", "count"],
		valueType: "number",
	},
	{
		key: "added",
		label: "Date added",
		category: "numeric_added",
		aliases: ["added", "date added", "date"],
		valueType: "date",
	},
];

export const NUMERIC_OPERATORS = ["<", "<=", "=", ">=", ">"] as const;
export type NumericOperator = (typeof NUMERIC_OPERATORS)[number];

// La valeur peut être un nombre (cmc/price/qty) ou une date ISO (added).
export const NUMERIC_TOKEN_RE = /^(cmc|price|qty|added)(>=|<=|>|<|=)(\d{4}-\d{2}-\d{2}|\d+(?:\.\d+)?)$/i;

export function matchNumericField(query: string): NumericFieldDef | null {
	const q = query.trim().toLowerCase();
	if (q.length < 2) return null;
	return NUMERIC_FIELDS.find((f) => f.aliases.some((a) => a.startsWith(q))) ?? null;
}

export interface ParsedNumericToken {
	field: NumericFieldDef;
	operator: NumericOperator;
	value: number; // nombre brut, ou timestamp de minuit (début de journée) pour une date
	rawDateStr?: string; // texte "AAAA-MM-JJ" d'origine, pour l'affichage de la puce
}

export function parseNumericToken(token: string): ParsedNumericToken | null {
	const match = NUMERIC_TOKEN_RE.exec(token.trim());
	if (!match) return null;
	const field = NUMERIC_FIELDS.find((f) => f.key === match[1].toLowerCase());
	if (!field) return null;
	const operator = match[2] as NumericOperator;

	if (field.valueType === "date") {
		const [y, mo, d] = match[3].split("-").map(Number);
		const startOfDay = new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();
		if (isNaN(startOfDay)) return null;
		return { field, operator, value: startOfDay, rawDateStr: match[3] };
	}
	return { field, operator, value: parseFloat(match[3]) };
}

export function numericTokenMatches(card: SearchableCard, token: string): boolean {
	const parsed = parseNumericToken(token);
	if (!parsed) return false;

	// Pour une date, on compare sur la journée entière : "= 2026-07-15" doit
	// matcher toute carte ajoutée ce jour-là, quelle que soit l'heure exacte.
	if (parsed.field.valueType === "date") {
		if (card.dateAdded === undefined) return false;
		const startOfDay = parsed.value;
		const endOfDay = startOfDay + 24 * 60 * 60 * 1000 - 1;
		switch (parsed.operator) {
			case "<":
				return card.dateAdded < startOfDay;
			case "<=":
				return card.dateAdded <= endOfDay;
			case "=":
				return card.dateAdded >= startOfDay && card.dateAdded <= endOfDay;
			case ">=":
				return card.dateAdded >= startOfDay;
			case ">":
				return card.dateAdded > endOfDay;
		}
	}

	let cardValueNum: number | undefined;
	if (parsed.field.key === "cmc") cardValueNum = card.manaValue;
	else if (parsed.field.key === "price") cardValueNum = parseFloat(card.priceUsd || "0");
	else if (parsed.field.key === "qty") cardValueNum = card.count;
	if (cardValueNum === undefined || isNaN(cardValueNum)) return false;

	switch (parsed.operator) {
		case "<":
			return cardValueNum < parsed.value;
		case "<=":
			return cardValueNum <= parsed.value;
		case "=":
			return cardValueNum === parsed.value;
		case ">=":
			return cardValueNum >= parsed.value;
		case ">":
			return cardValueNum > parsed.value;
	}
}

export function categorizeToken(token: string): TokenCategory {
	const q = token.trim().toLowerCase();
	if (!q) return "text";
	if (q.startsWith("artist:")) return "artist";
	if (q.startsWith("set:")) return "set";
	// Préfixe explicite requis (comme artist:/set: ci-dessus), pas de forme
	// nue "modern" reconnue toute seule : contrairement à un nom de couleur/
	// rareté, un nom de format n'a pas de vocabulaire réservé qui lui soit
	// propre (rien n'empêche une carte de s'appeler "Legacy" ou "Standard"),
	// donc l'ambiguïté ne peut être levée qu'en exigeant un préfixe devant —
	// "legal:"/"banned:"/"restricted:", voir LEGALITY_STATUS_PREFIXES.
	if (matchLegalityPrefix(q)) return "legality";
	// Même raisonnement que "legal:" ci-dessus : "border" n'a pas de
	// vocabulaire réservé qui lui soit propre (rien n'empêche une carte de
	// s'appeler "Showcase" ou "Retro"), donc le préfixe explicite est requis.
	if (q.startsWith("border:")) return "border";
	if (q.startsWith("oracle:")) return "oracle";
	if (/^#\d+\S*$/.test(q)) return "cardnum";
	const numericMatch = parseNumericToken(token);
	if (numericMatch) return numericMatch.field.category;
	if (Object.keys(COLOR_SEARCH_KEYWORDS).some((name) => name.startsWith(q))) return "color";
	if (q.length >= 3 && ("multicolor".startsWith(q) || "colorless".startsWith(q))) return "color";
	if (RARITY_SEARCH_KEYWORDS.some((r) => r.startsWith(q))) return "rarity";
	// La condition doit être vérifiée avant la langue : "po" (abréviation de
	// "Poor") est aussi un préfixe valide de "Portuguese" — sans cet ordre, le
	// chip "Poor" filtrait silencieusement par langue portugaise au lieu de
	// l'état "Poor" (trouvé via l'audit SUGGESTABLE_KEYWORDS/categorizeToken).
	if (
		q.length >= 2 &&
		(CONDITION_SEARCH_ENTRIES.some((e) => e.keywords.some((k) => k.startsWith(q))) ||
			"none".startsWith(q))
	)
		return "condition";
	if (LANGUAGES.some((l) => l.label.toLowerCase().startsWith(q))) return "language";
	if (
		q.length >= 3 &&
		(["foil", "nonfoil", "etched", "surged", "proxy"] as const).some((k) => k.startsWith(q))
	)
		return "foil";
	if (q.length >= 3 && "recent".startsWith(q)) return "recentlyadded";
	if (TYPE_SEARCH_KEYWORDS.some((t) => t.toLowerCase().startsWith(q))) return "type";
	if (q.length >= 3 && KEYWORD_ABILITIES.some((k) => k.toLowerCase().startsWith(q)))
		return "keyword";
	return "text";
}

// Résout un nom de couleur (préfixe, ex. "bl") vers sa lettre WUBRG — logique
// partagée par colorTokenMatches ci-dessous, chipTokenToScryfallClause (cas
// "color") et l'identité de couleur exacte ("=couleur", voir isExactToken
// plus bas) : les trois avaient chacun leur propre copie de ce même
// `Object.entries(COLOR_SEARCH_KEYWORDS).find(...)` avant que ce 3ᵉ
// consommateur ne rende la duplication triple plutôt que double.
function resolveColorLetter(name: string): string | null {
	const q = name.trim().toLowerCase();
	const entry = Object.entries(COLOR_SEARCH_KEYWORDS).find(([n]) => n.startsWith(q));
	return entry ? entry[1] : null;
}

export function colorTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	const letter = resolveColorLetter(q);
	if (letter && (card.colors ?? []).includes(letter)) return true;
	if (q.length >= 3 && "multicolor".startsWith(q) && (card.colors ?? []).length > 1) return true;
	if (
		q.length >= 3 &&
		"colorless".startsWith(q) &&
		(card.colors ?? []).length === 0 &&
		!isLand(card.typeLine)
	)
		return true;
	return false;
}

export function rarityTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	return !!card.rarity && card.rarity.toLowerCase().startsWith(q);
}

export function languageTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	const matches = LANGUAGES.filter((l) => l.label.toLowerCase().startsWith(q));
	return matches.some((l) => (card.language ?? "en") === l.code);
}

export function conditionTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	if ("none".startsWith(q) && (card.condition ?? "") === "") return true;
	return CONDITION_SEARCH_ENTRIES.some(
		(e) => e.keywords.some((k) => k.startsWith(q)) && (card.condition ?? "") === e.value
	);
}

export function foilTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	const finish = card.finish ?? "regular";
	if (q.length >= 3 && "etched".startsWith(q)) return finish === "etched";
	if (q.length >= 3 && "surged".startsWith(q)) return finish === "surged";
	if (q.length >= 3 && "proxy".startsWith(q)) return finish === "proxy";
	if (q.length >= 3 && "nonfoil".startsWith(q)) return finish === "regular" || finish === "proxy";
	if ("foil".startsWith(q)) return finish === "foiled" || finish === "etched" || finish === "surged";
	return false;
}

// Correspondance en préfixe sur la valeur OU le libellé (même convention que
// legalityTokenMatches plus bas), ex. "border:ext" et "border:extended art"
// résolvent tous deux vers l'entrée "extended". Un id de carte pas encore
// rattrapé par MTGCollectionPlugin.backfillBorderData() (borderColor/frame/
// frameEffects tous undefined) ne matche simplement aucune entrée — chaque
// matches() ci-dessus compare à une valeur précise, jamais vrai sur
// undefined — jusqu'à ce que le rattrapage arrive, sans traitement spécial
// nécessaire ici contrairement à legalityTokenMatches (pas de Map externe à
// consulter, cette donnée vit directement sur la carte).
export function borderTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	if (!q.startsWith("border:")) return false;
	const valueQuery = q.slice("border:".length);
	if (!valueQuery) return false;
	const entry = BORDER_SEARCH_OPTIONS.find(
		(o) => o.value.startsWith(valueQuery) || o.label.toLowerCase().startsWith(valueQuery)
	);
	return !!entry && entry.matches(card);
}

// Contrairement à borderTokenMatches ci-dessus (valeurs d'un ensemble fini,
// combinées en OU comme toute entrée de orCategories), une recherche de
// texte est une correspondance de sous-chaîne libre — plusieurs jetons
// "oracle:" se combinent donc en ET (chaque phrase doit se retrouver quelque
// part), même convention que textTokenMatches ci-dessous plutôt que
// TOKEN_MATCHERS/orCategories (voir son traitement à part dans
// cardMatchesTokens). Correspondance en sous-chaîne insensible à la casse
// sur le texte brut tel que fourni par Scryfall — les symboles de mana y
// sont écrits "{X}"/"{C}" etc., donc "oracle:add mana" ne matchera pas à
// moins d'inclure les accolades ("oracle:add {c}") ; documenté dans les
// modales d'aide plutôt que normalisé ici.
export function oracleTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	if (!q.startsWith("oracle:")) return false;
	const valueQuery = q.slice("oracle:".length).trim();
	if (!valueQuery) return false;
	return !!card.oracleText && card.oracleText.toLowerCase().includes(valueQuery);
}

export function typeTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	return !!card.typeLine && card.typeLine.toLowerCase().includes(q);
}

// Ces jetons sont toujours construits via une suggestion (jamais tapés à la
// main, car un nom d'artiste/édition peut contenir des espaces) : on compare
// donc en égalité stricte plutôt qu'en préfixe, sans ambiguïté possible.
export function artistTokenMatches(card: SearchableCard, token: string): boolean {
	const value = token.trim().slice("artist:".length).toLowerCase();
	return card.artist.toLowerCase() === value;
}

export function setTokenMatches(card: SearchableCard, token: string): boolean {
	const value = token.trim().slice("set:".length).toLowerCase();
	return (card.setCode ?? "").toLowerCase() === value;
}

export function cardNumTokenMatches(card: SearchableCard, token: string): boolean {
	const value = token.trim().slice(1).toLowerCase();
	return (card.collectorNumber ?? "").toLowerCase() === value;
}

// Correspond directement au tableau "keywords" fourni par Scryfall pour
// chaque carte (ex: ["Flying", "First strike"]) : couvre donc toute capacité
// existante, pas seulement celles listées dans KEYWORD_ABILITIES.
export function keywordTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	return !!card.keywords?.some((k) => k.toLowerCase().startsWith(q));
}

// Contrairement à tous les autres matchers ci-dessus, ne peut pas rejoindre
// TOKEN_MATCHERS (signature fixe (card, token) => boolean, sans contexte
// externe) : la légalité d'une carte n'est pas un champ qu'elle porte
// elle-même (voir SearchableCard.scryfallId plus haut), elle doit être
// résolue via une Map fournie par l'appelant — même raison que la catégorie
// "recentlyadded", traitée à part dans cardMatchesTokens pour la même
// raison. Un id absent de la Map (légalités pas encore récupérées pour
// cette carte) ne matche jamais un jeton positif ni un jeton négatif — un
// futur nouveau rendu, une fois le fetch en arrière-plan résolu (voir
// MTGCollectionPlugin.bulkFetchLegalities), réappliquera alors le filtre
// avec la donnée désormais connue.
export function legalityTokenMatches(
	card: SearchableCard,
	token: string,
	legalitiesByScryfallId?: Map<string, Record<string, string>>
): boolean {
	const q = token.trim().toLowerCase();
	const legalityMatch = matchLegalityPrefix(q);
	if (!legalityMatch) return false;
	const formatQuery = q.slice(legalityMatch.prefix.length);
	if (!formatQuery) return false;
	const entry = LEGALITY_SEARCH_FORMATS.find(
		(f) => f.key.startsWith(formatQuery) || f.label.toLowerCase().startsWith(formatQuery)
	);
	if (!entry || !card.scryfallId) return false;
	const legalities = legalitiesByScryfallId?.get(card.scryfallId);
	return legalities?.[entry.key] === legalityMatch.status;
}

export function textTokenMatches(card: SearchableCard, token: string): boolean {
	const q = token.trim().toLowerCase();
	if (!q) return true;
	if (card.name.toLowerCase().includes(q)) return true;
	if (card.typeLine && card.typeLine.toLowerCase().includes(q)) return true;
	if (card.setName && card.setName.toLowerCase().includes(q)) return true;
	if (card.artist && card.artist.toLowerCase().includes(q)) return true;
	if (card.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
	return false;
}

export const TOKEN_MATCHERS: Record<
	Exclude<TokenCategory, "text" | "recentlyadded" | "legality" | "oracle">,
	(card: SearchableCard, token: string) => boolean
> = {
	color: colorTokenMatches,
	rarity: rarityTokenMatches,
	language: languageTokenMatches,
	condition: conditionTokenMatches,
	foil: foilTokenMatches,
	type: typeTokenMatches,
	keyword: keywordTokenMatches,
	artist: artistTokenMatches,
	set: setTokenMatches,
	cardnum: cardNumTokenMatches,
	numeric_cmc: numericTokenMatches,
	numeric_price: numericTokenMatches,
	numeric_qty: numericTokenMatches,
	numeric_added: numericTokenMatches,
	border: borderTokenMatches,
};

// Un jeton commençant par "-" (ex. "-red") exclut toute carte qui matcherait
// ce même jeton sans le préfixe, quelle que soit sa catégorie. C'est une
// exclusion globale, indépendante du système OU/ET des jetons positifs.
export function isNegatedToken(token: string): boolean {
	return token.trim().startsWith("-") && token.trim().length > 1;
}

export function stripNegation(token: string): string {
	return token.trim().slice(1);
}

// Un jeton commençant par "=" (ex. "=blue") exprime une identité de couleur
// EXACTE plutôt qu'une simple contenance : "blue" matche toute carte
// contenant du bleu (y compris une carte multicolore blanc-bleu), tandis que
// "=blue" ne matche QUE les cartes dont les couleurs sont exactement {bleu},
// ni plus ni moins — voir cardMatchesTokens pour la combinaison en ET entre
// plusieurs jetons "=" (ex. "=blue" + "=white" = exactement bleu-blanc,
// l'équivalent de l'opérateur Scryfall c=uw). Même mécanique que
// isNegatedToken/stripNegation ci-dessus (préfixe reconnu qu'il ait été tapé
// à la main ou posé via la puce/l'icône dédiée), volontairement un préfixe
// distinct de "-" plutôt qu'un état combiné : les deux sont mutuellement
// exclusifs (voir la bascule "=" dans renderChipFilter/renderSearchChipBar,
// qui retire l'autre préfixe en posant celui-ci) mais n'ont pas de sens
// combiné ("ni exactement bleu ni pas bleu" n'exprimerait rien d'utile).
// Concept réservé à la catégorie "color" (aucune autre facette n'a de notion
// d'"identité exacte" à ce jour) — un jeton "=" hors couleur est un repli
// géré à part dans cardMatchesTokens/buildScryfallQueryFromChips plutôt que
// d'être ici une erreur de validation.
export function isExactToken(token: string): boolean {
	return token.trim().startsWith("=") && token.trim().length > 1;
}

export function stripExact(token: string): string {
	return token.trim().slice(1);
}

// Une phrase à plusieurs mots (ex. après "oracle:") doit pouvoir contenir
// des espaces sans que le mécanisme "un espace valide la puce en cours de
// frappe" (voir renderChipFilter, view.ts, et son équivalent dans
// add-cards-modal.ts) ne la découpe en plusieurs puces séparées — bug
// rapporté : taper oracle:"prevent all damage" se coupait dès le premier
// espace, la puce complète n'était donc jamais formée. Tant que le nombre
// de guillemets droits dans le texte en cours de frappe est impair (une
// phrase entre guillemets encore "ouverte"), un espace ne doit PAS valider
// la puce — comportement standard d'une barre de recherche à guillemets
// (Scryfall lui-même fonctionne ainsi). Générique, pas spécifique à
// "oracle:" : un futur préfixe ayant besoin d'une phrase à plusieurs mots
// profite du même mécanisme sans rien à changer ici.
export function hasUnclosedQuote(text: string): boolean {
	return (text.match(/"/g) ?? []).length % 2 === 1;
}

// Une fois la puce validée (espace ou Entrée), retire les guillemets qui
// entouraient la valeur — le jeton stocké/comparé (categorizeToken,
// oracleTokenMatches, chipTokenToScryfallClause, recognizeKeywordToken)
// n'a jamais besoin ni ne gère de guillemets, ceux-ci ne servent qu'à
// protéger les espaces pendant la frappe (voir hasUnclosedQuote
// ci-dessus). Scopé au préfixe "oracle:" : c'est le seul cas aujourd'hui où
// une phrase à plusieurs mots est attendue après le préfixe.
export function stripQuotesFromCommittedToken(raw: string): string {
	const trimmed = raw.trim();
	const negated = isNegatedToken(trimmed);
	const base = negated ? stripNegation(trimmed) : trimmed;
	if (!base.toLowerCase().startsWith("oracle:")) return trimmed;
	const value = base.slice("oracle:".length).trim();
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return `${negated ? "-" : ""}oracle:${value.slice(1, -1).trim()}`;
	}
	return trimmed;
}

// Catégories qui n'ont pas de sens pour une recherche Scryfall (ce sont des
// attributs propres à NOTRE collection, pas à la carte chez Scryfall) : état
// physique, quantité possédée, date d'ajout. Édition et artiste ont leur
// propre champ dédié dans la modale de recherche (pas la puce), donc exclus
// ici aussi pour éviter un double système.
export const SEARCH_EXCLUDED_CATEGORIES: TokenCategory[] = [
	"condition",
	"numeric_qty",
	"numeric_added",
	"recentlyadded",
	"artist",
	"set",
];

// Traduit un jeton unique (ex. "blue", "-rare", "cmc>3") vers la clause
// Scryfall correspondante (ex. "c:u", "-r:rare", "cmc>3"). Renvoie null si la
// catégorie est exclue de la recherche ou non reconnue.
export function chipTokenToScryfallClause(token: string): string | null {
	const negated = isNegatedToken(token);
	const base = negated ? stripNegation(token) : token;
	const q = base.trim().toLowerCase();
	if (!q) return null;
	const cat = categorizeToken(base);
	if (SEARCH_EXCLUDED_CATEGORIES.includes(cat)) return null;
	const prefix = negated ? "-" : "";

	switch (cat) {
		case "color": {
			if ("multicolor".startsWith(q)) return `${prefix}c:m`;
			if ("colorless".startsWith(q)) return `${prefix}c:c`;
			const letter = resolveColorLetter(q);
			return letter ? `${prefix}c:${letter.toLowerCase()}` : null;
		}
		case "rarity": {
			const r = RARITY_SEARCH_KEYWORDS.find((r) => r.startsWith(q));
			return r ? `${prefix}r:${r}` : null;
		}
		case "type": {
			const t = TYPE_SEARCH_KEYWORDS.find((t) => t.toLowerCase().startsWith(q));
			return t ? `${prefix}t:${t.toLowerCase()}` : null;
		}
		case "keyword": {
			const k = KEYWORD_ABILITIES.find((k) => k.toLowerCase().startsWith(q));
			return k ? `${prefix}keyword:"${k}"` : null;
		}
		case "foil": {
			// "proxy" et "surged" n'ont pas d'équivalent côté Scryfall ("surged" est
			// un statut propre à notre collection — Scryfall n'a pas d'opérateur
			// is:surgefoil documenté, contrairement à is:etched) : ignorés ici, la
			// puce reste utile pour filtrer nos propres cartes possédées.
			if (q.length >= 3 && "etched".startsWith(q)) return `${prefix}is:etched`;
			if (q.length >= 3 && "surged".startsWith(q)) return null;
			if (q.length >= 3 && "proxy".startsWith(q)) return null;
			if (q.length >= 3 && "nonfoil".startsWith(q)) return negated ? "is:foil" : "-is:foil";
			if ("foil".startsWith(q)) return `${prefix}is:foil`;
			return null;
		}
		case "language": {
			const l = LANGUAGES.find((l) => l.label.toLowerCase().startsWith(q));
			return l ? `${prefix}lang:${l.code}` : null;
		}
		case "numeric_cmc": {
			const parsed = parseNumericToken(base);
			return parsed ? `${prefix}cmc${parsed.operator}${parsed.value}` : null;
		}
		case "numeric_price": {
			const parsed = parseNumericToken(base);
			return parsed ? `${prefix}usd${parsed.operator}${parsed.value}` : null;
		}
		case "legality": {
			// Contrairement à condition/qty/added (exclus via
			// SEARCH_EXCLUDED_CATEGORIES, propres à notre collection), la
			// légalité EST un concept Scryfall — legal:/banned:/restricted:
			// existent tels quels côté Scryfall (voir LEGALITY_STATUS_PREFIXES),
			// donc la modale "Add Cards" peut transmettre le jeton directement
			// plutôt que le filtrer.
			const legalityMatch = matchLegalityPrefix(q);
			if (!legalityMatch) return null;
			const formatQ = q.slice(legalityMatch.prefix.length);
			const entry = LEGALITY_SEARCH_FORMATS.find(
				(f) => f.key.startsWith(formatQ) || f.label.toLowerCase().startsWith(formatQ)
			);
			return entry ? `${prefix}${legalityMatch.prefix}${entry.key}` : null;
		}
		case "border": {
			// Même raisonnement que "legality" ci-dessus : border/frame SONT
			// des concepts Scryfall (border:/frame: existent tels quels), donc
			// transmis directement plutôt que filtrés (voir BORDER_SEARCH_OPTIONS
			// pour la traduction valeur → clause).
			const valueQ = q.slice("border:".length);
			const entry = BORDER_SEARCH_OPTIONS.find(
				(o) => o.value.startsWith(valueQ) || o.label.toLowerCase().startsWith(valueQ)
			);
			return entry ? `${prefix}${entry.scryfallClause}` : null;
		}
		case "oracle": {
			// Contrairement à condition/qty/added (exclus), "oracle:" EST
			// l'opérateur Scryfall réel (oracle:"...") — transmis directement,
			// entre guillemets pour couvrir une phrase à plusieurs mots. Un
			// guillemet éventuel dans la valeur tapée est retiré plutôt
			// qu'échappé : casserait sinon la clause générée.
			const value = q.slice("oracle:".length).trim().replace(/"/g, "");
			return value ? `${prefix}oracle:"${value}"` : null;
		}
		default:
			return null;
	}
}

// Construit la requête Scryfall complète à partir de nos jetons de puces : le
// texte libre (nom de carte) passe tel quel, chaque facette reconnue devient
// une clause Scryfall (voir chipTokenToScryfallClause).
// Regex propres à la barre de recherche d'ajout (pas au filtre de
// collection) : "#235" pour un numéro de collection, "set:xyz" (code, pas
// nom complet) pour une édition choisie via suggestion dans cette même
// barre. Interceptés avant categorizeToken pour ne pas entrer en collision
// avec le sens de "set:" dans le filtre de collection (qui lui stocke un nom
// complet, pas un code).
export const SEARCH_COLLECTOR_NUM_RE = /^#\d+\S*$/;
export const SEARCH_SET_CODE_RE = /^set:/i;

export function buildScryfallQueryFromChips(tokens: string[], draft: string): string {
	const allTokens = draft.trim() ? [...tokens, draft] : tokens;
	const parts: string[] = [];

	// Identité de couleur exacte ("=blue" [+ "=white" ...], voir isExactToken) :
	// contrairement à chaque autre facette (chipTokenToScryfallClause traduit
	// un jeton isolé sans connaître les autres), plusieurs jetons "=" doivent
	// fusionner en UNE seule clause Scryfall combinée ("c=uw") — l'opérateur
	// c= de Scryfall affirme une identité de couleur EXACTE à lui seul, donc
	// deux clauses "c=u" et "c=w" séparées (combinées en ET comme le fait
	// Scryfall entre clauses espacées par un espace) ne matcheraient jamais
	// aucune carte, une identité ne pouvant égaler deux valeurs différentes à
	// la fois. Extrait à part, avant la boucle générique ci-dessous, plutôt
	// que dans chipTokenToScryfallClause (qui ne voit qu'un jeton isolé).
	const exactColorLetters = new Set<string>();
	const remainingTokens: string[] = [];
	allTokens.forEach((token) => {
		if (!isExactToken(token)) {
			remainingTokens.push(token);
			return;
		}
		const base = stripExact(token);
		const letter = categorizeToken(base) === "color" ? resolveColorLetter(base) : null;
		if (letter) {
			exactColorLetters.add(letter);
			return;
		}
		// Repli : jeton "=" hors couleur (jamais produit par l'UI, qui ne pose
		// cette bascule que sur une puce couleur, mais un jeton tapé/importé à
		// la main reste possible) — traité comme un jeton ordinaire, le "="
		// n'aurait ici aucun sens à transmettre.
		remainingTokens.push(base);
	});
	if (exactColorLetters.size > 0) {
		// Ordre canonique WUBRG plutôt que l'ordre d'insertion des puces —
		// COLOR_SEARCH_KEYWORDS est déjà déclaré dans cet ordre.
		const ordered = Object.values(COLOR_SEARCH_KEYWORDS).filter((l) => exactColorLetters.has(l));
		parts.push(`c=${ordered.join("").toLowerCase()}`);
	}

	// Éditions ("set:xyz") : comme l'identité de couleur exacte ci-dessus,
	// plusieurs jetons POSITIFS "set:" doivent fusionner en UNE seule clause
	// avec l'opérateur "or" de Scryfall entre parenthèses — bug rapporté
	// ("impossible d'afficher les cartes de deux extensions en même temps")
	// : traitées comme n'importe quelle autre clause (une par jeton, jointes
	// par un espace = ET pour Scryfall), deux clauses "s:x s:y" séparées
	// exigeraient qu'une carte appartienne à DEUX éditions à la fois, ce
	// qu'aucune carte ne peut jamais satisfaire. "set" figure pourtant bien
	// dans orCategories (voir cardMatchesTokens plus haut, qui filtre
	// correctement en OU sur la collection déjà possédée) — le bug était
	// spécifique à CETTE fonction, qui construit une requête Scryfall
	// textuelle plutôt que d'évaluer un prédicat carte par carte, et n'avait
	// jamais reçu le même traitement de fusion que l'identité de couleur
	// exacte au-dessus. Un jeton "set:" NÉGATIF reste une clause "-s:x"
	// séparée, ANDée avec le reste comme toute autre négation (exclure DEUX
	// éditions à la fois est un ET parfaitement valide, contrairement à
	// l'inclusion) — laissé tel quel dans la boucle générique plus bas.
	const positiveSetCodes: string[] = [];
	const tokensAfterSetExtraction: string[] = [];
	remainingTokens.forEach((token) => {
		const negated = isNegatedToken(token);
		const base = negated ? stripNegation(token) : token;
		if (!negated && SEARCH_SET_CODE_RE.test(base)) {
			positiveSetCodes.push(base.slice(4).toLowerCase());
		} else {
			tokensAfterSetExtraction.push(token);
		}
	});
	if (positiveSetCodes.length === 1) {
		parts.push(`s:${positiveSetCodes[0]}`);
	} else if (positiveSetCodes.length > 1) {
		parts.push(`(${positiveSetCodes.map((c) => `s:${c}`).join(" or ")})`);
	}

	tokensAfterSetExtraction.forEach((token) => {
		const negated = isNegatedToken(token);
		const base = negated ? stripNegation(token) : token;
		if (!base.trim()) return;
		const prefix = negated ? "-" : "";

		if (SEARCH_SET_CODE_RE.test(base)) {
			parts.push(`${prefix}s:${base.slice(4).toLowerCase()}`);
			return;
		}
		if (SEARCH_COLLECTOR_NUM_RE.test(base)) {
			parts.push(`${prefix}cn:${base.slice(1)}`);
			return;
		}

		const cat = categorizeToken(base);
		if (SEARCH_EXCLUDED_CATEGORIES.includes(cat)) return;
		if (cat === "text") {
			const words = base.trim();
			parts.push(negated ? `-${words}` : words);
			return;
		}
		const clause = chipTokenToScryfallClause(token);
		if (clause) parts.push(clause);
	});
	return parts.join(" ");
}

// Si les puces "set:xyz" et "#numéro" sont toutes les deux présentes (et non
// exclues), on peut encore emprunter le lookup exact rapide de searchScryfall
// plutôt que de repasser par la recherche générale à chaque frappe. Un
// set+numéro identifie une impression unique -> ne s'applique que s'il y a
// EXACTEMENT une puce "set:" positive : avec deux puces set: ou plus (ex.
// "The Hobbit" + "The Hobbit Eternal" + "#139"), il n'existe plus une seule
// impression "évidente" à cibler (le numéro peut exister dans l'un ou
// l'autre set, jamais les deux) — retourner ici le dernier set vu (comme
// avant ce correctif) pinçait silencieusement la recherche sur CE seul set,
// contredisant la fusion "(s:x or s:y)" que buildScryfallQueryFromChips
// applique par ailleurs pour ce même cas (voir son propre commentaire) :
// searchScryfall ANDait alors ce set unique avec la clause OR correcte,
// annulant le OR et ne renvoyant aucun résultat si la carte se trouvait dans
// l'autre set. setCode reste "" dans ce cas, pour que searchScryfall retombe
// sur la recherche générale (qui, elle, voit bien le chipQuery fusionné en
// OU).
export function extractExactLookupHints(
	tokens: string[],
	draft: string
): { setCode: string; collectorNumber: string } {
	const allTokens = draft.trim() ? [...tokens, draft] : tokens;
	const setCodes: string[] = [];
	let collectorNumber = "";
	allTokens.forEach((token) => {
		if (isNegatedToken(token)) return;
		if (SEARCH_SET_CODE_RE.test(token)) setCodes.push(token.slice(4).toLowerCase());
		else if (SEARCH_COLLECTOR_NUM_RE.test(token)) collectorNumber = token.slice(1);
	});
	return { setCode: setCodes.length === 1 ? setCodes[0] : "", collectorNumber };
}

export function cardMatchesTokens(
	card: SearchableCard,
	tokens: string[],
	draft: string,
	recentlyAddedIds?: Set<string>,
	legalitiesByScryfallId?: Map<string, Record<string, string>>
): boolean {
	const allTokens = draft.trim() ? [...tokens, draft] : tokens;
	if (allTokens.length === 0) return true;

	const positiveTokens: string[] = [];
	const negativeTokens: string[] = [];
	// Identité de couleur exacte ("=blue" [+ "=white" ...], voir isExactToken)
	// — extraite à part plutôt que dans positiveTokens/buckets.color : ce
	// n'est pas une alternative OR comme un jeton couleur ordinaire, mais une
	// contrainte à part entière ("le jeu de couleurs de la carte doit égaler
	// EXACTEMENT ceci"), vérifiée juste après cette boucle.
	const exactColorLetters = new Set<string>();
	allTokens.forEach((t) => {
		if (isNegatedToken(t)) {
			negativeTokens.push(stripNegation(t));
			return;
		}
		if (isExactToken(t)) {
			const base = stripExact(t);
			const letter = categorizeToken(base) === "color" ? resolveColorLetter(base) : null;
			if (letter) {
				exactColorLetters.add(letter);
				return;
			}
			// Repli : jeton "=" hors couleur (jamais produit par l'UI, mais un
			// jeton tapé/importé à la main reste possible) — redevient un
			// jeton positif ordinaire plutôt que d'être silencieusement ignoré.
			positiveTokens.push(base);
			return;
		}
		positiveTokens.push(t);
	});

	// Vérifiée tout de suite, avant le "return true" précoce plus bas (aucun
	// autre jeton positif présent) qui sinon la court-circuiterait : un jeton
	// "=" combine plusieurs couleurs en ET (le jeu de couleurs de la carte
	// doit égaler EXACTEMENT l'union des lettres marquées, ni plus ni moins).
	if (exactColorLetters.size > 0) {
		const cardColors = new Set(card.colors ?? []);
		if (cardColors.size !== exactColorLetters.size) return false;
		for (const letter of exactColorLetters) {
			if (!cardColors.has(letter)) return false;
		}
	}

	// Catégorie booléenne pure, dépendante d'un état de session
	// (this.plugin.recentlyAddedCardIds) plutôt que d'un champ intrinsèque de
	// la carte — TOKEN_MATCHERS (signature (card, token) => boolean, sans
	// accès à un contexte externe) ne peut pas l'exprimer, donc traitée à
	// part plutôt que d'y ajouter une entrée qui ignorerait cet état.
	const isRecentlyAdded = () =>
		recentlyAddedIds?.has((card as { id?: string }).id ?? "") ?? false;

	for (const negToken of negativeTokens) {
		const cat = categorizeToken(negToken);
		if (cat === "recentlyadded") {
			if (isRecentlyAdded()) return false;
			continue;
		}
		// Même traitement à part que "recentlyadded" ci-dessus, voir
		// legalityTokenMatches pour pourquoi. Un id pas encore résolu ne
		// matche jamais legalityTokenMatches (positif ni négatif) : une
		// carte dont on ne connaît pas encore la légalité n'est donc PAS
		// exclue par un jeton négatif tant que la donnée n'est pas arrivée —
		// le comportement sûr par défaut, un futur rendu la réévaluera.
		if (cat === "legality") {
			if (legalityTokenMatches(card, negToken, legalitiesByScryfallId)) return false;
			continue;
		}
		const matcher =
			cat === "text" ? textTokenMatches : cat === "oracle" ? oracleTokenMatches : TOKEN_MATCHERS[cat];
		if (matcher(card, negToken)) return false;
	}

	if (positiveTokens.length === 0) return true;

	const buckets: Record<TokenCategory, string[]> = {
		color: [],
		rarity: [],
		language: [],
		condition: [],
		foil: [],
		type: [],
		keyword: [],
		artist: [],
		set: [],
		cardnum: [],
		numeric_cmc: [],
		numeric_price: [],
		numeric_qty: [],
		numeric_added: [],
		recentlyadded: [],
		legality: [],
		border: [],
		oracle: [],
		text: [],
	};
	positiveTokens.forEach((t) => buckets[categorizeToken(t)].push(t));

	const orCategories = [
		"color",
		"rarity",
		"language",
		"condition",
		"foil",
		"type",
		"keyword",
		"artist",
		"set",
		"cardnum",
		"border",
	] as const;
	for (const cat of orCategories) {
		const catTokens = buckets[cat];
		if (catTokens.length === 0) continue;
		const matcher = TOKEN_MATCHERS[cat];
		if (!catTokens.some((t) => matcher(card, t))) return false;
	}

	// Champs numériques : plusieurs contraintes sur le même champ forment une
	// plage ("cmc>2" + "cmc<5" = ET), pas une alternative.
	const numericCategories = ["numeric_cmc", "numeric_price", "numeric_qty", "numeric_added"] as const;
	for (const cat of numericCategories) {
		const catTokens = buckets[cat];
		if (catTokens.length === 0) continue;
		const matcher = TOKEN_MATCHERS[cat];
		if (!catTokens.every((t) => matcher(card, t))) return false;
	}

	if (buckets.recentlyadded.length > 0 && !isRecentlyAdded()) return false;

	// Plusieurs formats en OU ("legal:modern" + "legal:legacy" = légale dans
	// l'un OU l'autre), même convention que orCategories ci-dessus.
	if (
		buckets.legality.length > 0 &&
		!buckets.legality.some((t) => legalityTokenMatches(card, t, legalitiesByScryfallId))
	)
		return false;

	// ET entre plusieurs jetons "oracle:" (chaque phrase doit apparaître),
	// même convention que buckets.text ci-dessous — voir oracleTokenMatches.
	if (buckets.oracle.length > 0 && !buckets.oracle.every((t) => oracleTokenMatches(card, t)))
		return false;

	if (buckets.text.length > 0 && !buckets.text.every((t) => textTokenMatches(card, t)))
		return false;

	return true;
}

// Vrai si au moins un jeton (validé ou brouillon en cours de frappe) est un
// filtre de légalité — utilisé par MTGCollectionView pour déclencher le
// pré-fetch en arrière-plan des légalités de la liste ouverte (voir
// MTGCollectionPlugin.bulkFetchLegalities) uniquement quand c'est
// effectivement nécessaire, pas à chaque rendu.
export function tokensNeedLegalityData(tokens: string[], draft: string): boolean {
	const allTokens = draft.trim() ? [...tokens, draft] : tokens;
	return allTokens.some((t) => {
		const base = isNegatedToken(t) ? stripNegation(t) : t;
		return categorizeToken(base) === "legality";
	});
}

// Un mot est "reconnu" s'il correspond exactement à un mot-clé connu : on lui
// donne alors un rendu spécial (icône/pastille) dans sa puce.
export type RecognizedToken =
	| { kind: "color"; letter: string }
	| { kind: "rarity"; label: string }
	| { kind: "language"; flag: string; label: string }
	| { kind: "condition"; glyph: string; color: string; label: string }
	| { kind: "type"; label: string }
	| { kind: "foil"; label: string }
	| { kind: "keyword"; label: string }
	| { kind: "numeric"; label: string }
	| { kind: "artist"; label: string }
	| { kind: "set"; code: string; label: string }
	| { kind: "cardnum"; label: string };

export const OPERATOR_SYMBOLS: Record<NumericOperator, string> = {
	"<": "<",
	"<=": "≤",
	"=": "=",
	">=": "≥",
	">": ">",
};

export function recognizeKeywordToken(token: string): RecognizedToken | null {
	const q = token.trim().toLowerCase();

	if (q.startsWith("artist:")) return { kind: "artist", label: token.trim().slice(7) };
	if (q.startsWith("set:")) {
		const code = token.trim().slice(4);
		return { kind: "set", code, label: code.toUpperCase() };
	}
	if (/^#\d+\S*$/.test(q)) return { kind: "cardnum", label: `# ${token.trim().slice(1)}` };
	const legalityMatch = matchLegalityPrefix(q);
	if (legalityMatch) {
		// Correspondance exacte sur la clé (pas un préfixe) : un jeton commité
		// via la suggestion vaut toujours "<préfixe><clé complète>" (voir
		// SUGGESTABLE_KEYWORDS ci-dessous) — même logique que color/rarity/
		// language plus bas dans cette fonction, un jeton tapé à la main et
		// validé sans passer par la suggestion (ex. "legal:mod") reste un
		// filtre valide (voir legalityTokenMatches, qui lui matche en
		// préfixe) mais n'obtient pas le rendu de puce "reconnu".
		const entry = LEGALITY_SEARCH_FORMATS.find(
			(f) => f.key === q.slice(legalityMatch.prefix.length)
		);
		// Réutilise le rendu "keyword" (pastille générique), même précédent
		// que "recent" un peu plus bas : une seule catégorie booléenne de
		// plus ne justifie pas une variante RecognizedToken dédiée. Le libellé
		// capitalise le statut recherché ("Legal:"/"Banned:"/"Restricted:")
		// à partir du même statut que legalityTokenMatches compare.
		if (entry) {
			const statusLabel =
				legalityMatch.status.charAt(0).toUpperCase() + legalityMatch.status.slice(1);
			return { kind: "keyword", label: `${statusLabel}: ${entry.label}` };
		}
	}
	if (q.startsWith("border:")) {
		// Même précédent que "legal:" ci-dessus : une seule catégorie
		// booléenne de plus ne justifie pas une variante RecognizedToken
		// dédiée, le rendu "keyword" générique suffit.
		const entry = BORDER_SEARCH_OPTIONS.find((o) => o.value === q.slice("border:".length));
		if (entry) return { kind: "keyword", label: `Border: ${entry.label}` };
	}
	if (q.startsWith("oracle:")) {
		// Contrairement à legal:/border: ci-dessus, la valeur n'est pas tirée
		// d'un ensemble fini — n'importe quelle phrase non vide compte comme
		// "reconnue" ici. Casse d'origine conservée (pas q, déjà en
		// minuscules) pour un libellé de puce plus lisible.
		const value = token.trim().slice("oracle:".length).trim();
		if (value) return { kind: "keyword", label: `Card text: "${value}"` };
	}

	const numeric = parseNumericToken(token);
	if (numeric) {
		const valueText = numeric.rawDateStr ?? String(numeric.value);
		return {
			kind: "numeric",
			label: `${numeric.field.label} ${OPERATOR_SYMBOLS[numeric.operator]} ${valueText}`,
		};
	}

	const colorEntry = Object.entries(COLOR_SEARCH_KEYWORDS).find(([name]) => name === q);
	if (colorEntry) return { kind: "color", letter: colorEntry[1] };

	const rarity = RARITY_SEARCH_KEYWORDS.find((r) => r === q);
	if (rarity) return { kind: "rarity", label: rarity.charAt(0).toUpperCase() + rarity.slice(1) };

	const language = LANGUAGES.find((l) => l.label.toLowerCase() === q);
	if (language) return { kind: "language", flag: language.flag, label: language.label };

	const conditionEntry = CONDITION_SEARCH_ENTRIES.find((e) => e.keywords.includes(q));
	if (conditionEntry) {
		const cond = getCondition(conditionEntry.value);
		return { kind: "condition", glyph: cond.glyph, color: cond.color, label: cond.label };
	}
	if (q === "none") {
		const cond = getCondition("");
		return { kind: "condition", glyph: cond.glyph, color: cond.color, label: cond.label };
	}

	if (q === "foil") return { kind: "foil", label: "Foil" };
	if (q === "nonfoil" || q === "non-foil") return { kind: "foil", label: "Non-foil" };
	if (q === "etched") return { kind: "foil", label: "Etched" };
	if (q === "surged" || q === "surge") return { kind: "foil", label: "Surge Foil" };
	if (q === "proxy") return { kind: "foil", label: "Proxy" };

	// Réutilise le rendu "keyword" (pastille générique) plutôt que d'ajouter
	// une variante dédiée à RecognizedToken pour une seule catégorie
	// booléenne sans besoin d'un style visuel propre.
	if (q === "recent") return { kind: "keyword", label: "Recently added" };

	const type = TYPE_SEARCH_KEYWORDS.find((t) => t.toLowerCase() === q);
	if (type) return { kind: "type", label: type };

	const keyword = KEYWORD_ABILITIES.find((k) => k.toLowerCase() === q);
	if (keyword) return { kind: "keyword", label: keyword };

	return null;
}

export interface SuggestKeyword {
	value: string;
	display: string;
	matchTexts: string[];
	category: TokenCategory;
	flagCode?: string;
	setCode?: string;
	count?: number;
}

// Tous les mots-clés proposables en autocomplétion. "matchTexts" contient les
// préfixes reconnus (ex. l'état "Near Mint" se propose en tapant "nm", "near"
// ou "mint"), tandis que "value" est le jeton réellement inséré comme puce.
export const SUGGESTABLE_KEYWORDS: SuggestKeyword[] = [
	...Object.keys(COLOR_SEARCH_KEYWORDS).map((name): SuggestKeyword => ({
		value: name,
		display: name.charAt(0).toUpperCase() + name.slice(1),
		matchTexts: [name],
		category: "color",
	})),
	{ value: "multicolor", display: "Multicolor", matchTexts: ["multicolor"], category: "color" },
	{ value: "colorless", display: "Colorless", matchTexts: ["colorless"], category: "color" },
	...RARITY_SEARCH_KEYWORDS.map((r): SuggestKeyword => ({
		value: r,
		display: r.charAt(0).toUpperCase() + r.slice(1),
		matchTexts: [r],
		category: "rarity",
	})),
	...LANGUAGES.map((l): SuggestKeyword => ({
		value: l.label.toLowerCase(),
		display: l.label,
		matchTexts: [l.label.toLowerCase()],
		category: "language",
		flagCode: l.flag,
	})),
	{ value: "mt", display: "Mint", matchTexts: ["mt", "mint"], category: "condition" },
	{ value: "nm", display: "Near Mint", matchTexts: ["nm", "near"], category: "condition" },
	{ value: "ex", display: "Excellent", matchTexts: ["ex", "excellent"], category: "condition" },
	{ value: "gd", display: "Good", matchTexts: ["gd", "good"], category: "condition" },
	{ value: "lp", display: "Light Played", matchTexts: ["lp", "light"], category: "condition" },
	{ value: "pl", display: "Played", matchTexts: ["pl", "played"], category: "condition" },
	{ value: "po", display: "Poor", matchTexts: ["po", "poor"], category: "condition" },
	{ value: "none", display: "None", matchTexts: ["none"], category: "condition" },
	{ value: "foil", display: "Foil", matchTexts: ["foil"], category: "foil" },
	{ value: "nonfoil", display: "Non-foil", matchTexts: ["nonfoil"], category: "foil" },
	{ value: "etched", display: "Etched", matchTexts: ["etched"], category: "foil" },
	{ value: "surged", display: "Surge Foil", matchTexts: ["surged", "surge"], category: "foil" },
	{ value: "proxy", display: "Proxy", matchTexts: ["proxy"], category: "foil" },
	{
		value: "recent",
		display: "Recently added",
		matchTexts: ["recent"],
		category: "recentlyadded",
	},
	...TYPE_SEARCH_KEYWORDS.map((t): SuggestKeyword => ({
		value: t.toLowerCase(),
		display: t,
		matchTexts: [t.toLowerCase()],
		category: "type",
	})),
	...KEYWORD_ABILITIES.map((k): SuggestKeyword => ({
		value: k.toLowerCase(),
		display: k,
		matchTexts: [k.toLowerCase()],
		category: "keyword",
	})),
	// matchTexts inclut le préfixe lui-même (pas seulement la clé/le libellé
	// nus) : categorizeToken exige ce préfixe (voir plus haut), donc sans lui
	// une frappe de "legal:mo" ne matcherait aucun matchText via startsWith
	// (voir getKeywordSuggestions, view.ts). Les 3 préfixes (LEGALITY_STATUS_
	// PREFIXES) génèrent chacun leurs 23 suggestions plutôt qu'un seul —
	// n'apparaissent que si l'utilisateur a déjà tapé "banned:"/"restricted:"
	// lui-même (aucun matchText ne commence autrement par ces préfixes), donc
	// aucun bruit ajouté à la recherche libre/aux suggestions "legal:" déjà
	// existantes malgré le triplement du nombre total d'entrées.
	...LEGALITY_STATUS_PREFIXES.flatMap(({ prefix, status }) =>
		LEGALITY_SEARCH_FORMATS.map((f): SuggestKeyword => ({
			value: `${prefix}${f.key}`,
			display: `${status.charAt(0).toUpperCase()}${status.slice(1)}: ${f.label}`,
			matchTexts: [`${prefix}${f.key}`, `${prefix}${f.label.toLowerCase()}`],
			category: "legality",
		}))
	),
	// matchTexts inclut le préfixe "border:" lui-même, même raison que
	// "legal:" ci-dessus (categorizeToken exige ce préfixe).
	...BORDER_SEARCH_OPTIONS.map((o): SuggestKeyword => ({
		value: `border:${o.value}`,
		display: `Border: ${o.label}`,
		matchTexts: [`border:${o.value}`, `border:${o.label.toLowerCase()}`],
		category: "border",
	})),
];

export const CATEGORY_LABELS: Record<TokenCategory, string> = {
	color: "Color",
	rarity: "Rarity",
	language: "Language",
	condition: "Condition",
	foil: "Foil",
	type: "Type",
	keyword: "Ability",
	artist: "Artist",
	set: "Set",
	cardnum: "Number",
	numeric_cmc: "Mana value",
	numeric_price: "Price",
	numeric_qty: "Quantity",
	numeric_added: "Date added",
	recentlyadded: "Recently added",
	legality: "Format legality",
	border: "Border",
	oracle: "Card text",
	text: "",
};

/* -------------------------------------------------------------------------- */
/*  Description en anglais de la barre de puces ("Add cards", add-cards-modal.ts) */
/* -------------------------------------------------------------------------- */

// "and"/"or" entre les valeurs d'une même clause — "or" reflète la
// sémantique réelle de plusieurs jetons DANS LA MÊME catégorie (voir
// cardMatchesTokens/orCategories plus haut : "green" + "blue" = vert OU
// bleu), "and" celle des catégories qui se combinent au contraire en ET
// (oracle:/texte libre : chaque phrase doit apparaître). Une seule valeur
// n'a besoin d'aucune conjonction ; deux valeurs s'écrivent "X and Y" sans
// virgule ; trois ou plus utilisent la virgule d'Oxford standard.
function joinPhrase(values: string[], conjunction: "and" | "or"): string {
	const unique = Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
	if (unique.length === 0) return "";
	if (unique.length === 1) return unique[0];
	if (unique.length === 2) return `${unique[0]} ${conjunction} ${unique[1]}`;
	return `${unique.slice(0, -1).join(", ")}, ${conjunction} ${unique[unique.length - 1]}`;
}

function describeTypeValue(token: string): string {
	return TYPE_SEARCH_KEYWORDS.find((t) => t.toLowerCase() === token.trim().toLowerCase()) ?? token.trim();
}

function describeKeywordValue(token: string): string {
	return KEYWORD_ABILITIES.find((k) => k.toLowerCase() === token.trim().toLowerCase()) ?? token.trim();
}

function describeFoilValue(token: string): string {
	const q = token.trim().toLowerCase();
	if ("etched".startsWith(q) && q.length >= 3) return "etched";
	if (("surged".startsWith(q) || "surge".startsWith(q)) && q.length >= 3) return "surge foil";
	if ("proxy".startsWith(q) && q.length >= 3) return "proxy";
	if ("nonfoil".startsWith(q) && q.length >= 3) return "non-foil";
	return "foil";
}

function describeConditionValue(token: string): string {
	const q = token.trim().toLowerCase();
	if ("none".startsWith(q)) return getCondition("").label.toLowerCase();
	const entry = CONDITION_SEARCH_ENTRIES.find((e) => e.keywords.some((k) => k.startsWith(q)));
	return entry ? getCondition(entry.value).label.toLowerCase() : token.trim();
}

function describeLanguageValue(token: string): string {
	const q = token.trim().toLowerCase();
	const lang = LANGUAGES.find((l) => l.label.toLowerCase().startsWith(q));
	return lang ? lang.label : token.trim();
}

function describeBorderValue(token: string): string {
	const value = token.trim().slice("border:".length).trim().toLowerCase();
	const entry = BORDER_SEARCH_OPTIONS.find((o) => o.value === value);
	return entry ? entry.label.toLowerCase() : value;
}

function describeLegalityValue(token: string): string {
	const q = token.trim().toLowerCase();
	const legalityMatch = matchLegalityPrefix(q);
	const key = (legalityMatch ? q.slice(legalityMatch.prefix.length) : q).trim();
	const entry = LEGALITY_SEARCH_FORMATS.find((f) => f.key === key);
	return entry ? entry.label : key;
}

function describeNumericValue(token: string): string {
	const parsed = parseNumericToken(token);
	if (!parsed) return token.trim();
	const valueText = parsed.rawDateStr ?? String(parsed.value);
	return `${parsed.field.label.toLowerCase()} ${OPERATOR_SYMBOLS[parsed.operator]} ${valueText}`;
}

// Nom complet d'une édition plutôt que son code court ("Innistrad
// Remastered", pas "INR") — demandé explicitement. resolveSetName est
// fourni par l'appelant (add-cards-modal.ts, via
// MTGCollectionPlugin.getCachedSetSummary — une lecture SYNCHRONE d'un
// cache déjà chaud, même fonction déjà utilisée pour l'icône/le nom de la
// puce "set:" elle-même dans renderSearchChipBar) : ce fichier n'a par
// ailleurs aucune dépendance à Obsidian/au plugin, donc pas question d'aller
// chercher cette donnée lui-même. Repli sur le code en majuscules si le
// cache n'est pas encore chaud ou si aucun resolver n'est fourni (ex. les
// tests unitaires de ce fichier) — même repli que renderSearchChipBar.
function describeSetValue(
	token: string,
	resolveSetName?: (code: string) => string | undefined
): string {
	const code = token.trim().slice("set:".length).trim().toLowerCase();
	return resolveSetName?.(code) ?? code.toUpperCase();
}

// Une seule valeur d'une catégorie donnée, décrite pour la clause de
// négation ("not X") — contrairement aux clauses positives ci-dessous
// (regroupées par catégorie avec "or"), chaque jeton négatif exclut
// indépendamment (voir cardMatchesTokens : ET de négations, chacune
// évaluée seule), donc pas de regroupement ici, une clause par jeton.
function describeNegatedValue(
	token: string,
	resolveSetName?: (code: string) => string | undefined
): string {
	const cat = categorizeToken(token);
	switch (cat) {
		case "color":
			return `${token.trim().toLowerCase()}`;
		case "rarity":
			return `${token.trim().toLowerCase()} rarity`;
		case "type":
			return `of type ${describeTypeValue(token)}`;
		case "keyword":
			return `with the "${describeKeywordValue(token)}" ability`;
		case "oracle":
			return `mentioning "${token.trim().slice("oracle:".length).trim()}"`;
		case "text":
			return `containing "${token.trim()}"`;
		case "artist":
			return `by ${token.trim().slice("artist:".length).trim()}`;
		case "set":
			return `from ${describeSetValue(token, resolveSetName)}`;
		case "cardnum":
			return `numbered #${token.trim().slice(1)}`;
		case "foil":
			return describeFoilValue(token);
		case "condition":
			return `in ${describeConditionValue(token)} condition`;
		case "language":
			return `in ${describeLanguageValue(token)}`;
		case "border":
			return `with a ${describeBorderValue(token)} border`;
		case "legality": {
			const legalityMatch = matchLegalityPrefix(token.trim().toLowerCase());
			return `${legalityMatch?.status ?? "legal"} in ${describeLegalityValue(token)}`;
		}
		case "recentlyadded":
			return "recently added";
		default:
			return token.trim();
	}
}

// Description en anglais, best-effort, de l'état courant de la barre de
// puces — "Show every green card containing "Aragorn", with the "Vigilance"
// ability." (voir add-cards-modal.ts, updateFilterDescription). Un instantané
// DÉTERMINISTE construit à partir des mêmes tables/catégories que le reste
// de ce fichier, PAS une vraie génération de langage naturel : reflète
// fidèlement la sémantique réelle de cardMatchesTokens (catégories
// différentes en ET, plusieurs jetons de LA MÊME catégorie en OU — sauf
// oracle:/texte libre, en ET, et cmc/prix/qty/date, en intersection de
// plage — voir son propre commentaire en tête de ce fichier), mais reste
// mécanique plutôt qu'élégant pour les combinaisons les plus inhabituelles
// (plusieurs négations empilées sur des catégories très différentes, par
// exemple). Un jeton non reconnu (abréviation tapée à la main avant d'être
// validée, mot libre) retombe sur son texte brut, même repli que
// renderSearchChipBar (add-cards-modal.ts/view.ts) pour l'affichage des puces
// elles-mêmes.
// Un constructeur de clause par catégorie — tous partagent la même forme
// (liste des jetons de cette catégorie -> phrase complète), pour pouvoir
// être appelés génériquement dans CATEGORY_CLAUSE_BUILDERS ci-dessous plutôt
// que via une longue chaîne de if répétitive. "color" n'y figure pas : géré
// à part, en qualificatif du SUJET plutôt qu'en clause (voir
// describeSearchFilters). "set" non plus : contrairement aux autres, sa
// description a besoin du resolver optionnel de describeSearchFilters
// (nom complet d'édition, voir describeSetValue) — un constructeur de ce
// tableau, construit une fois au niveau du module, ne peut pas fermer sur
// un paramètre propre à un appel donné, donc "set" est traité à part,
// directement dans describeSearchFilters.
const CATEGORY_CLAUSE_BUILDERS: Partial<Record<TokenCategory, (values: string[]) => string>> = {
	rarity: (v) => `with ${joinPhrase(v.map((t) => t.toLowerCase()), "or")} rarity`,
	type: (v) => `of type ${joinPhrase(v.map(describeTypeValue), "or")}`,
	keyword: (v) =>
		`with the ${joinPhrase(
			v.map((t) => `"${describeKeywordValue(t)}"`),
			"or"
		)} ability`,
	oracle: (v) =>
		`whose rules text mentions ${joinPhrase(
			v.map((t) => `"${t.slice("oracle:".length).trim()}"`),
			"and"
		)}`,
	text: (v) => `containing ${joinPhrase(v.map((t) => `"${t}"`), "and")}`,
	artist: (v) =>
		`by ${joinPhrase(
			v.map((t) => t.slice("artist:".length).trim()),
			"or"
		)}`,
	cardnum: (v) => `numbered ${joinPhrase(v.map((t) => `#${t.slice(1)}`), "or")}`,
	foil: (v) => `in ${joinPhrase(v.map(describeFoilValue), "or")} finish`,
	condition: (v) => `in ${joinPhrase(v.map(describeConditionValue), "or")} condition`,
	language: (v) => `in ${joinPhrase(v.map(describeLanguageValue), "or")}`,
	border: (v) => `with a ${joinPhrase(v.map(describeBorderValue), "or")} border`,
	// Regroupe d'abord par statut recherché (legal:/banned:/restricted: —
	// même bucket "legality", voir cardMatchesTokens) avant de décrire, sinon
	// un mélange comme "legal:modern" + "banned:legacy" dans la même requête
	// afficherait à tort "legal in Modern or Legacy" — silencieusement faux
	// pour le second jeton. Chaque groupe de statut garde son propre "or"
	// interne (mêmes formats, même statut), les groupes de statuts
	// différents se joignent aussi par "or" entre eux — reflète la sémantique
	// réelle du bucket (OR entre TOUS les jetons "legality", quel que soit
	// leur statut, voir cardMatchesTokens).
	legality: (v) => {
		const byStatus = new Map<string, string[]>();
		v.forEach((t) => {
			const status = matchLegalityPrefix(t.trim().toLowerCase())?.status ?? "legal";
			const group = byStatus.get(status) ?? [];
			group.push(t);
			byStatus.set(status, group);
		});
		return joinPhrase(
			Array.from(byStatus.entries()).map(
				([status, group]) => `${status} in ${joinPhrase(group.map(describeLegalityValue), "or")}`
			),
			"or"
		);
	},
	recentlyadded: () => "recently added",
	numeric_cmc: (v) => joinPhrase(v.map(describeNumericValue), "and"),
	numeric_price: (v) => joinPhrase(v.map(describeNumericValue), "and"),
	numeric_qty: (v) => joinPhrase(v.map(describeNumericValue), "and"),
	numeric_added: (v) => joinPhrase(v.map(describeNumericValue), "and"),
};

export function describeSearchFilters(
	tokens: string[],
	resolveSetName?: (code: string) => string | undefined
): string {
	const trimmed = tokens.map((t) => t.trim()).filter(Boolean);
	if (trimmed.length === 0) return "";

	const positive: string[] = [];
	const negative: string[] = [];
	const exactColorValues: string[] = [];

	trimmed.forEach((t) => {
		if (isNegatedToken(t)) {
			negative.push(stripNegation(t));
			return;
		}
		if (isExactToken(t)) {
			const base = stripExact(t);
			if (categorizeToken(base) === "color") {
				exactColorValues.push(base);
				return;
			}
			positive.push(base);
			return;
		}
		positive.push(t);
	});

	// Regroupe par catégorie tout en retenant l'ORDRE D'APPARITION de chaque
	// catégorie (categoryOrder) — pas un ordre fixe/arbitraire : le résultat
	// suit ainsi l'ordre dans lequel l'utilisateur a réellement tapé ses
	// filtres ("green" puis "aragorn" puis "vigilance" produit les clauses
	// dans CET ordre), plutôt qu'un classement par catégorie qui pourrait
	// réordonner la phrase de façon surprenante par rapport à ce qui a été
	// tapé.
	const buckets: Partial<Record<TokenCategory, string[]>> = {};
	const categoryOrder: TokenCategory[] = [];
	positive.forEach((t) => {
		const cat = categorizeToken(t);
		if (!buckets[cat]) categoryOrder.push(cat);
		(buckets[cat] ??= []).push(t);
	});

	// Sujet de la phrase : "every X card" — la couleur pilote l'adjectif du
	// sujet quand elle est présente (comme dans l'exemple à l'origine de
	// cette fonctionnalité), sinon "every card" tout court. L'identité de
	// couleur exacte (=vert, voir isExactToken) est une contrainte séparée,
	// ajoutée en qualificatif du sujet plutôt que traitée comme une clause
	// parmi d'autres — ni l'une ni l'autre ne suit categoryOrder, ce sont
	// toutes deux des qualificatifs du SUJET, pas des clauses.
	let subject = "every card";
	if (buckets.color?.length) {
		subject = `every ${joinPhrase(buckets.color.map((t) => t.toLowerCase()), "or")} card`;
	}
	if (exactColorValues.length > 0) {
		subject += ` whose color identity is exactly ${joinPhrase(
			exactColorValues.map((t) => t.toLowerCase()),
			"and"
		)}`;
	}

	const clauses: string[] = [];
	categoryOrder.forEach((cat) => {
		if (cat === "color") return; // déjà intégrée au sujet ci-dessus
		if (cat === "set") {
			// Cas particulier, voir CATEGORY_CLAUSE_BUILDERS : a besoin du
			// resolver propre à cet appel, pas d'un constructeur module-level.
			const values = buckets.set;
			if (values?.length) {
				clauses.push(`from ${joinPhrase(values.map((t) => describeSetValue(t, resolveSetName)), "or")}`);
			}
			return;
		}
		const builder = CATEGORY_CLAUSE_BUILDERS[cat];
		const values = buckets[cat];
		if (builder && values?.length) clauses.push(builder(values));
	});

	negative.forEach((t) => clauses.push(`not ${describeNegatedValue(t, resolveSetName)}`));

	return clauses.length > 0 ? `Show ${subject} ${clauses.join(", ")}.` : `Show ${subject}.`;
}
