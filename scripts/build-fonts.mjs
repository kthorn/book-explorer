import { copyFileSync, mkdirSync } from "node:fs";

const output = new URL("../public/fonts/", import.meta.url);
mkdirSync(output, { recursive: true });

for (const [source, target] of [
  ["inter/files/inter-latin-wght-normal.woff2", "inter.woff2"],
  ["source-sans-3/files/source-sans-3-latin-wght-normal.woff2", "source-sans-3.woff2"],
  ["literata/files/literata-latin-wght-normal.woff2", "literata.woff2"],
]) {
  copyFileSync(
    new URL(`../node_modules/@fontsource-variable/${source}`, import.meta.url),
    new URL(target, output),
  );
}
