// Texte du petit titre posé au-dessus du contenu d'une galerie (My
// Collection / My Decks / My Wantlists : « Lists: 12 lists » au repos,
// « Lists: 3 of 12 lists match » dès qu'une recherche est saisie) et, depuis
// l'intérieur d'une liste/deck/wantlist ouvert(e), au-dessus de ses cartes
// (« Cards: 95 cards » / « Cards: 14 of 95 cards match »).
//
// `filtering` est passé explicitement plutôt que déduit de matched !== total :
// une recherche qui retient TOUT (« a » sur des noms qui en contiennent tous)
// doit quand même s'annoncer comme une recherche en cours (« 12 of 12 … match »)
// au lieu de redevenir indiscernable de l'état sans filtre.
//
// `noun` est le singulier anglais ("list"/"deck"/"wantlist") : les trois
// pluriels de ce plugin se forment avec un simple « s ». Le pluriel porte sur
// le TOTAL (« 0 of 1 list matches », « 1 of 3 lists match »), comme la phrase
// le lit naturellement.
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
