/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */


// État physique de l'exemplaire, remplace l'ancien booléen "foil". "proxy"
// n'est pas une finition Scryfall — c'est un exemplaire non-officiel possédé
// par l'utilisateur, exclu du calcul de valeur (voir cardValue). "surged"
// (Surge Foil, traitement propre à Kaldheim) n'a — contrairement à etched —
// aucun champ de prix Scryfall dédié (`prices.usd_etched`/`eur_etched`
// existent, l'équivalent "surge" n'existe pas dans leur API) : chaque
// impression surge foil est son propre objet carte chez Scryfall (finition
// foil uniquement pour cette impression précise), donc son prix se trouve
// déjà dans les champs foil habituels — pas besoin de champs séparés, voir
// getRawCardPrice plus bas.
export type Finish = "regular" | "foiled" | "etched" | "surged" | "proxy";

export const FINISH_OPTIONS: { value: Finish; label: string }[] = [
	{ value: "regular", label: "Regular" },
	{ value: "foiled", label: "Foiled" },
	{ value: "etched", label: "Etched" },
	{ value: "surged", label: "Surge Foil" },
	{ value: "proxy", label: "Proxy" },
];

export function getFinishLabel(finish: Finish): string {
	return FINISH_OPTIONS.find((f) => f.value === finish)?.label ?? "Regular";
}

// Vrai pour les finitions qui ont un aspect brillant/texturé à l'image
// (incrustation "foil" sur la vignette) — Regular et Proxy n'en ont pas.
export function finishHasFoilLook(finish: Finish): boolean {
	return finish === "foiled" || finish === "etched" || finish === "surged";
}

// Reconnaît aussi bien la colonne CSV "Finish" (valeurs Regular/Foiled/
// Etched/Surge Foil/Proxy) que l'ancienne colonne "Foil"/"foil/etched"
// (valeurs comme "foil", "etched", "true", "1", ou vide) — un CSV exporté
// par une version antérieure du plugin doit rester importable tel quel.
export function parseFinishValue(raw: string | undefined): Finish {
	const v = (raw ?? "").trim().toLowerCase();
	if (v === "etched") return "etched";
	if (v === "surged" || v === "surge" || v === "surge foil") return "surged";
	if (v === "proxy") return "proxy";
	if (v === "foiled" || v === "foil" || v === "true" || v === "yes" || v === "1") return "foiled";
	return "regular";
}

// Grading/prix perso — My Collection uniquement (une carte de wantlist n'est
// pas encore possédée, donc pas encore gradée ; un DeckCard n'a pas non plus
// de finish, même asymétrie déjà établie). Barème volontairement minimal
// (société + une seule note 1-10, pas de sous-notes/numéro de certificat) —
// PSA/BGS/CGC utilisent tous une échelle 1-10 par pas de 0.5 sur l'essentiel
// de la plage (vérifié via comics.ha.com/tutorial/tcg-card-grading.s).
export type GradingCompany = "PSA" | "BGS" | "CGC" | "Other";

export const GRADING_COMPANY_OPTIONS: { value: GradingCompany; label: string }[] = [
	{ value: "PSA", label: "PSA" },
	{ value: "BGS", label: "BGS" },
	{ value: "CGC", label: "CGC" },
	{ value: "Other", label: "Other" },
];

export interface GradingTerm {
	grade: number | undefined;
	label: string;
	name: string;
}

