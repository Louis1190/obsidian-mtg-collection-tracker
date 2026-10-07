import { App, Modal, Notice, Platform, setIcon } from "obsidian";
import { applyModalOpenAnimation, closeModalAnimated, addModalCloseButton } from "../ui/modal-animation";
import {
	DEFAULT_EXPORT_FOLDER,
	ExportContent,
	describeDeviceFolderError,
	deviceFolderDisplayPath,
	exportTargetExists,
	folderDisplayName,
	folderSentenceName,
	getDeviceFolderSupport,
	getLastDeviceFolder,
	getLastExportFolder,
	pickDeviceFolder,
	rememberDeviceFolder,
	rememberExportFolder,
	sanitizeFileName,
	sanitizeFolderPath,
	shareVaultFile,
	writeExportFile,
	writeToDeviceFolder,
} from "../ui/vault-export";

// Au-delà, la liste dit de continuer à taper pour restreindre — une vault de
// plusieurs centaines de dossiers n'a aucun intérêt à toutes les rendre d'un
// coup sur un téléphone.
const MAX_FOLDER_ROWS = 150;

// Fenêtre "Enregistrer sous" des exports sur mobile (iOS/Android), ouverte
// par saveExportedFile (ui/file-export.ts) — voir CLAUDE.md, "File export".
// Aucun plugin ne peut ouvrir la fenêtre système "Enregistrer sous" sur
// mobile ni écrire hors de la vault via l'API publique : la destination
// proposée ici est donc un dossier de la vault, et "Share…" est la porte de
// sortie vers le reste de l'appareil (Enregistrer dans Fichiers, autres apps)
// via la feuille de partage native. Sur Android, dont la feuille de partage
// ne liste que des applications (aucun "Enregistrer dans un dossier",
// contrairement à iOS), un bouton "Device folder…" ouvre le sélecteur de
// dossier natif d'Obsidian pour écrire dans n'importe quel dossier du
// téléphone — API non documentée, isolée dans vault-export.ts. Une fois un
// dossier utilisé avec succès, il est mémorisé (par appareil) : la fenêtre
// propose alors "Save to <dossier>" (écriture immédiate, sans sélecteur) et
// "Other…" pour en choisir un autre.
//
// Deux écrans dans la MÊME modale (formulaire / choix du dossier de la vault)
// plutôt qu'une seconde modale empilée : même schéma que les sous-écrans de
// ListSettingsModal (draw() qui rebranche selon un état), ce qui garde la
// croix ronde et l'animation partagées de toutes les modales du plugin.
export class ExportDestinationModal extends Modal {
	private exportContent: ExportContent;
	private fileName: string;
	private folder: string;
	private screen: "form" | "folders" = "form";
	private folderQuery = "";
	private busy = false;
	// Jeton de la dernière vérification "ce fichier existe déjà" : une
	// réponse arrivée après une frappe plus récente est ignorée.
	private existsCheckId = 0;

	constructor(app: App, content: ExportContent, filename: string) {
		super(app);
		this.exportContent = content;
		this.fileName = sanitizeFileName(filename);
		this.folder = getLastExportFolder();
	}

	onOpen() {
		// Fondu + zoom d'ouverture, partagé par toutes les modales du plugin —
		// voir modal-animation.ts.
		applyModalOpenAnimation(this);
		// Croix ronde de fermeture + masquage de la croix native d'Obsidian,
		// partagés par toutes les modales du plugin — voir modal-animation.ts.
		addModalCloseButton(this);
		this.contentEl.addClass("mtg-new-deck-modal");
		this.contentEl.addClass("mtg-export-modal");
		this.draw();
	}

	private draw() {
		this.contentEl.empty();
		if (this.screen === "folders") this.drawFolderScreen();
		else this.drawFormScreen();
	}

	private drawFormScreen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Save export" });

		const nameField = contentEl.createDiv({ cls: "mtg-search-field" });
		nameField.createEl("label", { text: "File name" });
		const nameInput = nameField.createEl("input", { type: "text" });
		nameInput.value = this.fileName;

