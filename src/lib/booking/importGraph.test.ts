// What the Stripe money routes load (round-2 triage). The abandon, sweep and Stripe webhook routes must never
// reach the Beam client (lib/booking/beam.ts) through their static value imports: lock.ts, which each of them
// loads (through runtime.ts), takes the Beam id check from payments/beamIds.ts, which imports nothing, and
// beam.ts only re-exports it. Production main (cd6dae8) bundled none of the three with beam.ts either.
//
// The walk follows every import and export ... from of a module the route loads, as node and the bundler
// would: '@/...' and relative specifiers, with or without the .ts extension. Type-only imports and exports
// (import type, import { type X }, export type) are erased and not followed; bare package imports and
// dynamic import() are not followed either.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const BEAM_CLIENT = "lib/booking/beam.ts";

/** A source path relative to src/, with forward slashes. */
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // a package (next/server, node:crypto, stripe, ...)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts"), path.join(base, "index.tsx"), path.join(base, "index.js")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${rel(from)}: cannot resolve ${spec}`);
}

/** The specifiers of a module's static VALUE imports and re-exports (type-only ones are erased). */
function valueImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const specs: string[] = [];
  for (const st of source.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      const onlyTypes = clause !== undefined && !clause.name && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
      if (!onlyTypes) specs.push(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      if (st.isTypeOnly) continue;
      const named = st.exportClause;
      const onlyTypes = named !== undefined && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
      if (!onlyTypes) specs.push(st.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(st) && !st.isTypeOnly && ts.isExternalModuleReference(st.moduleReference) && ts.isStringLiteral(st.moduleReference.expression)) {
      specs.push(st.moduleReference.expression.text);
    }
  }
  return specs;
}

/** Every module a route loads, each with the module that first imported it (breadth first). */
function loadedBy(route: string): Map<string, string | null> {
  const start = path.join(SRC, route);
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
    for (const spec of valueImports(file)) {
      const target = resolve(file, spec);
      if (target !== null && !parent.has(target)) {
        parent.set(target, file);
        queue.push(target);
      }
    }
  }
  return parent;
}

/** route -> ... -> target, or null when the route does not load it. */
function chainTo(graph: Map<string, string | null>, target: string): string[] | null {
  const hit = [...graph.keys()].find((f) => rel(f) === target);
  if (!hit) return null;
  const chain: string[] = [];
  for (let f: string | null | undefined = hit; f; f = graph.get(f)) chain.unshift(rel(f));
  return chain;
}

test("the abandon, sweep and Stripe webhook routes never load the Beam client (beam.ts) through a static value import", () => {
  for (const route of ["app/api/booking/abandon/route.ts", "app/api/booking/sweep/route.ts", "app/api/stripe/webhook/route.ts"]) {
    const graph = loadedBy(route);
    // The walk really reaches the Stripe money code and the import-free id check...
    for (const loaded of ["lib/booking/runtime.ts", "lib/booking/lock.ts", "lib/booking/payments/beamIds.ts", "lib/booking/fulfil.ts"]) {
      assert.ok(chainTo(graph, loaded), `${route} loads ${loaded}`);
    }
    // ...and never the Beam client.
    const chain = chainTo(graph, BEAM_CLIENT);
    assert.equal(chain, null, `${route} loads ${BEAM_CLIENT} via ${chain?.join(" -> ")}`);
  }
});

test("the walk finds beam.ts where a route does load it (checkout, status) and skips type-only imports", () => {
  // The checkout and status routes loaded beam.ts already at production main (checkout.ts, status.ts).
  assert.deepEqual(chainTo(loadedBy("app/api/booking/checkout/route.ts"), BEAM_CLIENT)?.slice(-2), ["lib/booking/checkout.ts", BEAM_CLIENT]);
  assert.deepEqual(chainTo(loadedBy("app/api/booking/status/route.ts"), BEAM_CLIENT)?.slice(-2), ["lib/booking/status.ts", BEAM_CLIENT]);
  // beamRecord.ts names beam.ts in a type-only import only: not a load.
  const record = path.join(SRC, "lib/booking/payments/beamRecord.ts");
  assert.ok(readFileSync(record, "utf8").includes('import type { BeamMethodGroup } from "../beam.ts";'));
  assert.equal(chainTo(loadedBy("lib/booking/payments/beamRecord.ts"), BEAM_CLIENT), null);
  // beamIds.ts imports nothing at all.
  assert.deepEqual(valueImports(path.join(SRC, "lib/booking/payments/beamIds.ts")), []);
  assert.equal(/^\s*import\s/m.test(readFileSync(path.join(SRC, "lib/booking/payments/beamIds.ts"), "utf8")), false);
});
