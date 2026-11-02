/* Smoke test: activates the extension against a stubbed `vscode` module and checks that
 * every command contributed in package.json is registered (and vice versa). */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');

const registered = new Set<string>();
const views = new Set<string>();

function stub(name = 'vscode'): any {
  const fn = function () {
    return stub(name + '()');
  };
  const props = new Map<PropertyKey, unknown>();
  return new Proxy(fn, {
    set(_t, prop, value) {
      props.set(prop, value);
      return true;
    },
    get(_t, prop) {
      if (props.has(prop)) return props.get(prop);
      if (prop === 'then') return undefined; // not a thenable
      if (prop === Symbol.toPrimitive) return () => name;
      if (prop === 'registerCommand')
        return (id: string) => {
          registered.add(id);
          return { dispose() {} };
        };
      if (prop === 'createTreeView')
        return (id: string) => {
          views.add(id);
          return stub('treeView');
        };
      if (prop === 'workspaceFolders') return [];
      if (prop === 'visibleTextEditors') return [];
      if (prop === 'activeTextEditor') return undefined;
      if (prop === 'executeCommand') return () => Promise.resolve(undefined);
      if (prop === 'getConfiguration') return () => ({ get: () => undefined, update: () => Promise.resolve() });
      return stub(`${name}.${String(prop)}`);
    },
    construct() {
      return stub(`new ${name}`);
    },
    apply() {
      return stub(`${name}()`);
    },
  });
}

test('activate registers every contributed command and view', async () => {
  const vscodeStub = stub();
  const origLoad = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'vscode') return vscodeStub;
    return origLoad.call(this, request, ...rest);
  };
  try {
    const ext = require('../extension');
    const subscriptions: unknown[] = [];
    ext.activate({ subscriptions });
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    Module._load = origLoad;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const contributed: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);
  const missing = contributed.filter((c) => !registered.has(c));
  assert.deepEqual(missing, [], 'contributed commands without implementation');
  const undeclared = [...registered].filter((c) => !c.startsWith('gitsight.internal.') && !contributed.includes(c));
  assert.deepEqual(undeclared, [], 'registered commands missing from package.json');

  const contributedViews: string[] = pkg.contributes.views.gitsight.map((v: { id: string }) => v.id);
  assert.deepEqual([...views].sort(), [...contributedViews].sort());

  // Every command referenced in menus exists
  const menuCommands = Object.values(pkg.contributes.menus as Record<string, { command?: string }[]>)
    .flat()
    .map((m) => m.command)
    .filter(Boolean) as string[];
  assert.deepEqual(
    menuCommands.filter((c) => !contributed.includes(c)),
    [],
  );
});
