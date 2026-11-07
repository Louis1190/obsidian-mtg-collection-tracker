// NOT a test file. The `obsidian` npm package ships types only, so the name cannot be resolved at all. Tests under Node
// mock it with vi.mock("obsidian", factory), which is enough there; a test that runs under jsdom is transformed by Vite as
// browser code, and Vite refuses an import it cannot resolve before any mock gets a say. vitest.config.ts therefore points
// the name here: a test that needs a real value still mocks it (the mock takes the place of this module).
export {};
