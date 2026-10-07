
/* ---------------------------------------------------------------------------- */
/*  Pictogrammes proposés pour une liste, une wantlist ou un deck (mana, hybrides, autres).*/
/* ---------------------------------------------------------------------------- */

// Symboles de mana proposés par "Choose icon" (ListSettingsModal) — les 5
// couleurs + incolore, chacune une lettre reconnue par MTGCollectionPlugin.
// getManaSymbolSvg (endpoint /symbology de Scryfall). Pas de "multicolore"
// au sens du groupement par couleur des listes (qui peut afficher plusieurs
// symboles côte à côte pour un groupe multicolore, view.ts) : ça resterait
// hors de propos ici, un pictogramme de liste étant volontairement une
// seule icône à la fois — mais les 10 symboles HYBRIDES ci-dessous ne sont
// pas concernés par cette même restriction : "W/B" n'est pas 2 icônes
// combinées, c'est un unique symbole Scryfall à part entière (vérifié en
// direct sur /symbology, represents_mana: true), qui passe par le même
// getManaSymbolSvg(lettre) que les couleurs pures juste au-dessus — sa
// valeur ("W/B") sert telle quelle de clé `{W/B}` dans la symbologie,
// aucun changement de mécanisme nécessaire pour l'accueillir.
export const MANA_ICON_LETTERS: { letter: string; label: string; }[] = [
	{ letter: "W", label: "White" },
	{ letter: "U", label: "Blue" },
	{ letter: "B", label: "Black" },
	{ letter: "R", label: "Red" },
	{ letter: "G", label: "Green" },
	{ letter: "C", label: "Colorless" },
	{ letter: "W/U", label: "White/Blue" },
	{ letter: "W/B", label: "White/Black" },
	{ letter: "U/B", label: "Blue/Black" },
	{ letter: "U/R", label: "Blue/Red" },
	{ letter: "B/R", label: "Black/Red" },
	{ letter: "B/G", label: "Black/Green" },
	{ letter: "R/G", label: "Red/Green" },
	{ letter: "R/W", label: "Red/White" },
	{ letter: "G/W", label: "Green/White" },
	{ letter: "G/U", label: "Green/Blue" },
	// Hybride incolore (losange + couleur) — une mana incolore OU une
	// couleur donnée. Même mécanisme, vérifié en direct sur /symbology.
	{ letter: "C/W", label: "Colorless/White" },
	{ letter: "C/U", label: "Colorless/Blue" },
	{ letter: "C/B", label: "Colorless/Black" },
	{ letter: "C/R", label: "Colorless/Red" },
	{ letter: "C/G", label: "Colorless/Green" },
	// Hybride "2 générique" (chiffre 2 + couleur) — 2 mana générique OU une
	// couleur donnée. Même mécanisme, vérifié en direct sur /symbology.
	{ letter: "2/W", label: "Two/White" },
	{ letter: "2/U", label: "Two/Blue" },
	{ letter: "2/B", label: "Two/Black" },
	{ letter: "2/R", label: "Two/Red" },
	{ letter: "2/G", label: "Two/Green" },
	// Phyrexian (couleur pure) — même symbole Scryfall qu'un hybride
	// couleur/vie, vérifié en direct sur /symbology (represents_mana: true).
	{ letter: "W/P", label: "Phyrexian White" },
	{ letter: "U/P", label: "Phyrexian Blue" },
	{ letter: "B/P", label: "Phyrexian Black" },
	{ letter: "R/P", label: "Phyrexian Red" },
	{ letter: "G/P", label: "Phyrexian Green" },
	{ letter: "C/P", label: "Phyrexian Colorless" },
	// Phyrexian hybride (2 couleurs ou vie) — 10 combinaisons, même
	// mécanisme, vérifiées en direct de la même façon.
	{ letter: "W/U/P", label: "Phyrexian White/Blue" },
	{ letter: "W/B/P", label: "Phyrexian White/Black" },
	{ letter: "U/B/P", label: "Phyrexian Blue/Black" },
	{ letter: "U/R/P", label: "Phyrexian Blue/Red" },
	{ letter: "B/R/P", label: "Phyrexian Black/Red" },
	{ letter: "B/G/P", label: "Phyrexian Black/Green" },
	{ letter: "R/G/P", label: "Phyrexian Red/Green" },
	{ letter: "R/W/P", label: "Phyrexian Red/White" },
	{ letter: "G/W/P", label: "Phyrexian Green/White" },
	{ letter: "G/U/P", label: "Phyrexian Green/Blue" },
	// Snow (Coldsnap) — un seul symbole.
	{ letter: "S", label: "Snow" },
	// Mana générique — X/Y/Z (coûts variables) + 0-9, l'étendue réellement
	// courante sur une carte (choisi explicitement plutôt que l'exhaustif
	// 0-20/100/1000000/½/∞ que Scryfall connaît aussi : ces très grandes
	// valeurs n'apparaissent que sur des cartes blague/Un-sets, pas de quoi
	// justifier d'alourdir cette grille pour un pictogramme de liste).
	{ letter: "X", label: "X generic mana" },
	{ letter: "Y", label: "Y generic mana" },
	{ letter: "Z", label: "Z generic mana" },
	{ letter: "0", label: "0 generic mana" },
	{ letter: "1", label: "1 generic mana" },
	{ letter: "2", label: "2 generic mana" },
	{ letter: "3", label: "3 generic mana" },
	{ letter: "4", label: "4 generic mana" },
	{ letter: "5", label: "5 generic mana" },
	{ letter: "6", label: "6 generic mana" },
	{ letter: "7", label: "7 generic mana" },
	{ letter: "8", label: "8 generic mana" },
	{ letter: "9", label: "9 generic mana" },
];
// 3ᵉ onglet "Other symbol" de "Choose icon" — les symboles Scryfall qui
// n'ont rien à voir avec le coût en mana d'une carte (represents_mana:
// false sur l'endpoint /symbology, vérifié en direct : 9 au total sur les
// 84 symboles connus), des mécaniques de jeu qu'on retrouve littéralement
// imprimées sur une carte (engager/dégager une créature, un compteur
// d'énergie...). Même fonction de récupération que les couleurs de mana
// ci-dessus (MTGCollectionPlugin.getManaSymbolSvg cherche déjà juste
// `{${lettre}}` dans la symbologie, sans distinguer mana/non-mana).
// `recolor: true` marque les symboles dont le SVG Scryfall n'utilise qu'une
// seule couleur (#000 pur, sans arrière-plan — vérifié en direct sur chacun
// des 9 fichiers svgs.scryfall.io/card-symbols/*.svg) : quasi invisibles sur
// un thème sombre tant qu'ils ne sont pas recolorés, contrairement à
// Tap/Untap/Energy/Acorn (2 couleurs chacun, un badge circulaire en arrière-
// plan + un glyphe — recolorer ceux-là écraserait ce fond au passage, donc
// volontairement laissés tels quels). Voir renderSymbolGrid (dans chaque *-settings-modal.ts), qui
// applique applySvgColor uniquement quand ce champ est vrai.
export const OTHER_ICON_SYMBOLS: { letter: string; label: string; recolor?: boolean; }[] = [
	{ letter: "T", label: "Tap" },
	{ letter: "Q", label: "Untap" },
	{ letter: "E", label: "Energy" },
	{ letter: "PW", label: "Planeswalker", recolor: true },
	{ letter: "CHAOS", label: "Chaos", recolor: true },
	{ letter: "A", label: "Acorn counter" },
	{ letter: "TK", label: "Ticket counter", recolor: true },
	{ letter: "D", label: "Land drop", recolor: true },
	{ letter: "P", label: "Modal budget pawprint", recolor: true },
];
