import { AbstractInputSuggest, App, Notice, PluginSettingTab, Setting, TFolder } from "obsidian";
import type MTGCollectionPlugin from "./plugin";
import { CURRENCY_LABELS, PriceCurrency } from "./core/price";
import { testCardbaseConnection } from "./api/cardbase";
import { githubStatusLine } from "./plugin/github-sync";
import { saveExportedFile } from "./ui/file-export";
import { RestoreBackupConfirmModal, ClearAllDataConfirmModal } from "./modals/confirm-modals";
import { RestoreBackupModal } from "./modals/restore-backup-modal";
import { listBackups } from "./core/backup-files";
import { backupFolderPath } from "./plugin/backup";

/* -------------------------------------------------------------------------- */
/*  Settings tab                                                              */
/* -------------------------------------------------------------------------- */

// Autocomplétion "dossier de la vault" pour le champ "Backup folder" plus
// bas — Obsidian n'expose aucune API de navigateur de fichiers natif façon
// boîte de dialogue système à un plugin (voir l'enquête "Load backup file"
// plus haut dans ce fichier, qui a déjà tenté et documenté les limites de
// l'API Electron accessible ici) ; le mécanisme standard pour "choisir un
// dossier existant de la vault" est exactement celui qu'Obsidian utilise
// lui-même pour son propre "Move file to…" — une liste de suggestions
// attachée au champ texte, filtrée en tapant. `getSuggestions("")` (champ
// vide, ex. au tout premier clic dessus) renvoie déjà TOUS les dossiers —
// pas seulement une fois qu'on a commencé à taper — pour que cliquer dans
// le champ affiche directement une liste à parcourir, plus proche de
// "naviguer" que de deviner un nom à taper.
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.trim().toLowerCase();
		return this.app.vault
			.getAllFolders(true)
			.filter((f) => f.path.toLowerCase().includes(q))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement) {
		el.setText(folder.path === "/" ? "/ (vault root)" : folder.path);
	}
}

export class MTGCollectionSettingTab extends PluginSettingTab {
	plugin: MTGCollectionPlugin;

	constructor(app: App, plugin: MTGCollectionPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}