export const GRADING_TERMS: Record<"PSA" | "BGS" | "CGC", GradingTerm[]> = {
	PSA: [
		{ grade: 10, label: "GEM MT", name: "Gem Mint" },
		{ grade: 9, label: "MINT", name: "Mint" },
		{ grade: 8, label: "NM-MT", name: "Near Mint / Mint" },
		{ grade: 7, label: "MT", name: "Near Mint" },
		{ grade: 6, label: "EX-MT", name: "Excellent / Mint" },
		{ grade: 5, label: "EX", name: "Excellent" },
		{ grade: 4, label: "VG-EX", name: "Very Good / Excellent" },
		{ grade: 3, label: "VG", name: "Very Good" },
		{ grade: 2, label: "GOOD", name: "Good" },
		{ grade: 1.5, label: "FR", name: "Fair" },
		{ grade: 1, label: "PR", name: "Poor" },
		{ grade: undefined, label: "A", name: "Authentic" },
		{ grade: undefined, label: "AA", name: "Authentic Altered" },
	],
	BGS: [
		{ grade: 10, label: "PRST-BL", name: "Pristine 10 - Black Label" },
		{ grade: 10, label: "PRST", name: "Pristine 10" },
		{ grade: 9.5, label: "GEM MT", name: "Gem Mint" },
		{ grade: 9, label: "MT", name: "Mint" },
		{ grade: 8, label: "NM-MT", name: "Near Mint / Mint" },
		{ grade: 7, label: "NM", name: "Near Mint" },
		{ grade: 6, label: "EX-MT", name: "Excellent / Mint" },
		{ grade: 5, label: "EX", name: "Excellent" },
		{ grade: 4, label: "VG-EX", name: "Very Good / Excellent" },
		{ grade: 3, label: "VG", name: "Very Good" },
		{ grade: 2, label: "GOOD", name: "Good" },
		{ grade: 1, label: "PR", name: "Poor" },
	],
	CGC: [
		{ grade: 10, label: "PRST", name: "Pristine" },
		{ grade: 10, label: "GEM MT", name: "Gem Mint" },
		{ grade: 9.5, label: "MT+", name: "Mint+" },
		{ grade: 9, label: "MT", name: "Mint" },
		{ grade: 8.5, label: "NM-MT+", name: "Near Mint / Mint+" },
		{ grade: 8, label: "NM-MT", name: "Near Mint / Mint" },
		{ grade: 7.5, label: "NM+", name: "Near Mint+" },
		{ grade: 7, label: "NM", name: "Near Mint" },
		{ grade: 6.5, label: "EX-NM+", name: "Excellent / Near Mint+" },
		{ grade: 6, label: "EX-NM", name: "Excellent / Near Mint" },
		{ grade: 5.5, label: "EX+", name: "Excellent+" },
		{ grade: 5, label: "EX", name: "Excellent" },
		{ grade: 4.5, label: "VG-EX+", name: "Very Good / Excellent+" },
		{ grade: 4, label: "VG-EX", name: "Very Good / Excellent" },
		{ grade: 3.5, label: "VG+", name: "Very Good+" },
		{ grade: 3, label: "VG", name: "Very Good" },
		{ grade: 2.5, label: "GOOD+", name: "Good+" },
		{ grade: 2, label: "GOOD", name: "Good" },
		{ grade: 1.5, label: "FR", name: "Fair" },
		{ grade: 1, label: "PR", name: "Poor" },
	],
};

export interface CollectionCard {
	id: string;
	scryfallId: string;
	name: string;
	setCode: string;
	setName: string;
	collectorNumber: string;
	rarity: string;
	manaCost: string;
	manaValue: number;
	typeLine: string;
	artist: string;
	colors: string[];
	keywords: string[];
	releasedAt: string;
	imageUrl: string;
	artCropUrl: string;
	priceUsd: string;
	priceUsdFoil: string;
	priceEur: string;
	priceEurFoil: string;
	priceUsdEtched: string;
	priceEurEtched: string;
	count: number;
	finish: Finish;
	language: string;
	condition: string;
	listId: string;
	dateAdded: number;
	dateModified: number;
	gradingCompany?: GradingCompany;
	gradingGrade?: number; // 1-10, pas de 0.5
	// Abréviation officielle (ex. "GEM MT") choisie dans GRADING_TERMS,
	// stockée à part de gradingGrade car BGS/CGC ont chacune deux mentions
	// différentes à la note 10 — la seule note ne suffit pas à les
	// distinguer. undefined si la note a été tapée à la main sans passer
	// par le menu déroulant de mentions.
	gradingLabel?: string;
	customPrice?: string; // note libre, jamais utilisée dans les calculs de prix
	// Bordure/cadre (filtre "border:", card-search.ts) — contrairement à
	// gradingCompany/etc. ci-dessus, optionnel non pas parce que la valeur
	// peut légitimement manquer, mais parce que cette donnée est IMMUABLE
	// (une carte imprimée ne change jamais de bordure) et a été ajoutée à un
	// modèle de données déjà mature : une entrée créée avant cette
	// fonctionnalité n'a tout simplement pas encore ces champs en mémoire tant
	// que MTGCollectionPlugin.backfillBorderData() ne les a pas rattrapés une
	// fois — voir son propre commentaire (plugin.ts) pour pourquoi un simple
	// rattrapage ponctuel suffit ici, contrairement au cache à TTL des
	// légalités. Peuplée directement depuis ScryfallCard.border_color/frame/
	// frame_effects à chaque site qui construit une entrée depuis une réponse
	// Scryfall (addCardToCollection, importCsv, changeCollectionCardPrinting, etc.).
	borderColor?: string;
	frame?: string;
	frameEffects?: string[];
	// Texte de règles (filtre "oracle:", card-search.ts) — même raison d'être
	// optionnelle que borderColor/frame/frameEffects ci-dessus (donnée
	// immuable, ajoutée à un modèle déjà mature, rattrapée une fois par
	// MTGCollectionPlugin.backfillOracleTextData()). Combine les deux faces
	// pour une carte recto-verso (voir buildCardTextInfo, scryfall.ts).
	oracleText?: string;
}

