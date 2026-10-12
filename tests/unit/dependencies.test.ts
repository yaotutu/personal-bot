import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, dirname, join } from "node:path";
import ts from "typescript";

const sourceRoot = resolve(import.meta.dirname, "../../src");
const listSources = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? listSources(file) : Promise.resolve(file.endsWith(".ts") ? [file] : []);
  }))).flat();
};

/** 使用已有 TypeScript parser，不引入 lint/依赖图框架；检查静态、动态和类型 import。 */
const importsOf = (file: string, text: string) => {
  const imports: string[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      imports.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
      imports.push(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
      imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
};

test("features depend only on features/shared and native IDs, never protocol, filesystem or adapters", async () => {
  for (const file of await listSources(join(sourceRoot, "features"))) {
    for (const dependency of importsOf(file, await readFile(file, "utf8"))) {
      if (dependency === "node:crypto") continue;
      assert.ok(dependency.startsWith("."), `${relative(sourceRoot, file)} imports external ${dependency}`);
      const target = relative(sourceRoot, resolve(dirname(file), dependency));
      assert.ok(target.startsWith("features/") || target.startsWith("shared/"), `${relative(sourceRoot, file)} imports outer layer ${dependency}`);
    }
  }
});

test("unit and integration suites are explicitly discovered, bounded, and support files are not tests", async () => {
  const packageFile = JSON.parse(await readFile(resolve(sourceRoot, "../package.json"), "utf8"));
  assert.ok(packageFile.scripts.test.includes("tests/unit/*.test.ts"));
  assert.ok(packageFile.scripts.test.includes("tests/integration/*.test.ts"));
  assert.ok(packageFile.scripts.test.includes("--test-timeout=60000"));
  assert.ok(!packageFile.scripts.test.includes("tests/support/*.test.ts"));
  assert.ok(!packageFile.scripts.test.includes("|| true"));
  for (const directory of ["unit", "integration"])
    assert.ok((await readdir(resolve(sourceRoot, "../tests", directory))).some((name) => name.endsWith(".test.ts")));
});
