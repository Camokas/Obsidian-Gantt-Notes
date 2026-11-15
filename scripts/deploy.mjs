// Copies the built plugin into a vault: npm run deploy -- "D:\\Vaults\\MyVault"
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const vault = process.argv[2] || process.env.OBSIDIAN_VAULT;
if (!vault) {
  console.error('Usage: npm run deploy -- "<path to vault>"  (or set OBSIDIAN_VAULT)');
  process.exit(1);
}
if (!existsSync(join(vault, ".obsidian"))) {
  console.error(`Not an Obsidian vault (no .obsidian folder): ${vault}`);
  process.exit(1);
}
const dir = join(vault, ".obsidian", "plugins", "gantt-notes");
mkdirSync(dir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  copyFileSync(f, join(dir, f));
}
console.log(`Deployed to ${dir}. Reload Obsidian and enable "Gantt Notes".`);
