import { AbstractInputSuggest, App, Notice, PluginSettingTab, Setting, TFolder } from "obsidian";
import type { SettingDefinition, SettingDefinitionItem } from "obsidian";
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

// Autocompletion "vault folder" for the "Backup folder" field further down
// — Obsidian exposes no native system-dialog-style file browser API to a
// plugin (see the "Load backup file" investigation higher in this file,
// which already tried and documented the limits of the Electron API
// reachable here); the standard mechanism for "choose an existing vault
// folder" is exactly the one Obsidian itself uses for its own "Move file
// to…" — a list of suggestions attached to the text field, filtered as you
// type. `getSuggestions("")` (empty field, e.g. on the very first click in
// it) already returns ALL the folders — not only once typing has started —
// so that clicking into the field directly shows a list to browse, closer
// to "navigating" than to guessing a name to type.
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

// One row of the tab: what the settings search reads (name, desc, aliases) plus the function that puts the
// controls into the row. Obsidian creates the row and has already set its name and description when `render`
// runs; the legacy path below does the same. `desc` is therefore the STATIC text (it is also what the search
// indexes, once, when the tab is added): a text that depends on the data (a count, a date) is set again by
// `render` with `setting.setDesc(...)`, which runs every time the row is drawn.
interface Row {
	name: string;
	desc?: string;
	aliases?: string[];
	// false = not offered by the settings search (an intro paragraph, a status line); a function is read at each search.
	searchable?: boolean | (() => boolean);
	visible?: () => boolean;
	// May return a cleanup, called before the row is thrown away (a timer to stop).
	render?: (setting: Setting) => void | (() => void);
}

// A card of rows. `heading` is its title; `legacyBox` is a CSS class the OLD path wraps the rows in (the three
// automatic-backup rows used to be one single card, see .mtg-settings-group in styles.css — on Obsidian 1.13+
// every group already is one card, so the class is not passed on).
interface Section {
	heading?: string;
	legacyBox?: string;
	visible?: () => boolean;
	rows: Row[];
}

// A guide for the three descriptions that are completed at draw time (see Row.desc).
const PRICE_REFRESH_DESC =
	"Scryfall itself only updates prices about once a day, so refreshing more often than that gains nothing — it just re-downloads the same numbers.";
const AUTO_BACKUP_DESC =
	'Periodically writes the same file as "Export backup" above into a folder in your vault (see below), so you always have a recent copy without remembering to export manually.';

export class MTGCollectionSettingTab extends PluginSettingTab {
	plugin: MTGCollectionPlugin;

	// Cleanups of the rows drawn by the legacy path (Obsidian < 1.13 has no per-row cleanup: hide() runs them).
	private legacyCleanups: (() => void)[] = [];
	// The line that shows the state of the GitHub sync, while its row exists.
	private githubStatusEl: HTMLElement | null = null;

	constructor(app: App, plugin: MTGCollectionPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}


	// Builds an <input type="file"> actually ATTACHED to the document just
	// before calling .click() on it, then removes it once the file choice has
	// been processed — unlike an element never inserted into the DOM (the old
	// code of the two "Load … file…" buttons), which can occasionally ignore
	// .click() on some Chromium/Electron versions. Positioned off-screen
	// (transparent, outside the viewport) rather than hidden via `display:
	// none` — the latter removes the element entirely from the RENDER tree,
	// which is documented as possibly making some engines ignore .click(),
	// unlike an element that is merely invisible on screen but still rendered.
	// Used by "Load .svg file…" and by "Load backup file…".
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

	// Shared by the two paths of "Load backup file…" (the native Electron API
	// of pickFileNative() and the HTML <input> fallback of pickFile()) — once
	// the file's text is obtained, the processing (parsing, confirmation,
	// restore) is identical whatever the mechanism that made it possible to
	// get it.
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
					this.refreshContent();
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

	/* ---------------------------------------------------------------------- */
	/*  Two ways to draw the same sections                                    */
	/* ---------------------------------------------------------------------- */

