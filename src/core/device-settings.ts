/* -------------------------------------------------------------------------- */
/*  Réglages propres à CHAQUE appareil (2026-10-03) — logique pure.

    data.json est synchronisé entre le Mac, l'iPad et le téléphone ; or la façon
    dont chacun navigue (mode de vue, tri, regroupement, menu replié, barres
    Obsidian masquées…) n'a aucune raison d'être la même : changer le tri sur le
    téléphone ne doit pas re-trier l'écran du Mac, ni "menu replié" suivre d'un
    appareil à l'autre (c'était déjà un défaut connu de navCollapsed).

    Ces clés vivent donc dans `this.settings` comme avant (tout le code qui les
    lit/écrit est inchangé), mais ne sont ni écrites dans data.json, ni fusionnées
    avec une version venue d'ailleurs : elles sont gardées dans le stockage local
    de l'appareil (src/plugin/settings-sync.ts, loadDeviceLocalSettings /
    saveDeviceLocalSettings).

    N'en font PAS partie, volontairement : les réglages saisis dans l'onglet des
    paramètres du plugin (couleur d'accent, devise, icône de la barre latérale,
    seuils, intervalles de rafraîchissement/sauvegarde, clé d'API) — de la
    configuration, pas de l'état de navigation. Pour déplacer une clé d'un côté
    à l'autre, c'est ici et seulement ici.  */
/* -------------------------------------------------------------------------- */

export const DEVICE_LOCAL_KEYS: ReadonlySet<string> = new Set([
	// Vue d'une liste ouverte : My Collection
	"collectionGroupBy",
	"collectionSortBy",
	"collectionSortReverse",
	"collectionGroupReverse",
	"collectionViewMode",
	// … My Decks
	"deckGroupBy",
	"deckSortBy",
	"deckSortReverse",
	"deckGroupReverse",
	"deckViewMode",
	"deckActiveBoard",
	// … My Wantlists
	"wantlistGroupBy",
	"wantlistSortBy",
	"wantlistSortReverse",
	"wantlistGroupReverse",
	"wantlistViewMode",
	// Tri des galeries (grilles de listes / decks / wantlists)
	"listGridSortBy",
	"listGridSortReverse",
	"deckGridSortBy",
	"deckGridSortReverse",
	"wantlistGridSortBy",
	"wantlistGridSortReverse",
	// Chrome de l'interface
	"navCollapsed",
	"hideObsidianMobileBars",
	// Bloc Market Trends de Home
	"homeMoversPeriod",
	"homeMoversVendor",
	// Synchronisation GitHub (optionnelle) : chaque appareil a sa propre configuration — et son
	// propre jeton, qui n'est dans aucun réglage. Activer la synchro sur le Mac ne doit pas
	// l'activer sur un téléphone qui n'a pas (encore) de jeton.
	"githubSyncEnabled",
	"githubRepo",
	"githubBranch",
	"githubPath",
	"githubApiBase",
	// Où est le fichier de données sur cet appareil.
	"dataFolder",
]);

type Bag = Record<string, unknown>;

// Copie superficielle sans les clés propres à l'appareil : ce qui part dans data.json.
export function omitDeviceLocal(settings: object): Bag {
	const src = settings as Bag;
	const out: Bag = {};
	for (const k of Object.keys(src)) if (!DEVICE_LOCAL_KEYS.has(k)) out[k] = src[k];
	return out;
}

// Les seules clés propres à l'appareil : ce qui part dans son stockage local.
export function pickDeviceLocal(settings: object): Bag {
	const src = settings as Bag;
	const out: Bag = {};
	for (const k of DEVICE_LOCAL_KEYS) if (src[k] !== undefined) out[k] = src[k];
	return out;
}
