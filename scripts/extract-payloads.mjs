// Reads the vendored core.ts and writes, per command, the payload type that
// its `invoke` switch case reads. Output feeds `wf commands`.
//
//   node scripts/extract-payloads.mjs <core.ts> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const [file, out] = process.argv.slice(2);
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);

let invokeSwitch;
const findSwitch = (node) => {
  if (invokeSwitch) return;
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === "invoke" &&
    node.initializer
  ) {
    const visit = (n) => {
      if (!invokeSwitch && ts.isSwitchStatement(n) && n.expression.getText(source) === "command") {
        invokeSwitch = n;
      }
      ts.forEachChild(n, visit);
    };
    visit(node.initializer);
  }
  ts.forEachChild(node, findSwitch);
};
findSwitch(source);
if (!invokeSwitch) throw new Error("switch (command) in invoke not found");

const flat = (text) => text.replace(/\s+/g, " ").replace(/;\s*}/g, " }").trim();

function describe(statements) {
  const hints = [];
  const visit = (n) => {
    if (ts.isAsExpression(n)) {
      let inner = n.expression;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      const text = inner.getText(source);
      if (text === "payload") hints.push(flat(n.type.getText(source)));
      else if (/^payload\s*\?\?\s*\{\s*\}$/.test(text))
        hints.push(`optional ${flat(n.type.getText(source))}`);
    }
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(source) === "JSON.stringify" &&
      n.arguments[0]?.getText(source) === "payload"
    ) {
      hints.push("object, sent as the request body");
    }
    ts.forEachChild(n, visit);
  };
  statements.forEach(visit);
  return [...new Set(hints)].join(" | ") || "none";
}

const result = {};
let pending = [];
for (const clause of invokeSwitch.caseBlock.clauses) {
  if (ts.isCaseClause(clause)) pending.push(clause.expression.text);
  if (clause.statements.length === 0) continue;
  const hint = describe(clause.statements);
  for (const name of pending) result[name] = hint;
  pending = [];
}
const sorted = Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(out, JSON.stringify(sorted, null, 2) + "\n");
console.log(`Extracted payload hints for ${Object.keys(sorted).length} commands`);
