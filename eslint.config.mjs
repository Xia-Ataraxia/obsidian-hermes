import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

/** The same rules the Obsidian Community directory scans a release with. */
export default defineConfig([
  { ignores: ["main.js", "tests", "*.mjs"] },
  ...obsidianmd.configs.recommended,
  { languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["eslint.config.*"] } } } },
]);
