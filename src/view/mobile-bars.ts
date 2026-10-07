import { Platform } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
// Export NOMMÉ (pas `import type MTGCollectionView from`, contrairement à plugin.ts) — voir "Phase 5b"
// dans CLAUDE.md : la mauvaise syntaxe fait dégrader `this` en `any` et inonde tsc d'erreurs sans rapport.
import type { MTGCollectionView } from "../view";
import { VIEW_TYPE_MTG_COLLECTION } from "../core/data-model";

export const HIDE_BARS_CLASS = "mtg-hide-obsidian-bars";

// Posée sur `contentEl` (jamais sur <body> : elle ne peut donc pas survivre à la vue) tant qu'un champ de
// saisie du plugin a le focus sur téléphone, i.e. tant que le clavier est à l'écran — voir styles.css.
export const KEYBOARD_OPEN_CLASS = "mtg-keyboard-open";

// Câble la synchro barres ↔ feuille active. Appelé une fois depuis onOpen ; sans effet hors téléphone
// (tablette/bureau : pas de barres flottantes).
export function setupMobileBars(this: MTGCollectionView) {
	if (!Platform.isPhone) return;

	this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.syncMobileBars(leaf)));
	// Quoi qu'il arrive à la vue (onglet fermé, plugin désactivé), les barres doivent revenir.
	this.register(() => document.body.removeClass(HIDE_BARS_CLASS));
	// Une vue restaurée au démarrage s'ouvre avant que l'espace de travail sache quelle feuille est active :
	// on resynchronise une fois qu'il est prêt (l'appel direct ci-dessous couvre l'ouverture à chaud).
	this.app.workspace.onLayoutReady(() => this.syncMobileBars());
	this.syncMobileBars();

	// Clavier virtuel : Android redimensionne déjà la vue (le contenu remonte une 1ʳᵉ fois), mais les
	// réservations du bas (pilule de navigation flottante, marge de sécurité du geste système) restaient
	// appliquées au-dessus du clavier, qui les recouvre pourtant — d'où un grand vide noir (2026-10-01).
	// `--keyboard-height` d'Obsidian ne bouge pas de façon fiable ici (0px mesuré dans l'émulateur) : le
	// focus d'un champ de saisie est le signal le plus sûr. `focusout` est différé d'un tick pour ne pas
	// clignoter quand le focus passe d'un champ à un autre.
	const isTextField = (el: EventTarget | null) =>
		el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
	const syncKeyboard = () => this.contentEl.toggleClass(KEYBOARD_OPEN_CLASS, isTextField(document.activeElement));
	this.registerDomEvent(this.contentEl, "focusin", syncKeyboard);
	this.registerDomEvent(this.contentEl, "focusout", () => window.setTimeout(syncKeyboard, 0));
}

// `leaf` = la feuille devenue active (événement) ; `undefined` = appel direct (utilisé aussi par
// setting-tab.ts juste après avoir changé le réglage, pour re-synchroniser sans attendre un changement de
// feuille — voir son propre commentaire).
export function syncMobileBars(this: MTGCollectionView, leaf?: WorkspaceLeaf | null) {
	if (!Platform.isPhone) return;

	const current = leaf === undefined ? this.app.workspace.getMostRecentLeaf() : leaf;
	if (current === this.leaf) {
		document.body.toggleClass(HIDE_BARS_CLASS, this.plugin.settings.hideObsidianMobileBars);
	} else if (current?.view.getViewType() !== VIEW_TYPE_MTG_COLLECTION) {
		// Une autre vue est active : les barres reviennent, quel que soit le réglage — il ne s'applique
		// qu'à l'intérieur de ce plugin.
		document.body.removeClass(HIDE_BARS_CLASS);
	}
	// Sinon une AUTRE vue du plugin est devenue active (deux onglets du plugin) : c'est à elle de décider —
	// y toucher ici dépendrait de l'ordre dans lequel les deux écouteurs se déclenchent.
}
