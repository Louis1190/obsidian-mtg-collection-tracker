// Text of the small title placed above the content of a gallery (My Collection /
// My Decks / My Wantlists: "Lists: 12 lists" at rest, "Lists: 3 of 12 lists
// match" as soon as a search is typed) and, from inside an open
// list/deck/wantlist, above its cards ("Cards: 95 cards" / "Cards: 14 of 95
// cards match").
//
// `filtering` is passed explicitly rather than deduced from matched !== total: a
// search that keeps EVERYTHING ("a" on names that all contain one) must still
// announce itself as a search in progress ("12 of 12 … match") rather than
// becoming indistinguishable again from the unfiltered state.
//
// `noun` is the English singular ("list"/"deck"/"wantlist"): this plugin's three
// plurals are formed with a simple "s". The plural applies to the TOTAL ("0 of 1
// list matches", "1 of 3 lists match"), as the sentence naturally reads.
export function formatCountTitle(
	noun: string,
	matched: number,
	total: number,
	filtering: boolean
): string {
	const title = `${noun.charAt(0).toUpperCase()}${noun.slice(1)}s`;
	const one = total === 1;
	const label = one ? noun : `${noun}s`;
	if (!filtering) return `${title}: ${total} ${label}`;
	return `${title}: ${matched} of ${total} ${label} ${one ? "matches" : "match"}`;
}