	// Construit un <input type="file"> réellement RATTACHÉ au document juste
	// avant d'appeler .click() dessus, puis le retire une fois le choix de
	// fichier traité — contrairement à un élément jamais inséré dans le DOM
	// (l'ancien code des deux boutons "Load … file…"), qui peut
	// occasionnellement ignorer .click() sur certaines versions de
	// Chromium/Electron. Positionné hors écran (transparent, en dehors du
	// viewport) plutôt que masqué via `display: none` — ce dernier retire
	// entièrement l'élément de l'arbre de RENDU, ce qui est documenté comme
	// pouvant faire ignorer .click() par certains moteurs, contrairement à
	// un élément simplement invisible à l'écran mais toujours rendu.
	// Utilisé par "Load .svg file…" et par "Load backup file…".
	private pickFile(accept: string, onFile: (file: File) => void | Promise<void>): void {
		const input = createEl("input");
		input.type = "file";
		input.accept = accept;
		input.addClass("mtg-offscreen-file-input");
		document.body.appendChild(input);
		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (file) void onFile(file);
			input.remove();
		});
		input.click();
	}

	// Partagé par les deux chemins de "Load backup file…" (l'API Electron
	// native de pickFileNative() et le repli <input> HTML de pickFile()) —
	// une fois le texte du fichier obtenu, le traitement (parsing,
	// confirmation, restauration) est identique quel que soit le mécanisme
	// qui a permis de l'obtenir.
	private async handleBackupFileText(text: string): Promise<void> {
		try {
			const parsed = this.plugin.parseBackupFile(text);
			if ("error" in parsed) {
				new Notice(parsed.error);
				return;
			}
			new RestoreBackupConfirmModal(this.app, parsed.summary, async () => {
				try {
					await this.plugin.restoreBackup(parsed.settings);
					new Notice("Backup restored.");
					this.display();
				} catch (e) {
					console.error("MTG Collection Tracker: restore failed", e);
					new Notice(`Error while restoring backup: ${(e as Error).message}`);
				}
			}).open();
		} catch (e) {
			console.error("MTG Collection Tracker: reading backup file failed", e);
			new Notice(`Error while reading backup file: ${(e as Error).message}`);
		}
	}

	private githubStatusTimer: number | null = null;

	hide(): void {
		if (this.githubStatusTimer !== null) {
			window.clearInterval(this.githubStatusTimer);
			this.githubStatusTimer = null;
		}
	}

	private renderDataStorage(containerEl: HTMLElement): void {
		const plugin = this.plugin;
		new Setting(containerEl).setName("Data storage").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Where your collection is kept. These settings, the GitHub token included, are specific to this device.",
		});

		let githubBox!: HTMLDivElement;
		let statusEl!: HTMLDivElement;
		const showStatus = () => {
			statusEl.setText(githubStatusLine(plugin));
			statusEl.className = "mtg-cardbase-status mtg-status-multiline" + (plugin.github.status.state === "error" ? " is-error" : "");
		};
		const showBox = () => {
			githubBox.style.display = plugin.settings.githubSyncEnabled ? "" : "none";
		};
		const applyGithub = async () => {
			await plugin.saveSettings();
			plugin.resetGithubSync();
			showStatus();
		};

		new Setting(containerEl)
			.setName("Where is your collection kept?")
			.setDesc(
				"On this device: in a folder of your vault, which you can sync yourself (Syncthing, iCloud…). On GitHub: also in a private repository, synced automatically — this device keeps a local copy so it works offline."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ device: "On this device", github: "On GitHub (private repository)" })
					.setValue(plugin.settings.githubSyncEnabled ? "github" : "device")
					.onChange(async (value) => {
						plugin.settings.githubSyncEnabled = value === "github";
						showBox();
						await applyGithub();
					})
			);

		new Setting(containerEl)
			.setName("Data folder")
			.setDesc(
				"Folder of your vault that holds the data file. Empty = the plugin's own hidden folder (default). Pick a visible folder to sync it yourself — and pick the same folder on every device you sync. Changing it copies your data there (merging with a file already in it) and leaves the previous file where it was."
			)
			.addText((text) => {
				text.setPlaceholder("(plugin folder)").setValue(plugin.settings.dataFolder);
				const apply = async (value: string) => {
					const result = await plugin.changeDataFolder(value);
					if (result.ok) {
						text.setValue(plugin.settings.dataFolder);
						new Notice(
							plugin.settings.dataFolder
								? `Your data is now stored in "${plugin.settings.dataFolder}"${result.mergedExisting ? " (merged with the file already there)" : ""}.`
								: "Your data is back in the plugin's own folder."
						);
					} else {
						text.setValue(plugin.settings.dataFolder);
						new Notice(`Could not change the data folder: ${result.message}`);
					}
				};
				text.inputEl.addEventListener("change", () => void apply(text.getValue()));
				new FolderSuggest(this.app, text.inputEl).onSelect((folder) => {
					text.setValue(folder.path === "/" ? "" : folder.path);
					void apply(text.getValue());
				});
			});

		githubBox = containerEl.createDiv();
		showBox();

		const textSetting = (
			name: string,
			desc: string,
			placeholder: string,
			read: () => string,
			write: (value: string) => void | Promise<void>,
			password = false
		) =>
			new Setting(githubBox).setName(name).setDesc(desc).addText((text) => {
				if (password) text.inputEl.type = "password";
				text.setPlaceholder(placeholder).setValue(password ? "" : read());
				let pending = "";
				text.onChange((value) => {
					pending = value;
				});
				const commitValue = async () => {
					const value = password ? pending : pending || text.getValue();
					// Un champ jeton vidé par erreur ne doit pas effacer le jeton enregistré.
					if (password && !value) return;
					await write(value);
					await applyGithub();
					if (password) {
						text.setValue("");
						text.setPlaceholder("Saved on this device — paste another to replace it");
					}
				};
				text.inputEl.addEventListener("change", () => void commitValue());
			});

		textSetting(
			"Repository",
			"A PRIVATE repository created for this, as owner/name. Not this plugin's own repository: every push there publishes a release.",
			"owner/mtg-data",
			() => plugin.settings.githubRepo,
			(v) => void (plugin.settings.githubRepo = v.trim())
		);
		textSetting(
			"Branch",
			"The repository must already have it (create the repository with a README).",
			"main",
			() => plugin.settings.githubBranch,
			(v) => void (plugin.settings.githubBranch = v.trim() || "main")
		);
		textSetting(
			"Folder in the repository",
			"Where the data files go inside the repository (one small file per list, deck and wantlist).",
			"mtg-collection",
			() => plugin.settings.githubPath,
			(v) => void (plugin.settings.githubPath = v.trim())
		);
		textSetting(
			"Token",
			'A fine-grained personal access token limited to that repository, with "Contents: Read and write". Kept in Obsidian\'s secret storage on this device; never written to your data or backups.',
			plugin.getGithubToken() ? "Saved on this device — paste another to replace it" : "github_pat_…",
			() => "",
			(v) => plugin.setGithubToken(v),
			true
		);

		new Setting(githubBox)
			.addButton((btn) =>
				btn.setButtonText("Test connection").onClick(async () => {
					statusEl.className = "mtg-cardbase-status";
					statusEl.setText("Testing…");
					const report = await plugin.githubTestNow();
					statusEl.setText(report.lines.join("\n"));
					statusEl.className = "mtg-cardbase-status " + (report.ok ? "is-success" : "is-error");
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Sync now").onClick(async () => {
					statusEl.className = "mtg-cardbase-status mtg-status-multiline";
					statusEl.setText("Syncing…");
					await plugin.githubSync("manual");
					showStatus();
				})
			);

		statusEl = githubBox.createDiv({ cls: "mtg-cardbase-status mtg-status-multiline" });
		showStatus();
		// Le statut change tout seul (sondage, envoi) : on le rafraîchit tant que la page est ouverte.
		this.githubStatusTimer = window.setInterval(() => {
			if (plugin.settings.githubSyncEnabled && plugin.github.status.state !== "syncing") showStatus();
		}, 2000);
	}

	display(): void {
		const { containerEl } = this;
		this.hide();
		containerEl.empty();

		new Setting(containerEl)
			.setName("Collection size")
			.setDesc(
				`You currently have ${this.plugin.settings.collection.length} unique printings tracked.`
			);

		new Setting(containerEl).setName("Interface").setHeading();

		new Setting(containerEl)
			.setName("Accent color")
			.setDesc(
				"Used for highlighted buttons and elements throughout the plugin (e.g. \"+ Add cards\")."
			)
			.addColorPicker((picker) =>
				picker
					.setValue(this.plugin.settings.accentColor || "#7c3aed")
					.onChange(async (value) => {
						this.plugin.settings.accentColor = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAccentColor();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("rotate-ccw")
					.setTooltip("Reset to theme color")
					.onClick(async () => {
						this.plugin.settings.accentColor = "";
						await this.plugin.saveSettings();
						this.plugin.refreshAccentColor();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Custom ribbon icon")
			.setDesc(
				"Load your own .svg file to replace the ribbon icon used to open the collection."
			)
			.addButton((btn) =>
				btn.setButtonText("Load .svg file…").onClick(() => {
					this.pickFile(".svg,image/svg+xml", async (file) => {
						const text = await file.text();
						if (!/<svg[\s>]/i.test(text)) {
							new Notice("This file doesn't look like a valid SVG.");
							return;
						}
						this.plugin.settings.customIconSvg = text.trim();
						await this.plugin.saveSettings();
						this.plugin.refreshCollectionRibbonIcon();
						new Notice(`Icon loaded from ${file.name}.`);
					});
				})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("rotate-ccw")
					.setTooltip("Reset to default icon")
					.onClick(async () => {
						this.plugin.settings.customIconSvg = "";
						await this.plugin.saveSettings();
						this.plugin.refreshCollectionRibbonIcon();
						new Notice("Ribbon icon reset to default.");
					})
			);

		new Setting(containerEl)
			.setName("Ribbon icon color")
			.setDesc("Only applies when a custom SVG icon is loaded above.")
			.addColorPicker((picker) =>
				picker
					.setValue(this.plugin.settings.customIconColor || "#8888ff")
					.onChange(async (value) => {
						this.plugin.settings.customIconColor = value;
						await this.plugin.saveSettings();
						this.plugin.refreshCollectionRibbonIcon();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("rotate-ccw")
					.setTooltip("Reset to theme color")
					.onClick(async () => {
						this.plugin.settings.customIconColor = "";
						await this.plugin.saveSettings();
						this.plugin.refreshCollectionRibbonIcon();
						this.display();
					})
			);

		// Téléphone uniquement (voir la description) — le plugin devient une pilule flottante en bas
		// (src/view/mobile-bars.ts, styles.css) et masque par défaut la barre flottante d'Obsidian et son
		// en-tête pour laisser plus de place au contenu. Ce réglage remplace, depuis 2026-09-27, l'ancien
		// bouton "œil" de la rampe (révélation éphémère le temps de la visite) — la pilule n'a plus de place
		// pour un 6ᵉ item de ce genre, et une préférence qu'on ne change pas à chaque visite est de toute
		// façon plus à sa place ici que dans un bouton constamment visible.
		new Setting(containerEl)
			.setName("Hide Obsidian's mobile bars")
			.setDesc(
				"On a phone, hide Obsidian's own floating navigation bar and header while this plugin is open, to free up space. Turn this off if you need Obsidian's tab switcher or left-drawer button while browsing the collection."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideObsidianMobileBars).onChange(async (value) => {
					this.plugin.settings.hideObsidianMobileBars = value;
					await this.plugin.saveSettings();
					this.plugin.refreshMobileBars();
				})
			);

		new Setting(containerEl).setName("Performance").setHeading();

		new Setting(containerEl)
			.setName("Suggestion counts")
			.setDesc(
				"When searching, show how many cards match each suggestion (e.g. \"Blue (12)\") before you pick it. Recalculated on every keystroke, so it's capped by list size to stay fast — raise this if you have a large collection and don't notice any slowdown."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"0": "Off",
						"2000": "Up to 2,000 cards",
						"5000": "Up to 5,000 cards (default)",
						"10000": "Up to 10,000 cards",
						"25000": "Up to 25,000 cards",
						"-1": "Always (any size)",
					})
					.setValue(String(this.plugin.settings.suggestionCountThreshold))
					.onChange(async (value) => {
						this.plugin.settings.suggestionCountThreshold = Number(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Price").setHeading();

		new Setting(containerEl)
			.setName("Price currency")
			.setDesc(
				"Scryfall only provides one price per currency/finish (sourced from TCGPlayer for USD and Cardmarket for EUR) — not the full breakdown some price-tracking apps offer (TCGPlayer Low/Mid/High, buylist prices, etc.). Foil cards correctly use the foil-specific price."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						usd: CURRENCY_LABELS.usd.name,
						eur: CURRENCY_LABELS.eur.name,
					})
					.setValue(this.plugin.settings.priceCurrency)
					.onChange(async (value) => {
						this.plugin.settings.priceCurrency = value as PriceCurrency;
						await this.plugin.saveSettings();
						this.plugin.refreshOpenViews();
					})
			);

		const lastRefresh = this.plugin.settings.lastPriceRefresh;
		const lastRefreshText = lastRefresh
			? `Last refreshed: ${new Date(lastRefresh).toLocaleString()}.`
			: "Never refreshed yet.";
		new Setting(containerEl)
			.setName("Price refresh")
			.setDesc(
				`Scryfall itself only updates prices about once a day, so refreshing more often than that gains nothing — it just re-downloads the same numbers. ${lastRefreshText}`
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"0": "Off",
						"24": "Every 24 hours (default)",
						"48": "Every 48 hours",
						"168": "Every week",
						"720": "Every month",
					})
					.setValue(String(this.plugin.settings.priceRefreshIntervalHours))
					.onChange(async (value) => {
						this.plugin.settings.priceRefreshIntervalHours = Number(value);
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("refresh-cw")
					.setTooltip("Refresh prices now")
					.onClick(async () => {
						const notice = new Notice("Refreshing prices…", 0);
						try {
							const result = await this.plugin.refreshAllPrices(
								(msg) => notice.setMessage(msg),
								{ respectCooldown: true }
							);
							notice.hide();
							if (result.skipped) {
								const minutes = Math.ceil((result.retryInMs ?? 0) / 60000);
								new Notice(`Prices were just refreshed — try again in ~${minutes} min.`);
								return;
							}
							new Notice(`Prices refreshed — ${result.updated} card(s) changed.`);
							// refreshAllPrices() ne re-rend pas les vues ouvertes (seul
							// maybeAutoRefreshPrices() le fait, après coup) : l'ancien bouton
							// "Refresh Prices" du menu latéral s'en chargeait lui-même, retiré le
							// 2026-09-26 — ce bouton-ci est désormais le seul déclencheur manuel,
							// donc sans cet appel la vue derrière la fenêtre de réglages
							// garderait ses anciens prix jusqu'à son prochain rendu.
							this.plugin.refreshOpenViews();
							this.display();
						} catch (e) {
							notice.hide();
							new Notice(`Error while refreshing prices: ${(e as Error).message}`);
						}
					})
			);

		new Setting(containerEl).setName("External resources").setHeading();
		containerEl.createEl("p", {
			cls: "mtg-status",
			text: "This plugin talks to a few free, public data sources to fetch card data and prices — none require an account, except cardbase.dev's optional key below (unlocks a longer price history).",
		});

		new Setting(containerEl)
			.setName("Scryfall")
			.setDesc(
				"The backbone of this plugin — card search, images, prices (USD/EUR), format legalities, and rules text. Free, no API key needed."
			);

		new Setting(containerEl)
			.setName("Card Kingdom")
			.setDesc(
				'Provides the Card Kingdom retail price shown in "Store prices". Free, public pricelist, no account needed.'
			);

		new Setting(containerEl)
			.setName("Mana Pool")
			.setDesc(
				'Provides the Mana Pool retail price shown in "Store prices". Free, public pricelist, no account needed.'
			);

		// Champ masqué par défaut (type="password"), avec un bouton "œil" —
		// apiKeyInputEl/eyeBtnEl sont capturés ici pour être ré-assemblés juste
		// après (voir inputGroup plus bas) en un seul contrôle visuel au lieu de
		// deux éléments séparés par l'espacement par défaut d'Obsidian entre
		// les composants d'un Setting. La sauvegarde reste automatique à chaque
		// frappe (onChange, même convention que tous les autres réglages de ce
		// plugin) — "Validate Key" ne sert qu'à vérifier/afficher un statut,
		// pas à sauvegarder (déjà fait).
		// cardbaseStatusEl/apiKeyInputEl/eyeBtnEl : déclarées avant le Setting
		// (capturées par ses closures onChange/onClick) mais assignées/
		// réarrangées après (pour finir dans le bon ordre visuel) — les
		// closures ne s'exécutent qu'au clic/frappe de l'utilisateur, bien
		// après la fin de display(), donc tout est déjà en place à ce moment.
		// `!` (definite assignment) sur ces deux-là : TS ne peut pas savoir que
		// .addText/.addExtraButton exécutent leur callback de façon synchrone
		// pendant la construction du Setting ci-dessous — mais c'est bien le
		// cas, donc les deux sont réellement assignées avant d'être relues par
		// inputGroup juste après.
		let cardbaseStatusEl: HTMLDivElement;
		let apiKeyInputEl!: HTMLInputElement;
		let eyeBtnEl!: HTMLElement;

		new Setting(containerEl)
			.setName("Cardbase.dev API key")
			.setDesc(
				'Optional. Powers the "Price history" chart in card detail (Card Kingdom + TCGplayer, sourced from cardbase.dev — Mana Pool isn\'t covered there). Without a key you still get 30 days of history; a free key from cardbase.dev\'s dashboard unlocks 365 days.'
			)
			.addText((text) => {
				apiKeyInputEl = text.inputEl;
				apiKeyInputEl.type = "password";
				text
					.setPlaceholder("cbdev_…")
					.setValue(this.plugin.settings.cardbaseApiKey)
					.onChange(async (value) => {
						this.plugin.settings.cardbaseApiKey = value.trim();
						await this.plugin.saveSettings();
						// La clé a changé depuis la dernière validation — un statut
						// resté affiché deviendrait trompeur (vert alors que la clé
						// affichée n'est plus celle qui a été vérifiée).
						cardbaseStatusEl.setText("");
						cardbaseStatusEl.className = "mtg-cardbase-status";
					});
			})
			.addExtraButton((btn) => {
				eyeBtnEl = btn.extraSettingsEl;
				btn.setIcon("eye")
					.setTooltip("Show key")
					.onClick(() => {
						const showing = apiKeyInputEl.type === "text";
						apiKeyInputEl.type = showing ? "password" : "text";
						btn.setIcon(showing ? "eye" : "eye-off").setTooltip(showing ? "Show key" : "Hide key");
					});
			})
			.addButton((btn) =>
				btn.setButtonText("Validate key").onClick(async () => {
					const key = this.plugin.settings.cardbaseApiKey;
					cardbaseStatusEl.className = "mtg-cardbase-status";
					if (!key) {
						cardbaseStatusEl.setText("No key set — using anonymous access (30 days of history).");
						return;
					}
					cardbaseStatusEl.setText("Validating…");
					// Pas d'endpoint dédié "vérifier ma clé" côté cardbase (voir
					// testCardbaseConnection) — le signal utilisé est justement le
					// bug corrigé plus haut : une clé qui n'élève pas réellement le
					// palier échoue avec un 400 précis dès qu'on demande plus de 30
					// jours.
					const result = await testCardbaseConnection(key);
					if (result === "ok") {
						cardbaseStatusEl.setText("✓ Connected — 365 days of history unlocked.");
						cardbaseStatusEl.addClass("is-success");
					} else if (result === "rejected") {
						cardbaseStatusEl.setText(
							"⚠ Key not recognized by cardbase.dev — falling back to 30-day anonymous access. Double-check it was copied correctly."
						);
						cardbaseStatusEl.addClass("is-error");
					} else {
						cardbaseStatusEl.setText("✕ Could not reach cardbase.dev — check your internet connection and try again.");
						cardbaseStatusEl.addClass("is-error");
					}
				})
			);

		// Ressoude l'input et le bouton "œil" en un seul contrôle visuel
		// (bordure commune, coin arrondi seulement sur les bords extérieurs) —
		// littéralement "collé au champ", plutôt que la tentative plus
		// risquée de superposer l'icône À L'INTÉRIEUR du champ lui-même (qui
		// suppose un padding/une hauteur d'input précis, pas garanti stable
		// d'un thème communautaire Obsidian à l'autre sans vraie instance
		// Obsidian ici pour le vérifier). apiKeyInputEl/eyeBtnEl existent déjà
		// dans le DOM (ajoutés par .addText/.addExtraButton juste au-dessus,
		// dans .setting-item-control) — on les déplace simplement dans un
		// wrapper commun, sans rien recréer.
		const inputGroup = createDiv();
		inputGroup.className = "mtg-cardbase-key-input-group";
		apiKeyInputEl.parentElement?.insertBefore(inputGroup, apiKeyInputEl);
		inputGroup.appendChild(apiKeyInputEl);
		inputGroup.appendChild(eyeBtnEl);

		cardbaseStatusEl = containerEl.createDiv({ cls: "mtg-cardbase-status" });

		new Setting(containerEl)
			.setName("Frankfurter.dev")
			.setDesc(
				'Provides the USD/EUR exchange rate used by the "Price history" chart to convert a vendor\'s native currency to your chosen display currency. Free, no account needed.'
			);

		new Setting(containerEl).setName("Backup").setHeading();

		// Passe par ui/file-export.ts (et non view.ts/downloadTextFile) :
		// setting-tab.ts reste volontairement isolé de view.ts (voir sa
		// propre note dans "Files", CLAUDE.md — "zéro consommateur externe
		// hormis onload()"), alors que ce module-là n'a aucune dépendance
		// vers view.ts. Sur mobile un <a download> est silencieusement
		// inopérant — le fichier est alors écrit dans la vault puis partagé
		// nativement (voir saveExportedFile).
		new Setting(containerEl)
			.setName("Export backup")
			.setDesc(
				"Download a JSON file with your entire collection, decks, wantlists, and settings. Your cardbase.dev API key (above) is deliberately left out of this file — re-enter it after a restore if needed."
			)
			.addButton((btn) =>
				btn.setButtonText("Export backup").onClick(() => {
					void saveExportedFile(
						this.app,
						this.plugin.exportBackup(),
						`mtg-collection-backup-${new Date().toISOString().slice(0, 10)}.json`,
						"application/json"
					);
					new Notice(
						`Backup exported — ${this.plugin.settings.collection.length} card(s), ${this.plugin.settings.decks.length} deck(s), ${this.plugin.settings.wantlist.length} wantlist item(s).`
					);
				})
			);

		new Setting(containerEl)
			.setName("Restore backup")
			.setDesc(
				"Restore a backup, either one of the backups saved in your backup folder (see below) or a backup file from anywhere else. This completely replaces your current collection, decks, wantlists, and settings — you'll be asked to confirm the details before anything changes."
			)
			.addButton((btn) =>
				btn.setButtonText("Choose a saved backup…").onClick(() => {
					const folder = backupFolderPath(this.plugin);
					new RestoreBackupModal(this.app, folder, listBackups(this.plugin.listBackupFiles()), (backup) => {
						void (async () => {
							try {
								await this.handleBackupFileText(await this.plugin.readBackupFile(backup.path));
							} catch (e) {
								console.error("MTG Collection Tracker: reading the saved backup failed", e);
								new Notice(`Error while reading backup file: ${(e as Error).message}`);
							}
						})();
					}).open();
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Load backup file…").onClick(() => {
					// Un fichier d'ailleurs : le sélecteur de fichier du système (voir le commentaire en tête de cette classe).
					this.pickFile(".json,application/json", async (file) => {
						await this.handleBackupFileText(await file.text());
					});
				})
			);

		// Sauvegardes automatiques (2026-09-02) — même trio dropdown/dernière-
		// exécution/bouton "now" que "Price refresh" plus haut dans ce fichier,
		// même schéma de réglages (0 = désactivé). Écrit le même contenu
		// qu'"Export backup" ci-dessus (voir MTGCollectionPlugin.runAutoBackup),
		// mais dans un dossier de la vault plutôt que téléchargé à la main.
		const lastAutoBackup = this.plugin.settings.lastAutoBackup;
		const lastAutoBackupText = lastAutoBackup
			? `Last backup: ${new Date(lastAutoBackup).toLocaleString()}.`
			: "No automatic backup yet.";
		// Les 3 réglages ci-dessous (Automatic backups/Backup folder/Backups
		// to keep) forment un seul sous-ensemble logique — regroupés dans un
		// même conteneur (.mtg-settings-group, styles.css) pour se lire comme
		// UNE SEULE carte visuellement plutôt que 3 cartes empilées côte à
		// côte, demandé explicitement après coup ("réunir la sous-section...
		// en un seul sous-ensemble"). "Export backup"/"Restore backup"
		// juste au-dessus restent chacun leur propre Setting inchangé — ce
		// regroupement n'était demandé que pour ce trio.
		const autoBackupGroup = containerEl.createDiv({ cls: "mtg-settings-group" });
		new Setting(autoBackupGroup)
			.setName("Automatic backups")
			.setDesc(
				`Periodically writes the same file as "Export backup" above into a folder in your vault (see below), so you always have a recent copy without remembering to export manually. ${lastAutoBackupText}`
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"0": "Off",
						"24": "Daily",
						"168": "Weekly (default)",
						"720": "Monthly",
					})
					.setValue(String(this.plugin.settings.autoBackupIntervalHours))
					.onChange(async (value) => {
						this.plugin.settings.autoBackupIntervalHours = Number(value);
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("save")
					.setTooltip("Back up now")
					.onClick(async () => {
						const result = await this.plugin.runAutoBackup();
						if ("error" in result) {
							new Notice(`Backup failed: ${result.error}`);
							return;
						}
						new Notice(`Backup saved to ${result.path}.`);
						this.display();
					})
			);

		new Setting(autoBackupGroup)
			.setName("Backup folder")
			.setDesc(
				"Vault-relative folder for automatic backups — created automatically if it doesn't exist yet. Click the field to browse existing folders, or type a new one."
			)
			.addText((text) => {
				text
					.setPlaceholder("MTG Backups")
					.setValue(this.plugin.settings.autoBackupFolder)
					.onChange(async (value) => {
						this.plugin.settings.autoBackupFolder = value.trim() || "MTG Backups";
						await this.plugin.saveSettings();
					});
				// Voir FolderSuggest en haut de ce fichier — choisir une
				// suggestion appelle AbstractInputSuggest.setValue() en interne,
				// qui met bien à jour text.inputEl.value, mais ne déclenche PAS
				// l'événement DOM "input" que TextComponent.onChange écoute (une
				// affectation JS directe de .value n'émet jamais cet événement) :
				// sans ce .onSelect() séparé, choisir une suggestion changerait
				// l'affichage sans jamais sauvegarder le nouveau réglage.
				new FolderSuggest(this.app, text.inputEl).onSelect(async (folder) => {
					text.setValue(folder.path);
					this.plugin.settings.autoBackupFolder = folder.path;
					await this.plugin.saveSettings();
				});
			});

		new Setting(autoBackupGroup)
			.setName("Backups to keep")
			.setDesc(
				"Older automatic backups beyond this count are moved to trash (never a manual export you place in the same folder)."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"3": "3",
						"7": "7 (default)",
						"10": "10",
						"20": "20",
					})
					.setValue(String(this.plugin.settings.autoBackupKeepCount))
					.onChange(async (value) => {
						this.plugin.settings.autoBackupKeepCount = Number(value);
						await this.plugin.saveSettings();
					})
			);

		this.renderDataStorage(containerEl);

		new Setting(containerEl).setName("Clear data").setHeading();

		new Setting(containerEl)
			.setName("Clear all data")
			.setDesc(
				// Bug rapporté : l'ancien code ne vidait que settings.collection
				// (les cartes elles-mêmes), laissant derrière lui les listes de
				// "My Collection" (settings.lists) maintenant vides mais toujours
				// présentes. Corrigé en vidant les deux ensemble. Élargi le jour
				// même à decks/wantlist/wantlists, demandé explicitement — voir le
				// gestionnaire de clic plus bas.
				"Delete every tracked card, deck, and wantlist item — along with the (now-empty) lists/wantlists they belonged to. This cannot be undone."
			)
			.addButton((btn) =>
				btn
					.setButtonText("Clear")
					.setWarning()
					.onClick(() => {
						// Deux bugs/demandes rapportés ensemble : (1) aucune
						// confirmation avant une action irréversible — corrigé via
						// ClearAllDataConfirmModal, même gabarit que
						// RestoreBackupConfirmModal ; (2) la vue déjà ouverte ne se
						// mettait jamais à jour après le clic (le plugin vidait bien
						// les données, mais rien ne rafraîchissait la vue elle-même —
						// this.display() ne redessine QUE ce panneau de réglages) —
						// corrigé en appelant refreshOpenViews() (le même helper déjà
						// utilisé par le changement de devise d'affichage, voir
						// plugin.ts) juste après la sauvegarde.
						new ClearAllDataConfirmModal(
							this.app,
							this.plugin.settings.collection.length,
							this.plugin.settings.lists.length,
							this.plugin.settings.decks.length,
							this.plugin.settings.wantlist.length,
							this.plugin.settings.wantlists.length,
							async () => {
								this.plugin.settings.collection = [];
								this.plugin.settings.lists = [];
								this.plugin.settings.decks = [];
								this.plugin.settings.wantlist = [];
								this.plugin.settings.wantlists = [];
								await this.plugin.saveSettings();
								this.plugin.refreshOpenViews();
								new Notice("All data cleared.");
								this.display();
							}
						).open();
					})
			);
	}
}
