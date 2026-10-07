// Détection automatique de la "fonction" d'une carte dans un deck (Ramp,
// Removal, Draw, Counters, Tokens, etc.) — inspirée des "Categories"
// d'Archidekt (voir la vue Stacks, view.ts/renderDeckStacksView), mais
// dérivée automatiquement du texte de règles déjà en cache (DeckCard.
// oracleText/keywords, voir "Card Text" dans CLAUDE.md) plutôt qu'un
// système de tags manuels complet — scoping confirmé explicitement
// (2026-09-02) : auto-détection d'abord, ajustable ensuite carte par carte
// (voir DeckCard.deckFunctionOverride, data-model.ts), pas un éditeur de
// tags libres/multi-tags. Une carte ne reçoit toujours qu'UNE seule
// fonction — la première règle qui matche l'emporte (ordre ci-dessous),
// jamais plusieurs à la fois (même choix que "une seule pile" pour la vue
// Stacks : reste dans le moteur de regroupement existant, qui suppose un
// seul groupe par carte, plutôt qu'un changement d'architecture partagé
// par les 3 sections du plugin).
//
// Fichier volontairement autonome (aucun import depuis card-sorting.ts,
// même si son propre "Land"/primaryType s'y trouve déjà) : card-sorting.ts
// importe CE fichier (pas l'inverse) pour son cas "function" dans
// groupSortValue/groupLabelFor — un import dans l'autre sens créerait un
// vrai cycle. D'où la petite règle "Land" dupliquée ci-dessous plutôt que
// réutilisée depuis isLand (card-sorting.ts) : un simple regex, pas la
// peine de risquer un cycle pour ça.
//
// Chaque règle a été volontairement gardée simple/lisible (un seul motif
// principal par catégorie) plutôt que sur-optimisée pour capturer chaque
// carte existante — les faux négatifs (une carte qui aurait mérité une
// catégorie mais ne matche aucune règle) retombent sur le type de la carte
// (voir l'appel à primaryType côté card-sorting.ts), les faux positifs
// occasionnels se corrigent manuellement via deckFunctionOverride.

// Ordre = ordre d'affichage des piles ET ordre de priorité de détection
// (la 1ère règle qui matche l'emporte) — les catégories fonctionnelles
// d'abord (les plus "intéressantes" à voir groupées), les replis par type
// ensuite (mêmes libellés que primaryType/MAIN_TYPES, card-sorting.ts,
// pour rester cohérent avec "Group by Type"). "Commander" (2026-09-07,
// demandé explicitement — "Commander est une Function", pas une catégorie
// de board, voir DeckCardCategory dans data-model.ts) en tout premier :
// contrairement à toutes les autres entrées ci-dessous, elle n'a AUCUNE
// règle de détection dans FUNCTION_RULES/EVASION_KEYWORDS plus bas — rien
// dans le texte d'une carte ne permet de deviner "c'est LE commandant de
// CE deck précis", donc elle n'existe jamais que via deckFunctionOverride,
// une désignation manuelle pure (voir isDeckCommander, data-model.ts). Sa
// position en tête ne joue donc aucun rôle dans l'ordre de priorité de
// détection (jamais atteinte par une règle) — seulement dans l'ordre
// d'affichage des piles/du picker "Function" (deck-card-detail-modal.ts).
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

// Motifs volontairement en minuscules (oracleText est passé en lowercase
// une seule fois par detectDeckCardFunction, pas re-testé par règle) —
// [^.\n] plutôt que .* : reste dans la MÊME phrase/ligne, évite qu'un motif
// "traverse" par erreur deux capacités sans rapport séparées par un point.
const FUNCTION_RULES: DeckFunctionRule[] = [
	// Motif précis (début de phrase) : "counter target spell" ailleurs dans
	// le texte (ex. "unless that player pays {2}, counter target spell")
	// reste un vrai contresort, ce motif le capture aussi via \bcounter
	// target spell\b sans ancrage strict au début.
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
	// Terrain d'abord (recherche de terrain = mana, pas une vraie "tutor"
	// pour une carte précise) — d'où Ramp avant Tutor dans cet ordre.
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

// Retourne undefined si aucune règle ne matche (et que ce n'est pas un
// terrain) — le repli "type de carte" (primaryType) reste la
// responsabilité de l'appelant (card-sorting.ts), voir le commentaire
// d'en-tête ci-dessus pour pourquoi ce fichier reste autonome.
export function detectDeckCardFunction(card: {
	typeLine: string;
	oracleText?: string;
	keywords?: string[];
}): string | undefined {
	// Un terrain garde toujours son propre libellé, même si son texte de
	// règles matche par ailleurs une autre catégorie (ex. un fetchland
	// matche aussi le motif "Ramp" ci-dessus) — prévisible, toutes les
	// terrains restent groupés ensemble plutôt qu'éparpillés selon leur
	// capacité annexe. Regex dupliquée depuis isLand (card-sorting.ts)
	// plutôt qu'importée — voir le commentaire d'en-tête.
	if (/\bLand\b/.test(card.typeLine || "")) return "Land";

	const text = (card.oracleText || "").toLowerCase();
	for (const rule of FUNCTION_RULES) {
		if (rule.test(text)) return rule.label;
	}

	if ((card.keywords || []).some((k) => EVASION_KEYWORDS.has(k.toLowerCase()))) return "Evasion";

	return undefined;
}

// Clé de tri stable pour "Group by Function" (groupSortValue, card-sorting.
// ts) — un préfixe numérique zéro-paddé suivi du libellé lui-même, comparé
// en tant que CHAÎNE (String.localeCompare) : évite de mélanger nombre/
// chaîne dans le même groupBy (voir le commentaire sur groupSortValue,
// card-sorting.ts, pour pourquoi ce fichier ne renvoie jamais un nombre nu
// ici). Un libellé absent de DECK_FUNCTION_CATEGORIES (ex. "Other", déjà
// dans la liste, ou un futur repli imprévu) trie après tous les connus.
export function deckFunctionSortKey(label: string): string {
	const idx = (DECK_FUNCTION_CATEGORIES as readonly string[]).indexOf(label);
	const rank = idx === -1 ? DECK_FUNCTION_CATEGORIES.length : idx;
	return `${String(rank).padStart(3, "0")}_${label}`;
}