		const folderField = contentEl.createDiv({ cls: "mtg-search-field" });
		folderField.createEl("label", { text: "Save to" });
		const folderBtn = folderField.createEl("button", { cls: "mtg-export-folder-btn" });
		setIcon(folderBtn.createSpan({ cls: "mtg-export-folder-btn-icon" }), "folder");
		folderBtn.createSpan({ cls: "mtg-export-folder-btn-label", text: folderDisplayName(this.folder) });
		setIcon(folderBtn.createSpan({ cls: "mtg-export-folder-btn-caret" }), "chevron-right");
		folderBtn.addEventListener("click", () => {
			if (this.busy) return;
			this.screen = "folders";
			this.folderQuery = "";
			this.draw();
		});

		const warningEl = contentEl.createDiv({ cls: "mtg-export-warning" });
		const errorEl = contentEl.createDiv({ cls: "mtg-error mtg-export-error" });

		const actions = contentEl.createDiv({ cls: "mtg-card-detail-actions mtg-export-actions" });
		const saveBtn = actions.createEl("button", { text: "Save", cls: "mtg-search-add-btn" });
		const shareBtn = actions.createEl("button", { text: "Share…", cls: "mtg-modal-cancel-btn" });
		// Android : avec un dossier de l'appareil déjà utilisé, "Save to <dossier>"
		// l'écrit tout de suite (aucun sélecteur) et "Other…" en choisit un autre ;
		// sans dossier mémorisé, un seul bouton "Device folder…" ouvre le sélecteur.
		const rememberedDevice = Platform.isAndroidApp ? getLastDeviceFolder() : null;
		let deviceQuickBtn: HTMLButtonElement | null = null;
		let deviceBtn: HTMLButtonElement | null = null;
		if (Platform.isAndroidApp) {
			if (rememberedDevice !== null) {
				const row = actions.createDiv({ cls: "mtg-export-device-row" });
				deviceQuickBtn = row.createEl("button", {
					cls: "mtg-modal-cancel-btn mtg-export-device-quick",
				});
				// Le libellé dans un <span> : text-overflow ne tronque pas (avec "…")
				// le texte direct d'un bouton inline-flex, seulement celui d'un
				// conteneur bloc — et un chemin de dossier peut être long.
				deviceQuickBtn.createSpan({
					cls: "mtg-export-device-quick-label",
					text: `Save to ${deviceFolderDisplayPath(rememberedDevice)}`,
				});
				// Le chemin complet en infobulle : le libellé peut être tronqué.
				deviceQuickBtn.setAttribute("title", rememberedDevice);
				deviceBtn = row.createEl("button", {
					text: "Other…",
					cls: "mtg-modal-cancel-btn mtg-export-device-other",
				});
			} else {
				deviceBtn = actions.createEl("button", { text: "Device folder…", cls: "mtg-modal-cancel-btn" });
			}
		}
		const cancelBtn = actions.createEl("button", { text: "Cancel", cls: "mtg-modal-cancel-btn" });
		contentEl.createDiv({
			cls: "mtg-export-hint",
			text: !Platform.isAndroidApp
				? "Share… hands the file to your device's share menu (Save to Files, other apps…)."
				: rememberedDevice !== null
					? "Share… opens the Android share menu. “Save to …” reuses your last device folder; “Other…” picks another one."
					: "Share… opens the Android share menu. Device folder… saves straight into a folder you pick on this phone.",
		});

		// Nom vide → aucun bouton d'écriture, plutôt qu'un clic silencieux
		// qui ne ferait rien (même raisonnement que NewListModal).
		const refresh = () => {
			const valid = sanitizeFileName(this.fileName, "") !== "";
			saveBtn.disabled = !valid || this.busy;
			shareBtn.disabled = !valid || this.busy;
			if (deviceBtn) deviceBtn.disabled = !valid || this.busy;
			if (deviceQuickBtn) deviceQuickBtn.disabled = !valid || this.busy;
			void this.refreshExistsWarning(warningEl);
		};
		nameInput.addEventListener("input", () => {
			this.fileName = nameInput.value;
			refresh();
		});
		refresh();

