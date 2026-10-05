// Test entry so `node --test src/lib/booking` runs every *.test.ts in this
// folder (Node treats a directory argument as a module and loads this file).
// Not imported by the app. `node --test "src/lib/booking/*.test.ts"` works too.
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
for (const name of files) {
  await import(pathToFileURL(dir + name).href);
}
