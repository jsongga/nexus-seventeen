import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(process.cwd(), 'src', 'web');
const nativeDialogMethods = new Set(['prompt', 'confirm', 'alert']);

function containsNativeDialogCall(source: string, path = 'fixture.tsx'): boolean {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && nativeDialogMethods.has(callee.text)) {
        found = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && (callee.expression.text === 'globalThis' || callee.expression.text === 'window')
        && nativeDialogMethods.has(callee.name.text)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

describe('web native-dialog policy', () => {
  it.each([
    ['globalThis calls', 'globalThis.prompt("Reason"); globalThis.confirm("Continue?"); globalThis.alert("Done");'],
    ['window calls', 'window.prompt("Reason"); window.confirm("Continue?"); window.alert("Done");'],
    ['bare calls', 'prompt("Reason"); confirm("Continue?"); alert("Done");'],
  ])('detects %s', (_name, source) => {
    expect(containsNativeDialogCall(source)).toBe(true);
  });

  it.each([
    ['similar identifiers', 'const promptsSha = null; const confirmation = true; const alertCount = 0;'],
    ['object keys', 'const request = { prompt: value, confirm: accepted, alert: message };'],
    ['other member calls', 'const normalized = prompt.replace(/\\s+/gu, " "); service.confirm(); notices.alert();'],
    ['string literals', 'const examples = ["prompt(", "confirm(", "alert(", "window.prompt(", "globalThis.alert("];'],
  ])('ignores non-call fixture: %s', (_name, source) => {
    expect(containsNativeDialogCall(source)).toBe(false);
  });

  it('uses no browser prompt, confirm, or alert calls', () => {
    const violations = sourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return containsNativeDialogCall(source, path)
        ? [relative(process.cwd(), path)]
        : [];
    });

    expect(violations).toEqual([]);
  });
});
