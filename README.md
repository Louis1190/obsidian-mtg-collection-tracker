# MTG Collection Tracker

An [Obsidian](https://obsidian.md) plugin to keep track of a **physical Magic: The Gathering collection**, plus your
decks and wantlists, with card data and prices from [Scryfall](https://scryfall.com) and a few price sources next to it.

Everything is stored in your own files, on your own devices. There is no account and no server run by this plugin.

## What you can do

- **Home**, a dashboard: what you own, recently added cards, your most valuable cards, a colour and rarity breakdown,
  decks that still need cards, backup status, and market movers.
- **My Collection**: any number of lists (plus an *Inbox* for cards you have not sorted yet). Each card has a
  finish, a condition, a language, an optional grading (PSA / BGS / CGC / other) and an optional custom price.
- **My Decks**: mainboard, sideboard and maybeboard, a Commander slot, a *Stacks* view that fans the cards of each
  group, grouping by type or by function (ramp, removal, draw…), and deck statistics (mana curve, colours, card types).
- **My Wantlists**: the cards you are looking for, with a *Mark as acquired* action that moves a card into your collection.
- **Card details** for every card: its text, a price history chart, the formats it is legal in, prices from several
  stores, and the other lists and decks that hold a copy.
- **Search** that understands what you type (colours, rarities, types, sets, artists, `legal:modern`, `border:showcase`,
  `oracle:"draw a card"`, `#235`…). The *Add cards* window searches all of Scryfall; each list has the same search over what it holds.
- **Copy, move, merge**: move or copy cards between lists, decks and wantlists, merge lists, merge duplicate cards.
- **Import and export**: CSV and plain-text decklists (Moxfield, Archidekt, MTGO, Arena), export to CSV or text, or to
  the clipboard, one ZIP for several lists at once.
- **Backups** you can restore, taken automatically into a vault folder, and **sync between devices** (see below).
- **Phones and tablets**: the layout adapts to the width of the pane, with a bottom navigation bar on a phone.

## Installation

Requires **Obsidian 1.8.7 or later**, on desktop, iPhone/iPad or Android.

### From the community plugins

Not listed there yet. Once it is: *Settings → Community plugins → Browse*, search for **MTG Collection Tracker**,
install, enable.

### Until then

Download `main.js`, `manifest.json` and `styles.css` from the latest
[release](https://github.com/Louis1190/obsidian-mtg-collection-tracker/releases), put the three files in
`<your vault>/.obsidian/plugins/mtg-collection-tracker/`, then enable the plugin in *Settings → Community plugins*.
You can also let [BRAT](https://github.com/TfTHacker/obsidian42-brat) install and update it from
`Louis1190/obsidian-mtg-collection-tracker`.

## Getting started

1. Click the **layers** icon in the ribbon, or run the command **Open MTG collection view**.
2. In *My Collection*, create a list and use **+ Add cards**: search, then add. Or import a CSV / decklist from the `…` menu of a list.
3. Open any card to set its finish, condition, language, grading, and to see its prices.

CSV import reads a header row; it recognises `Quantity`, `Name`, `Set code`, `Collector number`, `Finish`, `Condition`,
`Language`, `Scryfall ID`, the grading columns and `Custom price`, so the plugin's own CSV export can be imported back.
Cards that Scryfall cannot resolve are reported, not silently dropped.

## Prices

| Where it shows | Source |
| --- | --- |
| Card value, TCGplayer column | Scryfall's own prices |
| Card Kingdom column | Card Kingdom's public pricelist |
| Mana Pool column | Mana Pool's public price list (computers only, see below) |
| Cardmarket column, price history, market movers | [cardbase.dev](https://cardbase.dev) (an API key is optional and gives a longer history) |
| Showing one currency everywhere | [frankfurter.dev](https://frankfurter.dev) USD/EUR rate |

The price saved with each of your cards (it feeds the values you see) comes from Scryfall and refreshes on its own at the
interval you choose (*Settings → Price*, every 24 hours by default). The store columns of a card are fetched when you
open the card. Prices are indications taken from third parties, not offers to buy or sell, and can be out of date.

Card Kingdom and Mana Pool publish their whole catalogue as one file (65 MB and 49 MB once unpacked). A computer reads it whole. On a
phone or tablet, Card Kingdom is read as a stream so that it never sits in memory, and the Mana Pool column says *Not on mobile*: its
server does not allow that kind of reading, and loading the file the usual way ran Obsidian out of memory.

## Your data

- The collection lives in one file, `data.json`, in the plugin's folder, **or** in a vault folder you choose
  (*Settings → Data storage*). That is how you sync it with Syncthing, iCloud or any other tool you already use for the vault.
- **GitHub storage (optional)**: the data can be kept in a folder of a **private** GitHub repository of your own, with a copy
  on each device so it works offline. You create the repository and a fine-grained access token limited to it
  (*Contents: Read and write*); the token stays in Obsidian's secret storage on the device and is never written to your
  data or your backups. Several devices can edit at the same time: changes are merged, and a card is never deleted by a
  device that has simply not seen it yet.
- Display choices (sort order, view mode, the collapsed navigation…) stay on the device and are not synced.
- **Backups**: *Settings → Backup* exports a complete JSON snapshot, and can write one automatically into a vault folder
  (`MTG Backups` by default, the last 7 kept). To restore, *Choose a saved backup* lists the backups of that folder (the
  same on every device), and *Load backup file* takes a backup from anywhere else. You always see what a backup contains
  before anything is replaced.
- Small caches (set icons, rules text, format legalities, set lists) are stored in the plugin's folder and can be deleted at any time.

## Network use and privacy

The plugin talks to the internet to do its job, and **only** to these services. It has no analytics and no telemetry,
and it never sends your collection anywhere except to the GitHub repository you configure yourself.

| Service | What for | When |
| --- | --- | --- |
| `api.scryfall.com`, and the images served by `*.scryfall.io` | Card search, card data, prices, format legalities, set and mana symbols, card images | When you search, open or import cards; in the background to keep the prices and legalities of your cards up to date |
| `api.cardkingdom.com` | Card Kingdom prices | The first time a card is opened in a session (read as a stream on a phone or tablet, to spare its memory) |
| `manapool.com` | Mana Pool prices | The first time a card is opened in a session, **computers only** |
| `api.cardbase.dev` | Price history, Cardmarket prices, market movers | When a card is opened or Home is shown |
| `api.frankfurter.dev` | USD/EUR exchange rate | Once per session, when a price needs converting |
| `api.github.com` | Syncing your data with **your own** private repository | **Only if you turn GitHub storage on** |

Requests to Scryfall are rate-limited as their guidelines ask, and carry a `User-Agent` that names this plugin.

## Files outside your vault

Everything the plugin keeps lives inside your vault: its own folder (`data.json`, caches, safety copies), the data folder you
may choose, the backup folder and the export folder. The exceptions are a few per-device preferences and the GitHub token,
which Obsidian keeps in its own storage on the device. The plugin reaches outside the vault in these cases only, each one
started by an action of yours:

- **Opening a file you pick.** *Load backup file* (settings), *Import* (CSV or text decklist) and *Load .svg file* use the
  system's file chooser; the plugin reads that one file and nothing else, and writes nothing.
- **Saving an export on desktop.** Exports (CSV, text, ZIP, backup) go through the browser's *Save as* dialog: you choose where the
  file goes.
- **Saving an export on a phone or tablet.** The export window writes into a vault folder (`MTG Exports` by default), and its
  **Share…** button hands that file to the system's share sheet or default app. On **Android**, **Device folder…** lets you pick
  a folder of the device with Obsidian's own folder picker and writes the file there; it never overwrites an existing file.

## Building from source

```bash
npm ci
npm test            # unit tests (Vitest)
npm run build       # type check, then bundle to main.js
```

`styles.css` and `manifest.json` are used as they are.

## Credits and disclaimer

- Card data, images and symbols come from [Scryfall](https://scryfall.com). This plugin is not made by or affiliated with Scryfall.
- Magic: The Gathering is a trademark of Wizards of the Coast LLC. This plugin is unofficial Fan Content permitted under the
  [Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). It is not approved or endorsed by Wizards.
  Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
- Card Kingdom, Mana Pool, TCGplayer, Cardmarket, PSA, BGS and CGC names and logos belong to their owners and are used only
  to say where a price or a grade comes from. This plugin is not affiliated with any of them.
- The small language flags are flat icons from a royalty-free icon set.

## License

[MIT](LICENSE) © 2026 Louis
