import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { FirstParentCache, Repository, isValidRefName, mapLimit } from '../git/gitService';
import { getRemoteProvider } from '../git/remoteProviders';
import { commitMessageHtml } from '../webviews/messageHtml';

const gh = getRemoteProvider('git@github.com:acme/widgets.git')!;

/** Targets of real <a> elements (escaped text such as `&lt;a href=...` is inert and not counted). */
function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>/gi)].map((m) => /href\s*=\s*"([^"]*)"/i.exec(m[0])?.[1] ?? '(no href)');
}

test('commit messages cannot inject command: (or any non-https) links into the details panel', () => {
  const evil = [
    'Fix #7',
    '[#1](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22rm%20-rf%20~%5Cn%22%7D)',
    '[#2](javascript:alert(1))',
    '<a href="command:workbench.action.terminal.new">#3</a>',
    '#4"><img src=x onerror=alert(1)>',
  ].join('\n');
  for (const provider of [gh, undefined]) {
    const html = commitMessageHtml(evil, provider);
    for (const h of hrefs(html)) assert.match(h, /^https:\/\//, `unexpected link target: ${h}`);
    assert.doesNotMatch(html, /<a[^>]+command:/i);
    assert.doesNotMatch(html, /<img/i, 'raw HTML from the message is escaped');
    assert.equal((html.match(/<a\b/g) ?? []).length, provider ? 2 : 0, 'only #7 and #4 become links');
    // the text is still shown, escaped
    assert.match(html, /command:workbench\.action\.terminal\.sendSequence/);
  }
  // legitimate issue references still become links to the provider
  assert.deepEqual(hrefs(commitMessageHtml('Fix #7 and (#8)', gh)), [
    'https://github.com/acme/widgets/issues/7',
    'https://github.com/acme/widgets/issues/8',
  ]);
});

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsight-sec-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Bob (the + builder)');
  g('config', 'user.email', 'bob@example.com');
  g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  g('add', '.');
  g('commit', '-q', '-m', 'first');
  return dir;
}

test('SHA search rejects option-like input and never lets git write files', async () => {
  const dir = makeRepo();
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'precious\n');
  const repo = new Repository(dir);
  for (const q of [`--output=${victim}`, '-p', '--all', 'HEAD', 'not-a-sha', '12']) {
    assert.deepEqual(await repo.searchCommits('sha', q, 10), [], q);
  }
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious\n');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal((await repo.searchCommits('sha', head.substring(0, 7).toUpperCase(), 10))[0]?.sha, head);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refs starting with "-" are rejected before reaching git', async () => {
  const dir = makeRepo();
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'precious\n');
  const repo = new Repository(dir);
  await assert.rejects(repo.log({ ref: `--output=${victim}` }));
  await assert.rejects(repo.getCommit(`--output=${victim}`));
  await assert.rejects(repo.show(`--output=${victim}`, 'a.txt'));
  await assert.rejects(repo.diffFiles(`--output=${victim}`, 'HEAD'));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('author search treats the query literally, like message search', async () => {
  const dir = makeRepo();
  const repo = new Repository(dir);
  assert.equal((await repo.searchCommits('author', 'Bob (the + builder', 10)).length, 1);
  assert.equal((await repo.searchCommits('author', 'b.b', 10)).length, 0, 'regex metacharacters are not interpreted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mapLimit never runs more than the limit at once', async () => {
  let running = 0;
  let peak = 0;
  const seen: number[] = [];
  await mapLimit(Array.from({ length: 40 }, (_, i) => i), 6, async (i) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 2));
    seen.push(i);
    running--;
  });
  assert.equal(peak, 6);
  assert.equal(seen.length, 40);
});

test('branchOrigin cache is invalidated when a branch moves', async () => {
  const dir = makeRepo();
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir }).toString().trim();
  g('switch', '-q', '-c', 'feature/x');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  g('add', '.');
  g('commit', '-q', '-m', 'on feature');
  const sha = g('rev-parse', 'HEAD');
  g('switch', '-q', 'main');
  const repo = new Repository(dir);
  const first = await repo.branchOrigin(sha);
  assert.deepEqual(first.createdOn, ['feature/x']);
  assert.deepEqual(await repo.branchOrigin(sha), first, 'cached result is identical');
  // Fast-forward main onto the commit: it is now on main's first-parent chain.
  g('merge', '-q', '--ff-only', 'feature/x');
  assert.equal((await repo.branchOrigin(sha)).committedOn, 'main', 'moved branch is re-read');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('first-parent cache is bounded by SHAs, evicts the least recently used and clears per repo', () => {
  const shas = (n: number, p: string) => new Set(Array.from({ length: n }, (_, i) => `${p}${i}`));
  const cache = new FirstParentCache(10);
  cache.set('/a', 'main\0x', shas(4, 'm'));
  cache.set('/a', 'dev\0y', shas(4, 'd'));
  assert.ok(cache.get('/a', 'main\0x'), 'main is now the most recently used');
  cache.set('/b', 'main\0z', shas(4, 'b'));
  assert.equal(cache.get('/a', 'dev\0y'), undefined, 'least recently used entry evicted');
  assert.ok(cache.get('/a', 'main\0x'));
  assert.equal(cache.size, 8);

  cache.clear('/a');
  assert.equal(cache.get('/a', 'main\0x'), undefined);
  assert.ok(cache.get('/b', 'main\0z'), 'other repositories are kept');
  assert.equal(cache.size, 4);

  // An entry larger than the whole budget is still kept until the next insert.
  cache.set('/c', 'big\0w', shas(20, 'c'));
  assert.ok(cache.get('/c', 'big\0w'));
  assert.equal(cache.get('/b', 'main\0z'), undefined);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('ref names are validated by git check-ref-format', async () => {
  for (const ok of ['feature/x', 'v1.2.3', 'fix-123', 'a.b']) assert.equal(await isValidRefName('branch', ok), true, ok);
  for (const bad of ['rama.lock', 'a/.b', 'a..b', 'a b', 'x@{1}', '-x', '--output=/tmp/x', '', 'HEAD', 'a/', '@{-1}', 'a\nb']) {
    assert.equal(await isValidRefName('branch', bad), false, JSON.stringify(bad));
  }
  assert.equal(await isValidRefName('tag', 'v1.0.0'), true);
  assert.equal(await isValidRefName('tag', 'v1.lock'), false);
});
