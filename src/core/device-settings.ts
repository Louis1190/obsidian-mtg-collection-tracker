/* -------------------------------------------------------------------------- */
/* Settings specific to EACH device (2026-10-03) — pure logic.

    data.json is synchronized between the Mac, the iPad and the phone; yet the way
    each one navigates (view mode, sort, grouping, collapsed menu, hidden Obsidian
    bars…) has no reason to be the same: changing the sort on the phone must not
    re-sort the Mac's screen, nor should "collapsed menu" follow from one device
    to another (it was already a known defect of navCollapsed).

    These keys therefore live in `this.settings` as before (all the code that
    reads/writes them is unchanged), but are neither written to data.json nor
    merged with a version coming from elsewhere: they are kept in the device's
    local storage (src/plugin/settings-sync.ts, loadDeviceLocalSettings /
    saveDeviceLocalSettings).

    Deliberately NOT part of it: the settings typed in the plugin's settings tab
    (accent color, currency, sidebar icon, thresholds, refresh/backup intervals,
    API key) — configuration, not navigation state. To move a key from one side to
    the other, it's here and only here. */
/* -------------------------------------------------------------------------- */

export const DEVICE_LOCAL_KEYS: ReadonlySet<string> = new Set([
	// View of an open list: My Collection
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
	// Sort of the galleries (grids of lists / decks / wantlists)
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
	// GitHub synchronization (optional): each device has its own configuration — and its own
	// token, which is in no setting. Enabling sync on the Mac must not enable it on a phone
	// that doesn't (yet) have a token.
	"githubSyncEnabled",
	"githubRepo",
	"githubBranch",
	"githubPath",
	"githubApiBase",
	// Where the data file is on this device.
	"dataFolder",
]);

type Bag = Record<string, unknown>;

// Shallow copy without the device-specific keys: what goes into data.json.
export function omitDeviceLocal(settings: object): Bag {
	const src = settings as Bag;
	const out: Bag = {};
	for (const k of Object.keys(src)) if (!DEVICE_LOCAL_KEYS.has(k)) out[k] = src[k];
	return out;
}

// The only device-specific keys: what goes into its local storage.
export function pickDeviceLocal(settings: object): Bag {
	const src = settings as Bag;
	const out: Bag = {};
	for (const k of DEVICE_LOCAL_KEYS) if (src[k] !== undefined) out[k] = src[k];
	return out;
}
