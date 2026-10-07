// Obsidian exécute le plug-in dans une fenêtre : `window` existe. Les tests tournent sous Node, où il n'existe pas — or le code
// appelle window.setTimeout / window.requestAnimationFrame (règle prefer-window-timers du répertoire des plug-ins : un `setTimeout`
// nu ne convient pas à une fenêtre détachée). `window` EST `globalThis` : les faux minuteurs de Vitest, qui remplacent
// globalThis.setTimeout, s'appliquent donc aussi à window.setTimeout. Affectation simple et non vi.stubGlobal : un test qui
// appelle vi.unstubAllGlobals() (file-export.test.ts) retirerait le stub et casserait tous ceux d'après. L'environnement jsdom
// (svg-markup.test.ts) a déjà sa propre fenêtre.
const g = globalThis as { window?: unknown };
if (typeof g.window === "undefined") g.window = globalThis;
