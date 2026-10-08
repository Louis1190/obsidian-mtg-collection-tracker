// Obsidian runs the plugin in a window: `window` exists. The tests run under Node, where it doesn't exist — yet
// the code calls window.setTimeout / window.requestAnimationFrame (the plugin directory's prefer-window-timers
// rule: a bare `setTimeout` is not suitable for a detached window). `window` IS `globalThis`: Vitest's fake
// timers, which replace globalThis.setTimeout, therefore also apply to window.setTimeout. Simple assignment and
// not vi.stubGlobal: a test that calls vi.unstubAllGlobals() (file-export.test.ts) would remove the stub and
// break all the following ones. The jsdom environment (svg-markup.test.ts) already has its own window.
const g = globalThis as { window?: unknown };
if (typeof g.window === "undefined") g.window = globalThis;