	// Obsidian 1.13+ calls this (and then never display()): the rows are indexed by the settings search and drawn
	// by Obsidian itself. Called at every update() and once when the tab is added, so it only builds descriptions
	// and closures — nothing that reads the data at call time.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.sections().map((section): SettingDefinitionItem => ({
			type: "group",
			heading: section.heading,
			visible: section.visible,
			items: section.rows.map((row): SettingDefinition => {
				const def = { name: row.name, desc: row.desc, aliases: row.aliases, searchable: row.searchable, visible: row.visible };
				return row.render ? { ...def, render: row.render } : def;
			}),
		}));
	}

	// Obsidian < 1.13 (our minAppVersion is 1.8.7) only knows display(): the same sections drawn by hand, one
	// Setting per row. `this.display()` itself is deprecated from 1.13 and the plugin never calls it (the lint
	// flags every call): the redraws go through refreshContent().
	display(): void {
		this.renderLegacy();
	}

	private renderLegacy(): void {
		const { containerEl } = this;
		const scrollTop = containerEl.scrollTop;
		this.hide();
		containerEl.empty();
		for (const section of this.sections()) {
			if (section.visible && !section.visible()) continue;
			if (section.heading) new Setting(containerEl).setName(section.heading).setHeading();
			const box = section.legacyBox ? containerEl.createDiv({ cls: section.legacyBox }) : containerEl;
			for (const row of section.rows) {
				if (row.visible && !row.visible()) continue;
				const setting = new Setting(box).setName(row.name);
				if (row.desc) setting.setDesc(row.desc);
				const cleanup = row.render?.(setting);
				if (cleanup) this.legacyCleanups.push(cleanup);
			}
		}
		// A redraw (a dropdown that shows or hides a section) must not throw the user back to the top.
		containerEl.scrollTop = scrollTop;
	}

	hide(): void {
		for (const cleanup of this.legacyCleanups.splice(0)) cleanup();
	}

	// Redraws after a click that changed what a row SAYS (a date, a count) or the value its control shows (a
	// color back to its default). `update()` and `refreshDomState()` exist from Obsidian 1.13 only, hence the
	// local types: the guard is the point, there is nothing newer to ask the compiler about.
	private refreshContent(): void {
		const tab = this as unknown as { update?: () => void };
		if (typeof tab.update === "function") tab.update();
		else this.renderLegacy();
	}

	// Redraws after a change that only shows or hides rows (the `visible` predicates): cheap on 1.13+.
	private refreshVisibility(): void {
		const tab = this as unknown as { refreshDomState?: () => void };
		if (typeof tab.refreshDomState === "function") tab.refreshDomState();
		else this.renderLegacy();
	}

	private sections(): Section[] {
		const plugin = this.plugin;
		return [
			{
				rows: [
					{
						name: "Collection size",
						desc: "How many unique printings are tracked.",
						aliases: ["cards", "count"],
						render: (setting) => {
							setting.setDesc(`You currently have ${plugin.settings.collection.length} unique printings tracked.`);
						},
					},
				],
			},
			{
				heading: "Interface",
				rows: [
					{
						name: "Accent color",
						desc: 'Used for highlighted buttons and elements throughout the plugin (e.g. "+ Add cards").',
						aliases: ["colour", "theme", "purple"],
						render: (setting) => {
							setting
								.addColorPicker((picker) =>
									picker.setValue(plugin.settings.accentColor || "#7c3aed").onChange(async (value) => {
										plugin.settings.accentColor = value;
										await plugin.saveSettings();
										plugin.refreshAccentColor();
									})
								)
								.addExtraButton((btn) =>
									btn
										.setIcon("rotate-ccw")
										.setTooltip("Reset to theme color")
										.onClick(async () => {
											plugin.settings.accentColor = "";
											await plugin.saveSettings();
											plugin.refreshAccentColor();
											this.refreshContent();
										})
								);
						},
					},
					{
						name: "Custom ribbon icon",
						desc: "Load your own .svg file to replace the ribbon icon used to open the collection.",
						aliases: ["svg", "sidebar", "icon"],
						render: (setting) => {
							setting
								.addButton((btn) =>
									btn.setButtonText("Load .svg file…").onClick(() => {
										this.pickFile(".svg,image/svg+xml", async (file) => {
											const text = await file.text();
											if (!/<svg[\s>]/i.test(text)) {
												new Notice("This file doesn't look like a valid SVG.");
												return;
											}
											plugin.settings.customIconSvg = text.trim();
											await plugin.saveSettings();
											plugin.refreshCollectionRibbonIcon();
											new Notice(`Icon loaded from ${file.name}.`);
										});
									})
								)
								.addExtraButton((btn) =>
									btn
										.setIcon("rotate-ccw")
										.setTooltip("Reset to default icon")
										.onClick(async () => {
											plugin.settings.customIconSvg = "";
											await plugin.saveSettings();
											plugin.refreshCollectionRibbonIcon();
											new Notice("Ribbon icon reset to default.");
										})
								);
						},
					},
					{
						name: "Ribbon icon color",
						desc: "Only applies when a custom SVG icon is loaded above.",
						aliases: ["colour"],
						render: (setting) => {
							setting
								.addColorPicker((picker) =>
									picker.setValue(plugin.settings.customIconColor || "#8888ff").onChange(async (value) => {
										plugin.settings.customIconColor = value;
										await plugin.saveSettings();
										plugin.refreshCollectionRibbonIcon();
									})
								)
								.addExtraButton((btn) =>
									btn
										.setIcon("rotate-ccw")
										.setTooltip("Reset to theme color")
										.onClick(async () => {
											plugin.settings.customIconColor = "";
											await plugin.saveSettings();
											plugin.refreshCollectionRibbonIcon();
											this.refreshContent();
										})
								);
						},
					},
					// Phone only (see the description) — the plugin becomes a floating pill at the bottom
					// (src/view/mobile-bars.ts, styles.css) and hides by default Obsidian's floating bar and its header
					// to leave more room for the content. This setting replaces, since 2026-09-27, the old "eye" button
					// of the rail (ephemeral reveal for the duration of the visit) — the pill has no room for a 6th item
					// of that kind, and a preference you don't change on every visit is in any case better placed here
					// than in a constantly visible button.
					{
						name: "Hide Obsidian's mobile bars",
						desc: "On a phone, hide Obsidian's own floating navigation bar and header while this plugin is open, to free up space. Turn this off if you need Obsidian's tab switcher or left-drawer button while browsing the collection.",
						aliases: ["phone", "navbar", "navigation", "header"],
						render: (setting) => {
							setting.addToggle((toggle) =>
								toggle.setValue(plugin.settings.hideObsidianMobileBars).onChange(async (value) => {
									plugin.settings.hideObsidianMobileBars = value;
									await plugin.saveSettings();
									plugin.refreshMobileBars();
								})
							);
						},
					},
				],
			},
			{
				heading: "Performance",
				rows: [
					{
						name: "Suggestion counts",
						desc: 'When searching, show how many cards match each suggestion (e.g. "Blue (12)") before you pick it. Recalculated on every keystroke, so it\'s capped by list size to stay fast — raise this if you have a large collection and don\'t notice any slowdown.',
						aliases: ["search", "speed", "slow"],
						render: (setting) => {
							setting.addDropdown((dropdown) =>
								dropdown
									.addOptions({
										"0": "Off",
										"2000": "Up to 2,000 cards",
										"5000": "Up to 5,000 cards (default)",
										"10000": "Up to 10,000 cards",
										"25000": "Up to 25,000 cards",
										"-1": "Always (any size)",
									})
									.setValue(String(plugin.settings.suggestionCountThreshold))
									.onChange(async (value) => {
										plugin.settings.suggestionCountThreshold = Number(value);
										await plugin.saveSettings();
									})
							);
						},
					},
				],
			},
			{
				heading: "Price",
				rows: [
					{
						name: "Price currency",
						desc: "Scryfall only provides one price per currency/finish (sourced from TCGPlayer for USD and Cardmarket for EUR) — not the full breakdown some price-tracking apps offer (TCGPlayer Low/Mid/High, buylist prices, etc.). Foil cards correctly use the foil-specific price.",
						aliases: ["usd", "eur", "dollar", "euro", "money"],
						render: (setting) => {
							setting.addDropdown((dropdown) =>
								dropdown
									.addOptions({
										usd: CURRENCY_LABELS.usd.name,
										eur: CURRENCY_LABELS.eur.name,
									})
									.setValue(plugin.settings.priceCurrency)
									.onChange(async (value) => {
										plugin.settings.priceCurrency = value as PriceCurrency;
										await plugin.saveSettings();
										plugin.refreshOpenViews();
									})
							);
						},
					},
					{
						name: "Price refresh",
						desc: PRICE_REFRESH_DESC,
						aliases: ["update", "scryfall", "interval"],
						render: (setting) => {
							const lastRefresh = plugin.settings.lastPriceRefresh;
							const lastRefreshText = lastRefresh ? `Last refreshed: ${new Date(lastRefresh).toLocaleString()}.` : "Never refreshed yet.";
							setting.setDesc(`${PRICE_REFRESH_DESC} ${lastRefreshText}`);
							setting
								.addDropdown((dropdown) =>
									dropdown
										.addOptions({
											"0": "Off",
											"24": "Every 24 hours (default)",
											"48": "Every 48 hours",
											"168": "Every week",
											"720": "Every month",
										})
										.setValue(String(plugin.settings.priceRefreshIntervalHours))
										.onChange(async (value) => {
											plugin.settings.priceRefreshIntervalHours = Number(value);
											await plugin.saveSettings();
										})
								)
								.addExtraButton((btn) =>
									btn
										.setIcon("refresh-cw")
										.setTooltip("Refresh prices now")
										.onClick(async () => {
											const notice = new Notice("Refreshing prices…", 0);
											try {
												const result = await plugin.refreshAllPrices((msg) => notice.setMessage(msg), { respectCooldown: true });
												notice.hide();
												if (result.skipped) {
													const minutes = Math.ceil((result.retryInMs ?? 0) / 60000);
													new Notice(`Prices were just refreshed — try again in ~${minutes} min.`);
													return;
												}
												new Notice(`Prices refreshed — ${result.updated} card(s) changed.`);
												// refreshAllPrices() doesn't re-render the open views (only
												// maybeAutoRefreshPrices() does, afterwards): the old "Refresh Prices"
												// button of the side menu took care of it itself, removed on 2026-09-26 —
												// this button is now the only manual trigger, so without this call the
												// view behind the settings window would keep its old prices until its next
												// render.
												plugin.refreshOpenViews();
												this.refreshContent();
											} catch (e) {
												notice.hide();
												new Notice(`Error while refreshing prices: ${(e as Error).message}`);
											}
										})
								);
						},
					},
				],
			},
			{
				heading: "External resources",
				rows: [
					{
						name: "",
						desc: "This plugin talks to a few free, public data sources to fetch card data and prices — none require an account, except cardbase.dev's optional key below (unlocks a longer price history).",
						searchable: false,
						render: () => {},
					},
					{
						name: "Scryfall",
						desc: "The backbone of this plugin — card search, images, prices (USD/EUR), format legalities, and rules text. Free, no API key needed.",
						aliases: ["data", "network", "privacy"],
					},
					{
						name: "Card Kingdom",
						desc: 'Provides the Card Kingdom retail price shown in "Store prices". Free, public pricelist, no account needed.',
						aliases: ["data", "network", "privacy", "store"],
					},
					{
						name: "Mana Pool",
						desc: 'Provides the Mana Pool retail price shown in "Store prices". Free, public pricelist, no account needed.',
						aliases: ["data", "network", "privacy", "store"],
					},
					{
						name: "Cardbase.dev API key",
						desc: 'Optional. Powers the "Price history" chart in card detail (Card Kingdom + TCGplayer, sourced from cardbase.dev — Mana Pool isn\'t covered there). Without a key you still get 30 days of history; a free key from cardbase.dev\'s dashboard unlocks 365 days.',
						aliases: ["cardbase", "token", "history", "chart", "network", "privacy"],
						render: (setting) => this.renderCardbaseKey(setting),
					},
					{
						name: "Frankfurter.dev",
						desc: 'Provides the USD/EUR exchange rate used by the "Price history" chart to convert a vendor\'s native currency to your chosen display currency. Free, no account needed.',
						aliases: ["exchange", "rate", "data", "network", "privacy"],
					},
				],
			},
			{
				heading: "Backup",
				rows: [
					// Goes through ui/file-export.ts (and not view.ts/downloadTextFile):
					// setting-tab.ts deliberately stays isolated from view.ts (see its own
					// note in "Files", CLAUDE.md — "zero external consumers besides
					// onload()"), whereas that module has no dependency on view.ts. On mobile
					// a <a download> is silently inoperative — the file is then written into
					// the vault and shared natively (see saveExportedFile).
					{
						name: "Export backup",
						desc: "Download a JSON file with your entire collection, decks, wantlists, and settings. Your cardbase.dev API key (above) is deliberately left out of this file — re-enter it after a restore if needed.",
						aliases: ["save", "json", "download"],
						render: (setting) => {
							setting.addButton((btn) =>
								btn.setButtonText("Export backup").onClick(() => {
									void saveExportedFile(
										this.app,
										plugin.exportBackup(),
										`mtg-collection-backup-${new Date().toISOString().slice(0, 10)}.json`,
										"application/json"
									);
									new Notice(
										`Backup exported — ${plugin.settings.collection.length} card(s), ${plugin.settings.decks.length} deck(s), ${plugin.settings.wantlist.length} wantlist item(s).`
									);
								})
							);
						},
					},
					{
						name: "Restore backup",
						desc: "Restore a backup, either one of the backups saved in your backup folder (see below) or a backup file from anywhere else. This completely replaces your current collection, decks, wantlists, and settings — you'll be asked to confirm the details before anything changes.",
						aliases: ["import", "load", "json"],
						render: (setting) => {
							setting
								.addButton((btn) =>
									btn.setButtonText("Choose a saved backup…").onClick(() => {
										const folder = backupFolderPath(plugin);
										new RestoreBackupModal(this.app, folder, listBackups(plugin.listBackupFiles()), (backup) => {
											void (async () => {
												try {
													await this.handleBackupFileText(await plugin.readBackupFile(backup.path));
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
										// A file from elsewhere: the system file picker (see the comment at the top of this class).
										this.pickFile(".json,application/json", async (file) => {
											await this.handleBackupFileText(await file.text());
										});
									})
								);
						},
					},
				],
			},
			// Automatic backups (2026-09-02) — same dropdown/last-run/"now" button trio as "Price refresh"
			// higher up in this file, same settings scheme (0 = disabled). Writes the same content as "Export
			// backup" above (see MTGCollectionPlugin.runAutoBackup), but into a vault folder rather than
			// downloaded by hand. The 3 settings form a single logical subset, drawn as ONE card (explicitly
			// requested: "bring together the sub-section… into a single subset"): on 1.13+ a group is a card, on
			// the old path the rows are wrapped in .mtg-settings-group (styles.css).
			{
				legacyBox: "mtg-settings-group",
				rows: [
					{
						name: "Automatic backups",
						desc: AUTO_BACKUP_DESC,
						aliases: ["schedule", "daily", "weekly", "monthly"],
						render: (setting) => {
							const lastAutoBackup = plugin.settings.lastAutoBackup;
							const lastAutoBackupText = lastAutoBackup
								? `Last backup: ${new Date(lastAutoBackup).toLocaleString()}.`
								: "No automatic backup yet.";
							setting.setDesc(`${AUTO_BACKUP_DESC} ${lastAutoBackupText}`);
							setting
								.addDropdown((dropdown) =>
									dropdown
										.addOptions({
											"0": "Off",
											"24": "Daily",
											"168": "Weekly (default)",
											"720": "Monthly",
										})
										.setValue(String(plugin.settings.autoBackupIntervalHours))
										.onChange(async (value) => {
											plugin.settings.autoBackupIntervalHours = Number(value);
											await plugin.saveSettings();
										})
								)
								.addExtraButton((btn) =>
									btn
										.setIcon("save")
										.setTooltip("Back up now")
										.onClick(async () => {
											const result = await plugin.runAutoBackup();
											if ("error" in result) {
												new Notice(`Backup failed: ${result.error}`);
												return;
											}
											new Notice(`Backup saved to ${result.path}.`);
											this.refreshContent();
										})
								);
						},
					},
					{
						name: "Backup folder",
						desc: "Vault-relative folder for automatic backups — created automatically if it doesn't exist yet. Click the field to browse existing folders, or type a new one.",
						aliases: ["directory", "path"],
						render: (setting) => {
							setting.addText((text) => {
								text.setPlaceholder("MTG Backups")
									.setValue(plugin.settings.autoBackupFolder)
									.onChange(async (value) => {
										plugin.settings.autoBackupFolder = value.trim() || "MTG Backups";
										await plugin.saveSettings();
									});
								// See FolderSuggest at the top of this file — choosing a suggestion calls
								// AbstractInputSuggest.setValue() internally, which does update
								// text.inputEl.value, but does NOT fire the DOM "input" event that
								// TextComponent.onChange listens to (a direct JS assignment of .value
								// never emits this event): without this separate .onSelect(), choosing a
								// suggestion would change the display without ever saving the new setting.
								new FolderSuggest(this.app, text.inputEl).onSelect(async (folder) => {
									text.setValue(folder.path);
									plugin.settings.autoBackupFolder = folder.path;
									await plugin.saveSettings();
								});
							});
						},
					},
					{
						name: "Backups to keep",
						desc: "Older automatic backups beyond this count are moved to trash (never a manual export you place in the same folder).",
						aliases: ["retention", "delete", "old"],
						render: (setting) => {
							setting.addDropdown((dropdown) =>
								dropdown
									.addOptions({
										"3": "3",
										"7": "7 (default)",
										"10": "10",
										"20": "20",
									})
									.setValue(String(plugin.settings.autoBackupKeepCount))
									.onChange(async (value) => {
										plugin.settings.autoBackupKeepCount = Number(value);
										await plugin.saveSettings();
									})
							);
						},
					},
				],
			},
			...this.dataStorageSections(),
			{
				heading: "Clear data",
				rows: [
					{
						name: "Clear all data",
						// Reported bug: the old code only emptied settings.collection (the cards
						// themselves), leaving behind the "My Collection" lists (settings.lists)
						// now empty but still present. Fixed by emptying both together. Widened
						// the same day to decks/wantlist/wantlists, explicitly requested — see the
						// click handler further down.
						desc: "Delete every tracked card, deck, and wantlist item — along with the (now-empty) lists/wantlists they belonged to. This cannot be undone.",
						aliases: ["delete", "reset", "erase", "wipe"],
						render: (setting) => {
							setting.addButton((btn) => {
								btn.setButtonText("Clear");
								// The red button. btn.setWarning() is deprecated: from Obsidian 1.13 it is setDestructive() + setCta()
								// (a filled red button, measured in 1.13.8), before that the plain "mod-warning" class. setDestructive()
								// does not exist below 1.13, hence the check on the method rather than on a version number.
								const redButton = btn as unknown as { setDestructive?: () => unknown };
								if (typeof redButton.setDestructive === "function") {
									redButton.setDestructive();
									btn.setCta();
								} else {
									btn.buttonEl.addClass("mod-warning");
								}
								btn.onClick(() => {
									// Two bugs/requests reported together: (1) no confirmation before an
									// irreversible action — fixed via ClearAllDataConfirmModal, same template
									// as RestoreBackupConfirmModal; (2) the already open view never updated
									// after the click (the plugin did empty the data, but nothing refreshed
									// the view itself — redrawing THIS settings panel does not touch it) —
									// fixed by calling refreshOpenViews() (the same helper already used by the
									// display currency change, see plugin.ts) right after the save.
									new ClearAllDataConfirmModal(
										this.app,
										plugin.settings.collection.length,
										plugin.settings.lists.length,
										plugin.settings.decks.length,
										plugin.settings.wantlist.length,
										plugin.settings.wantlists.length,
										async () => {
											plugin.settings.collection = [];
											plugin.settings.lists = [];
											plugin.settings.decks = [];
											plugin.settings.wantlist = [];
											plugin.settings.wantlists = [];
											await plugin.saveSettings();
											plugin.refreshOpenViews();
											new Notice("All data cleared.");
											this.refreshContent();
										}
									).open();
								});
							});
						},
					},
				],
			},
		];
	}

	// The "Cardbase.dev API key" row. The field is hidden by default (type="password"), with an "eye" button, and
	// the two are welded back into a single visual control (shared border, rounded corner only on the outer edges)
	// — literally "stuck to the field", rather than the riskier attempt of overlaying the icon INSIDE the field
	// itself (which assumes a precise padding/height of the input, not guaranteed stable from one Obsidian
	// community theme to another). Saving remains automatic on every keystroke (onChange, same convention as all
	// the other settings of this plugin) — "Validate key" only serves to check/display a status, not to save
	// (already done). The status line lives in the row's description, under the text.
	private renderCardbaseKey(setting: Setting): void {
		const statusEl = setting.descEl.createDiv({ cls: "mtg-cardbase-status" });
		let apiKeyInputEl!: HTMLInputElement;
		let eyeBtnEl!: HTMLElement;

		setting
			.addText((text) => {
				apiKeyInputEl = text.inputEl;
				apiKeyInputEl.type = "password";
				text
					.setPlaceholder("cbdev_…")
					.setValue(this.plugin.settings.cardbaseApiKey)
					.onChange(async (value) => {
						this.plugin.settings.cardbaseApiKey = value.trim();
						await this.plugin.saveSettings();
						// The key has changed since the last validation — a status left displayed
						// would become misleading (green whereas the displayed key is no longer
						// the one that was verified).
						statusEl.setText("");
						statusEl.className = "mtg-cardbase-status";
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
					statusEl.className = "mtg-cardbase-status";
					if (!key) {
						statusEl.setText("No key set — using anonymous access (30 days of history).");
						return;
					}
					statusEl.setText("Validating…");
					// No dedicated "check my key" endpoint on cardbase's side (see
					// testCardbaseConnection) — the signal used is precisely the bug fixed
					// higher up: a key that doesn't actually raise the tier fails with a
					// precise 400 as soon as more than 30 days are requested.
					const result = await testCardbaseConnection(key);
					if (result === "ok") {
						statusEl.setText("✓ Connected — 365 days of history unlocked.");
						statusEl.addClass("is-success");
					} else if (result === "rejected") {
						statusEl.setText(
							"⚠ Key not recognized by cardbase.dev — falling back to 30-day anonymous access. Double-check it was copied correctly."
						);
						statusEl.addClass("is-error");
					} else {
						statusEl.setText("✕ Could not reach cardbase.dev — check your internet connection and try again.");
						statusEl.addClass("is-error");
					}
				})
			);

		// apiKeyInputEl/eyeBtnEl already exist in the DOM (added by .addText/.addExtraButton just above, in
		// .setting-item-control) — we simply move them into a common wrapper, recreating nothing.
		const inputGroup = createDiv();
		inputGroup.className = "mtg-cardbase-key-input-group";
		apiKeyInputEl.parentElement?.insertBefore(inputGroup, apiKeyInputEl);
		inputGroup.appendChild(apiKeyInputEl);
		inputGroup.appendChild(eyeBtnEl);
	}

	private dataStorageSections(): Section[] {
		const plugin = this.plugin;

		const showStatus = () => {
			const statusEl = this.githubStatusEl;
			if (!statusEl) return;
			statusEl.setText(githubStatusLine(plugin));
			statusEl.className = "mtg-cardbase-status mtg-status-multiline" + (plugin.github.status.state === "error" ? " is-error" : "");
		};
		const applyGithub = async () => {
			await plugin.saveSettings();
			plugin.resetGithubSync();
			showStatus();
		};

		const githubText = (
			name: string,
			desc: string,
			// A function: the Token placeholder depends on whether a token is saved NOW, and the definitions are not rebuilt when the tab opens.
			placeholder: () => string,
			read: () => string,
			write: (value: string) => void | Promise<void>,
			aliases: string[],
			password = false
		): Row => ({
			name,
			desc,
			aliases: ["github", ...aliases],
			// A hidden row can't be shown by the search: while GitHub is not chosen, "Where is your collection kept?" is the way in.
			searchable: () => plugin.settings.githubSyncEnabled,
			render: (setting) => {
				setting.addText((text) => {
					if (password) text.inputEl.type = "password";
					text.setPlaceholder(placeholder()).setValue(password ? "" : read());
					let pending = "";
					text.onChange((value) => {
						pending = value;
					});
					const commitValue = async () => {
						const value = password ? pending : pending || text.getValue();
						// A token field emptied by mistake must not erase the saved token.
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
			},
		});

		return [
			{
				heading: "Data storage",
				rows: [
					{
						name: "",
						desc: "Where your collection is kept. These settings, the GitHub token included, are specific to this device.",
						searchable: false,
						render: () => {},
					},
					{
						name: "Where is your collection kept?",
						desc: "On this device: in a folder of your vault, which you can sync yourself (Syncthing, iCloud…). On GitHub: also in a private repository, synced automatically — this device keeps a local copy so it works offline.",
						aliases: ["github", "sync", "storage", "device", "repository"],
						render: (setting) => {
							setting.addDropdown((dropdown) =>
								dropdown
									.addOptions({ device: "On this device", github: "On GitHub (private repository)" })
									.setValue(plugin.settings.githubSyncEnabled ? "github" : "device")
									.onChange(async (value) => {
										plugin.settings.githubSyncEnabled = value === "github";
										this.refreshVisibility();
										await applyGithub();
									})
							);
						},
					},
					{
						name: "Data folder",
						desc: "Folder of your vault that holds the data file. Empty = the plugin's own hidden folder (default). Pick a visible folder to sync it yourself — and pick the same folder on every device you sync. Changing it copies your data there (merging with a file already in it) and leaves the previous file where it was.",
						aliases: ["sync", "syncthing", "icloud", "storage", "data.json"],
						render: (setting) => {
							setting.addText((text) => {
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
						},
					},
				],
			},
			{
				visible: () => plugin.settings.githubSyncEnabled,
				rows: [
					githubText(
						"Repository",
						"A PRIVATE repository created for this, as owner/name. Not this plugin's own repository: every push there publishes a release.",
						() => "owner/mtg-data",
						() => plugin.settings.githubRepo,
						(v) => void (plugin.settings.githubRepo = v.trim()),
						["private", "owner"]
					),
					githubText(
						"Branch",
						"The repository must already have it (create the repository with a README).",
						() => "main",
						() => plugin.settings.githubBranch,
						(v) => void (plugin.settings.githubBranch = v.trim() || "main"),
						["git"]
					),
					githubText(
						"Folder in the repository",
						"Where the data files go inside the repository (one small file per list, deck and wantlist).",
						() => "mtg-collection",
						() => plugin.settings.githubPath,
						(v) => void (plugin.settings.githubPath = v.trim()),
						["path", "directory"]
					),
					githubText(
						"Token",
						'A fine-grained personal access token limited to that repository, with "Contents: Read and write". Kept in Obsidian\'s secret storage on this device; never written to your data or backups.',
						() => (plugin.getGithubToken() ? "Saved on this device — paste another to replace it" : "github_pat_…"),
						() => "",
						(v) => plugin.setGithubToken(v),
						["pat", "password", "secret", "access"],
						true
					),
					{
						// The state of the sync is shown in the row's description and changes by itself (polling,
						// upload): refreshed every 2 s for as long as the row exists (the cleanup stops the timer).
						name: "Connection",
						aliases: ["github", "status", "test", "sync now"],
						searchable: false,
						render: (setting) => {
							const statusEl = setting.descEl.createDiv({ cls: "mtg-cardbase-status mtg-status-multiline" });
							this.githubStatusEl = statusEl;
							showStatus();
							setting
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
							const timer = window.setInterval(() => {
								if (plugin.settings.githubSyncEnabled && plugin.github.status.state !== "syncing") showStatus();
							}, 2000);
							return () => {
								window.clearInterval(timer);
								if (this.githubStatusEl === statusEl) this.githubStatusEl = null;
							};
						},
					},
				],
			},
		];
	}
}
