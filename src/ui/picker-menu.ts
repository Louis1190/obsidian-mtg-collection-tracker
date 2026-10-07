

// Petit menu contextuel léger, ancré sous l'élément cliqué, sans bouton
// visible autour du déclencheur (drapeau de langue, étoiles d'état...).
// Anchor du picker actuellement ouvert (s'il y en a un) : permet de détecter
// un reclic sur le même déclencheur pour fermer plutôt que rouvrir un menu
// identique, sans quoi cliquer deux fois sur la même icône (langue,
// condition, tri...) donnait l'impression que rien ne se passait.
let openPickerAnchorEl: HTMLElement | null = null;
// Nettoyage (écouteurs scroll/resize/click, voir plus bas) du picker
// actuellement ouvert, s'il y en a un — stocké au niveau module plutôt que
// dans une closure locale à un seul appel, pour qu'un appel SUIVANT de
// openPickerMenu (ouvrant un menu différent pendant qu'un premier est
// encore ouvert) puisse retirer les écouteurs de l'ancien avant de le
// supprimer du DOM, plutôt que de les laisser s'accumuler silencieusement.
let openPickerCleanup: (() => void) | null = null;

export function openPickerMenu(
	anchor: HTMLElement,
	items: { render: (el: HTMLElement) => void; onSelect: () => void }[],
	options?: { matchAnchorWidth?: boolean; menuClass?: string }
) {
	const reopeningSameAnchor = openPickerAnchorEl === anchor;
	if (openPickerCleanup) openPickerCleanup();
	document.querySelectorAll(".mtg-picker-menu").forEach((el) => el.remove());
	openPickerAnchorEl = null;
	openPickerCleanup = null;
	if (reopeningSameAnchor) return;
	openPickerAnchorEl = anchor;

	const menu = document.body.createDiv({ cls: "mtg-picker-menu" });
	if (options?.menuClass) menu.addClass(options.menuClass);
	if (options?.matchAnchorWidth) menu.addClass("is-match-anchor-width");

	// .mtg-picker-menu est position:fixed (pour échapper à l'overflow:hidden
	// de tout parent, ex. .mtg-main) — ses coordonnées top/left, calculées via
	// getBoundingClientRect (relatif au viewport), restent donc valables tant
	// que rien ne bouge, mais PAS quand l'élément qui défile réellement
	// (jamais la fenêtre/le document lui-même — voir "Floating Back to Top
	// button" dans les notes d'architecture) défile : .mtg-main pour la
	// grille d'ensemble, .mtg-detail-scroll-area une fois une liste/un deck/
	// une wantlist ouvert(e) (depuis le 2026-09-07, voir son propre
	// commentaire dans styles.css) — scroller à l'intérieur déplace l'icône
	// sous le menu sans que le menu, fixe par rapport à l'écran, ne suive
	// (bug rapporté : le picker restait figé à l'écran au lieu de rester
	// "attaché" à l'icône/bouton qui l'a ouvert). Recalculer top/left à
	// chaque scroll corrige ça. Un scroll event ne remonte PAS par bulles
	// vers un ancêtre : window doit donc écouter en phase de CAPTURE (3e
	// argument `true`) pour intercepter le scroll de N'IMPORTE QUEL
	// conteneur descendant — ce qui couvre les deux éléments ci-dessus (et
	// tout futur autre) sans changement nécessaire ici.
	const reposition = () => {
		const r = anchor.getBoundingClientRect();
		menu.style.top = `${r.bottom + 4}px`;
		menu.style.left = `${r.left}px`;
		if (options?.matchAnchorWidth) menu.style.width = `${r.width}px`;
	};
	reposition();

	const cleanup = () => {
		menu.remove();
		window.removeEventListener("scroll", reposition, true);
		window.removeEventListener("resize", reposition);
		document.removeEventListener("click", closeOnOutsideClick);
		openPickerAnchorEl = null;
		openPickerCleanup = null;
	};
	openPickerCleanup = cleanup;

	items.forEach((item) => {
		const el = menu.createDiv({ cls: "mtg-picker-item" });
		item.render(el);
		el.addEventListener("click", (evt) => {
			evt.stopPropagation();
			item.onSelect();
			cleanup();
		});
	});

	const closeOnOutsideClick = (evt: MouseEvent) => {
		if (!menu.contains(evt.target as Node)) cleanup();
	};
	window.addEventListener("scroll", reposition, true);
	window.addEventListener("resize", reposition);
	window.setTimeout(() => document.addEventListener("click", closeOnOutsideClick), 0);
}