// Même forme que CollectionCard, sans condition/langue : une carte désirée n'est
// pas encore possédée, donc son état physique n'a pas de sens ici. finish et
// prix restent utiles (on peut vouloir spécifiquement une version foil, et
// le prix aide à évaluer le coût d'acquisition).
export interface WantlistCard {
	id: string;
	scryfallId: string;
	name: string;
	setCode: string;
	setName: string;
	collectorNumber: string;
	rarity: string;
	manaCost: string;
	manaValue: number;
	typeLine: string;
	artist: string;
	colors: string[];
	keywords: string[];
	releasedAt: string;
	imageUrl: string;
	artCropUrl: string;
	priceUsd: string;
	priceUsdFoil: string;
	priceEur: string;
	priceEurFoil: string;
	priceUsdEtched: string;
	priceEurEtched: string;
	count: number;
	finish: Finish;
	listId: string;
	dateAdded: number;
	dateModified: number;
	// Voir le commentaire équivalent sur CollectionCard ci-dessus.
	borderColor?: string;
	frame?: string;
	frameEffects?: string[];
	oracleText?: string;
}

export interface LanguageOption {
	code: string;
	label: string;
	flag: string;
}

// Langues d'impression officielles de Magic: The Gathering. "flag" est un
// code pays ISO 3166-1 alpha-2, clé dans FLAG_SVGS ci-dessous. Pas d'entrée
// "None" ici (essayé une première fois, revenu en arrière sur demande
// explicite) : une carte sans langue choisie n'apparaît plus comme un choix
// sélectionnable dans les pickers, seulement comme un repli visuel — voir
// getLanguage/createLanguageIcon (ui/option-icons.ts).
export const LANGUAGES: LanguageOption[] = [
	{ code: "en", label: "English", flag: "us" },
	{ code: "es", label: "Spanish", flag: "es" },
	{ code: "fr", label: "French", flag: "fr" },
	{ code: "de", label: "German", flag: "de" },
	{ code: "it", label: "Italian", flag: "it" },
	{ code: "pt", label: "Portuguese", flag: "pt" },
	{ code: "ja", label: "Japanese", flag: "jp" },
	{ code: "ko", label: "Korean", flag: "kr" },
	{ code: "ru", label: "Russian", flag: "ru" },
	{ code: "zhs", label: "Chinese (Simplified)", flag: "cn" },
	{ code: "zht", label: "Chinese (Traditional)", flag: "tw" },
];

// Objet virtuel renvoyé pour un code vide/non reconnu — jamais un membre de
// LANGUAGES (donc jamais itéré dans un picker), juste une description pour
// l'affichage texte (ex. la boîte "Language" du panneau Graded/Custom
// Price) et pour créditer flag: "" à createLanguageIcon (ui/option-icons.ts).
const UNSET_LANGUAGE: LanguageOption = { code: "", label: "None", flag: "" };

export function getLanguage(code: string): LanguageOption {
	return LANGUAGES.find((l) => l.code === code) ?? UNSET_LANGUAGE;
}

// Construit la liste des langues proposables dans un picker de carte : les
// langues confirmées disponibles pour cette impression (availableCodes, déjà
// filtré par plugin.getAvailableLanguages), ou la liste complète si Scryfall
// n'en a signalé aucune. Petit helper DRY pour les 3 pickers qui en ont
// besoin (ligne de liste, tuile Card view, panneau de détail) plutôt qu'une
// logique dupliquée trois fois.
export function languagePickerOptions(availableCodes: string[]): LanguageOption[] {
	const available = LANGUAGES.filter((l) => availableCodes.includes(l.code));
	return available.length > 0 ? available : LANGUAGES;
}

export interface ConditionOption {
	value: string;
	label: string;
	glyph: string;
	color: string;
}

export const CONDITIONS: ConditionOption[] = [
	{ value: "MT", label: "Mint", glyph: "MT", color: "#4ba0b5" },
	{ value: "NM", label: "Near Mint", glyph: "NM", color: "#5fad60" },
	{ value: "EX", label: "Excellent", glyph: "EX", color: "#838934" },
	{ value: "GD", label: "Good", glyph: "GD", color: "#f5c344" },
	{ value: "LP", label: "Light Played", glyph: "LP", color: "#ee9144" },
	{ value: "PL", label: "Played", glyph: "PL", color: "#d66f76" },
	{ value: "PO", label: "Poor", glyph: "PO", color: "#cb444a" },
];

// Objet virtuel renvoyé pour une valeur vide/non reconnue — jamais un membre
// de CONDITIONS (donc jamais itéré dans un picker), même rôle que
// UNSET_LANGUAGE plus haut : décrit l'état pour l'affichage texte (ex. la
// recherche par puces, qui traite déjà "none" comme son propre mot-clé
// condition — voir card-search.ts) et pour créditer glyph "–" à l'ancien
// rendu badge encore utilisé par cette puce de recherche.
const UNSET_CONDITION: ConditionOption = { value: "", label: "None", glyph: "–", color: "var(--text-faint)" };

export function getCondition(value: string): ConditionOption {
	return CONDITIONS.find((c) => c.value === value) ?? UNSET_CONDITION;
}

// Limited Edition Alpha (1993) avait des coins visiblement plus arrondis
// que le reste des impressions Magic — reproduit via une classe CSS dédiée
// partout où une image de carte est affichée.
export function isAlphaSet(setCode: string): boolean {
	return setCode.toLowerCase() === "lea";
}
