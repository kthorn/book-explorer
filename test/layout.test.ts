import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(
  new URL("../../public/index.html", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../../public/styles.css", import.meta.url),
  "utf8",
);

test("desktop conversation sidebar stays viewport-height", () => {
  const aside = shell.match(/<aside\s+class="([^"]+)"/);

  assert.ok(aside);
  assert.match(aside[1], /lg:sticky/);
  assert.match(aside[1], /lg:top-0/);
  assert.match(aside[1], /lg:h-screen/);
  assert.doesNotMatch(aside[1], /lg:min-h-screen/);
  assert.match(css, /\.lg\\:sticky\{position:sticky\}/);
  assert.match(css, /\.lg\\:top-0\{top:0\}/);
  assert.match(css, /\.lg\\:h-screen\{height:100vh\}/);
});