		const submit = async (share: boolean) => {
			const name = sanitizeFileName(this.fileName, "");
			if (name === "" || this.busy) return;
			this.busy = true;
			errorEl.setText("");
			saveBtn.disabled = true;
			shareBtn.disabled = true;
			saveBtn.setText("Saving…");
			try {
				const path = await writeExportFile(this.app, this.folder, name, this.exportContent);
				rememberExportFolder(this.folder);
				new Notice(`Saved ${name} to ${folderSentenceName(this.folder)}.`);
				this.close();
				// Après la fermeture : la feuille native se présente par-dessus
				// l'app, pas par-dessus cette modale en train de disparaître.
				if (share) await shareVaultFile(this.app, path);
			} catch (e) {
				console.error("MTG Collection Tracker: could not save the export file.", e);
				this.busy = false;
				saveBtn.setText("Save");
				refresh();
				errorEl.setText(`Could not save ${name}: ${e instanceof Error ? e.message : String(e)}`);
			}
		};
		saveBtn.addEventListener("click", () => void submit(false));
		shareBtn.addEventListener("click", () => void submit(true));
		cancelBtn.addEventListener("click", () => this.close());

		// Android uniquement : écriture directe dans un dossier de l'appareil — le
		// dossier mémorisé ("Save to …") ou un dossier choisi dans le sélecteur
		// natif d'Obsidian ("Other…"/"Device folder…"). Jamais d'écrasement (voir
		// writeToDeviceFolder). Chaque échec s'affiche ICI, dans la fenêtre,
		// plutôt que de laisser croire que rien ne s'est passé.
		const saveToDevice = async (knownFolder: string | null) => {
			const name = sanitizeFileName(this.fileName, "");
			if (name === "" || this.busy) return;
			const support = getDeviceFolderSupport(this.app);
			if (!support.ok) {
				errorEl.setText(support.reason);
				return;
			}
			this.busy = true;
			errorEl.setText("");
			refresh();
			let folder = knownFolder;
			try {
				if (folder === null) {
					folder = await pickDeviceFolder();
					if (folder === null) {
						// Annulé dans le sélecteur natif : rien à signaler.
						this.busy = false;
						refresh();
						return;
					}
				}
				const written = await writeToDeviceFolder(this.app, folder, name, this.exportContent);
				rememberDeviceFolder(folder);
				new Notice(`Saved ${written.name} to ${deviceFolderDisplayPath(folder)}.`);
				this.close();
			} catch (e) {
				console.error("MTG Collection Tracker: could not save to a device folder.", e);
				this.busy = false;
				refresh();
				// Un dossier déjà connu a pu disparaître depuis : le dire en clair
				// plutôt que d'afficher l'erreur native brute.
				const message =
					folder !== null
						? await describeDeviceFolderError(this.app, folder, e)
						: String((e as { message?: unknown } | null)?.message ?? e);
				errorEl.setText(`Could not save to a device folder: ${message}`);
			}
		};
		deviceQuickBtn?.addEventListener("click", () => void saveToDevice(rememberedDevice));
		deviceBtn?.addEventListener("click", () => void saveToDevice(null));
	}

	// Écrase sans demander à chaque export du même nom au même endroit, c'est
	// le comportement voulu (un export se régénère à tout moment) — mais avec
	// un dossier ET un nom choisis à la main, l'utilisateur doit au moins être
	// prévenu qu'un fichier existant va être remplacé.
	private async refreshExistsWarning(warningEl: HTMLElement) {
		const id = ++this.existsCheckId;
		const name = sanitizeFileName(this.fileName, "");
		let exists = false;
		if (name !== "") {
			try {
				exists = await exportTargetExists(this.app, this.folder, name);
			} catch {
				exists = false;
			}
		}
		if (id !== this.existsCheckId) return;
		warningEl.setText(exists ? "A file with this name already exists in this folder and will be replaced." : "");
	}

	private drawFolderScreen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Save to" });

		const searchField = contentEl.createDiv({ cls: "mtg-search-field" });
		const searchInput = searchField.createEl("input", {
			type: "text",
			placeholder: "Search, or type a new folder…",
		});
		searchInput.value = this.folderQuery;

		const paths = this.listFolderPaths();
		const listEl = contentEl.createDiv({ cls: "mtg-export-folder-list" });
		// Ne reconstruit que la liste à chaque frappe, jamais ce <input>
		// lui-même — même raisonnement (perte de focus en cours de saisie)
		// que SelectListModal/CopyCardModal.
		const renderRows = () => this.renderFolderRows(listEl, paths, searchInput.value);
		searchInput.addEventListener("input", () => {
			this.folderQuery = searchInput.value;
			renderRows();
		});
		renderRows();

		const actions = contentEl.createDiv({ cls: "mtg-card-detail-actions" });
		const backBtn = actions.createEl("button", { text: "Back", cls: "mtg-modal-cancel-btn" });
		backBtn.addEventListener("click", () => {
			this.screen = "form";
			this.draw();
		});
	}

	// Racine, dossier par défaut et dossier courant sont toujours proposés
	// même s'ils n'existent pas encore (le premier export sur une vault
	// vierge, un dossier mémorisé depuis supprimé) — ensureFolder les créera
	// à l'écriture.
	private listFolderPaths(): string[] {
		const set = new Set<string>(this.app.vault.getAllFolders(true).map((f) => (f.path === "" ? "/" : f.path)));
		set.add("/");
		set.add(DEFAULT_EXPORT_FOLDER);
		set.add(this.folder === "" ? "/" : this.folder);
		return Array.from(set).sort((a, b) => {
			// Racine d'abord, puis le dossier par défaut, puis l'ordre alphabétique.
			const rank = (p: string) => (p === "/" ? 0 : p === DEFAULT_EXPORT_FOLDER ? 1 : 2);
			return rank(a) - rank(b) || a.localeCompare(b);
		});
	}

	private renderFolderRows(listEl: HTMLElement, paths: string[], query: string) {
		listEl.empty();
		const q = query.trim().toLowerCase();
		const rows: { path: string; isNew: boolean }[] = [];

		// Un chemin tapé qui ne correspond à aucun dossier existant devient une
		// ligne "Create folder" en tête de liste.
		const typed = q === "" ? null : sanitizeFolderPath(query);
		if (typed && !paths.some((p) => p.toLowerCase() === typed.toLowerCase())) {
			rows.push({ path: typed, isNew: true });
		}
		const matches = paths.filter((p) => folderDisplayName(p).toLowerCase().includes(q));
		matches.slice(0, MAX_FOLDER_ROWS).forEach((path) => rows.push({ path, isNew: false }));

		if (rows.length === 0) {
			listEl.createDiv({ cls: "mtg-export-folder-empty", text: "No matching folder." });
			return;
		}
		rows.forEach(({ path, isNew }) => {
			const row = listEl.createDiv({ cls: "mtg-export-folder-row" });
			row.toggleClass("is-selected", !isNew && path === this.folder);
			setIcon(row.createSpan({ cls: "mtg-export-folder-row-icon" }), isNew ? "folder-plus" : "folder");
			row.createSpan({
				cls: "mtg-export-folder-row-label",
				text: isNew ? `Create folder “${path}”` : folderDisplayName(path),
			});
			if (!isNew && path === DEFAULT_EXPORT_FOLDER) {
				row.createSpan({ cls: "mtg-export-folder-row-tag", text: "default" });
			}
			if (!isNew && path === this.folder) {
				setIcon(row.createSpan({ cls: "mtg-export-folder-row-check" }), "check");
			}
			row.addEventListener("click", () => {
				this.folder = path;
				this.screen = "form";
				this.draw();
			});
		});
		if (matches.length > MAX_FOLDER_ROWS) {
			listEl.createDiv({
				cls: "mtg-export-folder-empty",
				text: `Showing the first ${MAX_FOLDER_ROWS} of ${matches.length} folders — type to narrow the list.`,
			});
		}
	}

	close() {
		closeModalAnimated(this, () => super.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
