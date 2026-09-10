#!/usr/bin/env node
// index.html's inline <script> is one big shared scope (no modules, no IIFE
// wrapper -- see project convention notes) with ~640 top-level declarations.
// `const`/`let` re-declarations in the same scope are already a hard
// SyntaxError, so npm test (which loads the script into a vm sandbox) would
// already catch those. A duplicate `function name(){...}` declaration is NOT
// an error though -- the later one silently overwrites the earlier one, no
// warning anywhere. That's the one gap this script closes: a lightweight,
// dependency-free scan for duplicate top-level function names.
//
// Deliberately regex/line-based, not a real parser (no npm dependency, per
// this project's zero-dependency convention) -- relies on this file's own
// established, consistent style of always starting a top-level function
// declaration at column 0 with `function name(` or `async function name(`.
"use strict";
const fs = require("fs");
const path = require("path");

const indexPath = path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(indexPath, "utf8");
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
if (!scriptMatch) {
  console.error("check-duplicate-declarations: no inline <script> block found in index.html");
  process.exit(1);
}
const script = scriptMatch[1];
const scriptStartLine = html.slice(0, scriptMatch.index).split("\n").length;

const declRegex = /^(?:async\s+function|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
const seen = new Map(); // name -> [lineNumbers]
script.split("\n").forEach((line, i) => {
  const m = declRegex.exec(line);
  if (!m) return;
  const name = m[1];
  const lineNo = scriptStartLine + i;
  if (!seen.has(name)) seen.set(name, []);
  seen.get(name).push(lineNo);
});

const duplicates = [...seen.entries()].filter(([, lines]) => lines.length > 1);
if (duplicates.length === 0) {
  console.log(`check-duplicate-declarations: OK -- ${seen.size} top-level function declarations, no duplicates.`);
  process.exit(0);
}

console.error("check-duplicate-declarations: found duplicate top-level function declarations (the later one silently wins, no runtime error):");
duplicates.forEach(([name, lines]) => {
  console.error(`  ${name} -- declared at lines ${lines.join(", ")}`);
});
process.exit(1);
