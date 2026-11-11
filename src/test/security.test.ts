import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { FirstParentCache, Repository, isValidRefName, mapLimit } from '../git/gitService';
import { getRemoteProvider, parseRemoteUrl } from '../git/remoteProviders';
import { escapeMarkdown } from '../utils/markdown';
import { isFullSha } from '../webviews/html';
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

test('removing a workspace folder only forgets the repositories inside it', () => {
  const one = new Set(['s']);
  const cache = new FirstParentCache(100);
  const root = (...p: string[]) => path.join(path.sep, 'ws', ...p);
  cache.set(root('a'), 'main\0x', one);
  cache.set(root('b'), 'main\0x', one);
  cache.set(root('c'), 'main\0x', one);
  cache.set(path.join(path.sep, 'elsewhere'), 'main\0x', one);

  // Folder `a` is closed; `b` and a subfolder of `c` stay open.
  cache.clearRemovedFolders([root('a'), root('c')], [root('b'), root('c', 'pkg')]);
  assert.equal(cache.get(root('a'), 'main\0x'), undefined, 'removed folder is forgotten');
  assert.ok(cache.get(root('b'), 'main\0x'), 'other folders are kept');
  assert.ok(cache.get(root('c'), 'main\0x'), 'a repository still open through another folder is kept');
  assert.ok(cache.get(path.join(path.sep, 'elsewhere'), 'main\0x'), 'repositories outside any folder are kept');

  // A removed subfolder of a repository forgets that repository; a removed parent forgets the ones inside.
  cache.clearRemovedFolders([root('b', 'src')], []);
  assert.equal(cache.get(root('b'), 'main\0x'), undefined);
  cache.clearRemovedFolders([path.join(path.sep, 'ws')], []);
  assert.equal(cache.get(root('c'), 'main\0x'), undefined);
  assert.equal(cache.size, 1);
});

test('ref names are validated by git check-ref-format', async () => {
  for (const ok of ['feature/x', 'v1.2.3', 'fix-123', 'a.b']) assert.equal(await isValidRefName('branch', ok), true, ok);
  for (const bad of ['rama.lock', 'a/.b', 'a..b', 'a b', 'x@{1}', '-x', '--output=/tmp/x', '', 'HEAD', 'a/', '@{-1}', 'a\nb']) {
    assert.equal(await isValidRefName('branch', bad), false, JSON.stringify(bad));
  }
  assert.equal(await isValidRefName('tag', 'v1.0.0'), true);
  assert.equal(await isValidRefName('tag', 'v1.lock'), false);
});

test('reading the working-tree version of a file cannot leave the repository', async () => {
  const dir = makeRepo();
  const outside = path.join(path.dirname(dir), `${path.basename(dir)}-secret.txt`);
  fs.writeFileSync(outside, 'secret\n');
  const repo = new Repository(dir);
  assert.equal(await repo.show('', 'a.txt'), 'a\n');
  for (const rel of [`../${path.basename(outside)}`, outside, 'sub/../../' + path.basename(outside)]) {
    await assert.rejects(repo.show('', rel), /outside the repository/, rel);
    await assert.rejects(repo.show('0000000000000000000000000000000000000000', rel), /outside the repository/, rel);
  }
  fs.rmSync(outside);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('remote URLs only yield https links to a plain host, with the path encoded', () => {
  for (const url of ['https://user@evil.example@github.com.attacker/x/y.git', 'https://git hub.com/a/b', 'git@github.com)[x](command:y:a/b.git']) {
    assert.equal(parseRemoteUrl(url), undefined, url);
  }
  const p = getRemoteProvider('https://github.com/acme/wid)gets (x)?q=1#frag.git')!;
  assert.equal(p.baseUrl, 'https://github.com/acme/wid%29gets%20%28x%29%3Fq%3D1%23frag');
  assert.doesNotMatch(p.commitUrl('a'.repeat(40)), /[()\s"]/);
  assert.equal(getRemoteProvider('git@github.com:acme/widgets.git')!.baseUrl, 'https://github.com/acme/widgets');
  assert.equal(getRemoteProvider('git@ssh.dev.azure.com:v3/org/proj/repo')!.baseUrl, 'https://dev.azure.com/org/proj/_git/repo');
});

test('background git commands never rewrite the index', async () => {
  const dir = makeRepo();
  const index = path.join(dir, '.git', 'index');
  // Same content, new mtime: a plain `git status` would refresh the index entry and rewrite the file.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(dir, 'a.txt'), later, later);
  const before = fs.readFileSync(index);
  const repo = new Repository(dir);
  await repo.exec(['status', '--porcelain']);
  await repo.exec(['diff', 'HEAD']);
  assert.ok(before.equals(fs.readFileSync(index)), 'index is untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('text from commits is inert in Markdown tooltips, and webviews only send full SHAs', () => {
  const evil = '![x](https://tracker.example/p.png) [a](https://evil.example) <img src=x> `c` $(flame) &lt;';
  const escaped = escapeMarkdown(evil);
  // every Markdown-significant character is preceded by a backslash
  assert.doesNotMatch(escaped, /(?<!\\)[![\]()<>`$&]/);
  assert.ok(isFullSha('a'.repeat(40)) && isFullSha('0123456789abcdef'.repeat(4)));
  for (const v of ['--abort', 'HEAD', 'a'.repeat(39), 'A'.repeat(40), 'a'.repeat(40) + '\n', undefined, 5, ['a'.repeat(40)]]) {
    assert.equal(isFullSha(v), false, String(v));
  }
});
