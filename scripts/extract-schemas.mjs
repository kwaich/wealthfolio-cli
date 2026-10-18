// Recovers each command's payload and result types from the typed call sites
// in the upstream frontend (`invoke<Result>("command", payload)`), with the
// TypeScript checker, and writes them as expanded TypeScript text.
//
//   node scripts/extract-schemas.mjs <frontend-src-dir> <core.ts> <out.json>
//
// The vendored core.ts says which keys invoke reads; its types are mostly
// Record<string, unknown>. The callers say what goes in them.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const [srcDir, corePath, out] = process.argv.slice(2);
if (!srcDir || !corePath || !out) {
  console.error("usage: extract-schemas.mjs <frontend-src-dir> <core.ts> <out.json>");
  process.exit(2);
}

/** Expansion limits: nesting depth, and characters per rendered type. */
const MAX_DEPTH = 4;
const MAX_CHARS = 6000;
const MAX_DOC = 100;

function commandNames(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "COMMANDS" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const p of node.initializer.properties) if (p.name) names.add(p.name.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|stories)\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const commands = commandNames(corePath);
const program = ts.createProgram(sourceFiles(srcDir), {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowJs: false,
  types: [],
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  baseUrl: dirname(srcDir),
  paths: { "@/*": [`${relative(dirname(srcDir), srcDir)}/*`] },
});
const checker = program.getTypeChecker();
const F = ts.TypeFlags;

function doc(symbol) {
  const text = ts
    .displayPartsToString(symbol.getDocumentationComment(checker))
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return ` /* ${text.length > MAX_DOC ? text.slice(0, MAX_DOC - 1) + "…" : text} */`;
}

/** `optional`: the type of an optional property, whose `undefined` is implied by `?`. */
function render(type, node, depth, seen, optional = false) {
  if (type.flags & (F.Any | F.Unknown)) return "unknown";
  if (type.flags & F.Never) return "never";
  if (type.isUnion()) {
    const members = optional ? type.types.filter((t) => !(t.flags & F.Undefined)) : type.types;
    const parts = [...new Set(members.map((t) => render(t, node, depth, seen)))];
    // `boolean` is the union true | false.
    const t = parts.indexOf("true");
    const f = parts.indexOf("false");
    if (t >= 0 && f >= 0) parts.splice(Math.min(t, f), 2, "boolean");
    return parts.join(" | ");
  }
  if (
    type.flags &
    (F.StringLike |
      F.NumberLike |
      F.BooleanLike |
      F.Null |
      F.Undefined |
      F.Void |
      F.BigIntLike |
      F.ESSymbolLike)
  ) {
    return checker.typeToString(type);
  }
  if (type.isIntersection()) {
    return type.types.map((t) => render(t, node, depth, seen)).join(" & ");
  }
  const name = type.getSymbol()?.getName();
  // Dates are sent as ISO strings by JSON.stringify.
  if (name === "Date") return "string /* ISO date */";
  if (checker.isArrayType(type)) {
    const [element] = checker.getTypeArguments(type);
    const inner = render(element, node, depth, seen);
    return /[|&]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
  }
  if (checker.isTupleType(type)) {
    return `[${checker
      .getTypeArguments(type)
      .map((t) => render(t, node, depth, seen))
      .join(", ")}]`;
  }
  if (type.getCallSignatures().length > 0) return "function";
  if (!(type.flags & F.Object)) return checker.typeToString(type);
  if (depth >= MAX_DEPTH || seen.has(type)) {
    return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  }
  const next = new Set(seen).add(type);
  const fields = [];
  const stringIndex = type.getStringIndexType();
  if (stringIndex) fields.push(`[key: string]: ${render(stringIndex, node, depth + 1, next)}`);
  for (const prop of checker.getPropertiesOfType(type)) {
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    const propType = checker.getTypeOfSymbolAtLocation(prop, node);
    const key = /^[A-Za-z_$][\w$]*$/.test(prop.name) ? prop.name : JSON.stringify(prop.name);
    fields.push(
      `${key}${optional ? "?" : ""}: ${render(propType, node, depth + 1, next, optional)}${doc(prop)}`,
    );
  }
  return fields.length ? `{ ${fields.join("; ")} }` : "{}";
}

/** Expanded text, shallower when the full expansion is too long. */
function describe(type, node) {
  let text = "";
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    text = render(type, node, depth, new Set());
    if (text.length <= MAX_CHARS) return text;
  }
  return text.slice(0, MAX_CHARS - 1) + "…";
}

/** Prefer the shared and web adapters, which are the web app's own calls. */
function rank(file) {
  if (file.includes("/adapters/shared/")) return 0;
  if (file.includes("/adapters/web/")) return 1;
  if (file.includes("/adapters/")) return 2;
  return 3;
}

const found = new Map();
for (const sf of program.getSourceFiles()) {
  const file = sf.fileName;
  if (!file.startsWith(srcDir) || file.includes("/adapters/tauri/")) continue;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "invoke" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      commands.has(node.arguments[0].text)
    ) {
      const name = node.arguments[0].text;
      const payloadNode = node.arguments[1];
      const resultNode = node.typeArguments?.[0];
      const entry = {
        payload: payloadNode
          ? describe(checker.getTypeAtLocation(payloadNode), payloadNode)
          : "none",
        result: resultNode
          ? describe(checker.getTypeFromTypeNode(resultNode), resultNode)
          : "unknown",
        source: `${relative(dirname(dirname(srcDir)), file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
        rank: rank(file),
      };
      const known = found.get(name);
      if (!known || entry.rank < known.rank) found.set(name, entry);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const result = {};
for (const name of [...found.keys()].sort()) {
  const { payload, result: resultType, source } = found.get(name);
  result[name] = { payload, result: resultType, source };
}
writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
const unknown = Object.values(result).filter((e) => e.payload.includes("unknown")).length;
console.log(
  `Extracted types for ${Object.keys(result).length} of ${commands.size} commands ` +
    `(${unknown} payloads still contain unknown)`,
);
