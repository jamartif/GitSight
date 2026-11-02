import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Repository } from '../git/gitService';
import { layoutGraph } from '../git/graphLayout';
import { parseNameStatus, parseRemotes, parseShortlog, parseWorktrees } from '../git/parsers';
import { getRemoteProvider, linkifyIssues, parseRemoteUrl } from '../git/remoteProviders';
import { fromNow, mixColors } from '../utils/date';

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsight-test-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' } });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Alice');
  g('config', 'user.email', 'alice@example.com');
  g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  g('add', '.');
  g('commit', '-q', '-m', 'first commit', '-m', 'body line #12');
  g('config', 'user.name', 'Bob');
  g('config', 'user.email', 'bob@example.com');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  g('commit', '-q', '-am', 'second commit');
  g('switch', '-q', '-c', 'feature');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'feature\n');
  g('add', '.');
  g('commit', '-q', '-m', 'feature work');
  g('switch', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'main\n');
  g('add', '.');
  g('commit', '-q', '-m', 'main work');
  g('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
  g('tag', '-a', 'v1.0', '-m', 'release');
  g('mv', 'c.txt', 'renamed.txt');
  g('commit', '-q', '-m', 'rename');
  g('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  return dir;
}

const dir = makeRepo();
const repo = new Repository(dir);

test('blame attributes lines to the right commits', async () => {
  const blame = await repo.blame(path.join(dir, 'a.txt'));
  assert.equal(blame.lines.length, 4);
  const author = (i: number) => blame.commits.get(blame.lines[i].sha)!.author;
  assert.deepEqual([0, 1, 2, 3].map(author), ['Alice', 'Bob', 'Alice', 'Bob']);
  const second = blame.commits.get(blame.lines[1].sha)!;
  assert.equal(second.summary, 'second commit');
  assert.ok(second.previousSha, 'has previous commit');
  assert.equal(second.authorEmail, 'bob@example.com');
});

test('blame with unsaved contents marks new lines as uncommitted', async () => {
  const blame = await repo.blame(path.join(dir, 'a.txt'), 'one\nTWO\nNEW\nthree\nfour\n');
  assert.equal(blame.lines.length, 5);
  assert.match(blame.lines[2].sha, /^0+$/);
  assert.equal(blame.commits.get(blame.lines[3].sha)!.author, 'Alice');
});

test('log parses commits, refs and bodies', async () => {
  const commits = await repo.log({ maxCount: 10 });
  assert.equal(commits[0].subject, 'rename');
  assert.ok(commits[0].refs.some((r) => r.includes('main')));
  const first = commits.find((c) => c.subject === 'first commit')!;
  assert.equal(first.body, 'body line #12');
  assert.equal(first.parents.length, 0);
  const merge = commits.find((c) => c.subject === 'merge feature')!;
  assert.equal(merge.parents.length, 2);
});

test('file history follows renames', async () => {
  const commits = await repo.log({ file: 'renamed.txt', follow: true });
  assert.deepEqual(
    commits.map((c) => c.subject),
    ['rename', 'main work'],
  );
});

test('line history', async () => {
  const commits = await repo.lineHistory('a.txt', 1, 1);
  assert.deepEqual(
    commits.map((c) => c.subject),
    ['second commit', 'first commit'],
  );
});

test('changed files detects renames', async () => {
  const head = (await repo.headSha())!;
  const files = await repo.changedFiles(head);
  assert.deepEqual(files, [{ status: 'R', path: 'renamed.txt', originalPath: 'c.txt' }]);
});

test('branches, tags, remotes, contributors, worktrees', async () => {
  const branches = await repo.branches();
  assert.deepEqual(branches.map((b) => b.name).sort(), ['feature', 'main']);
  assert.ok(branches.find((b) => b.name === 'main')!.current);
  const tags = await repo.tags();
  assert.equal(tags[0].name, 'v1.0');
  const merge = (await repo.log({ maxCount: 10 })).find((c) => c.subject === 'merge feature')!;
  assert.equal(tags[0].sha, merge.sha, 'annotated tag is peeled to the commit');
  const remotes = await repo.remotes();
  assert.equal(remotes[0].name, 'origin');
  const contributors = await repo.contributors();
  assert.deepEqual(
    contributors.map((c) => [c.name, c.commits]),
    [
      ['Bob', 5],
      ['Alice', 1],
    ],
  );
  const wts = await repo.worktrees();
  assert.equal(wts.length, 1);
  assert.equal(wts[0].branch, 'main');
});

test('search commits', async () => {
  assert.equal((await repo.searchCommits('message', 'FEATURE', 10)).length, 2);
  assert.equal((await repo.searchCommits('author', 'alice', 10)).length, 1);
  assert.equal((await repo.searchCommits('file', 'b.txt', 10)).length, 1);
  assert.equal((await repo.searchCommits('change', 'TWO', 10))[0].subject, 'second commit');
});

test('stashes', async () => {
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  await repo.exec(['stash', 'push', '-m', 'wip stuff']);
  const stashes = await repo.stashes();
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0].ref, 'stash@{0}');
  assert.match(stashes[0].message, /wip stuff/);
  await repo.exec(['stash', 'drop']);
});

test('working changes vs buffer', async () => {
  const changes = await repo.workingChanges('a.txt', 'one\nTWO\nthree\nfour\nfive\n');
  assert.deepEqual(changes, { added: [4], modified: [], deleted: [] });
  const changes2 = await repo.workingChanges('a.txt', 'one\n2\nthree\n');
  assert.deepEqual(changes2, { added: [], modified: [1], deleted: [2] });
});

test('previous revision', async () => {
  const commits = await repo.log({ file: 'a.txt' });
  const prev = await repo.previousRevision('a.txt', commits[0].sha);
  assert.equal(prev?.sha, commits[1].sha);
});

test('graph layout places merges in separate lanes', async () => {
  const commits = await repo.log({ topo: true, all: true });
  const rows = layoutGraph(commits);
  assert.equal(rows.length, commits.length);
  const merge = rows.find((r) => r.sha === commits.find((c) => c.subject === 'merge feature')!.sha)!;
  assert.equal(merge.edges.filter((e) => e.kind === 'out').length, 2);
  assert.ok(Math.max(...rows.map((r) => r.width)) >= 2);
  // root commit has no outgoing edges
  assert.equal(rows[rows.length - 1].edges.filter((e) => e.kind === 'out').length, 0);
});

test('graph layout: linear history stays in one lane', () => {
  const rows = layoutGraph([
    { sha: 'c', parents: ['b'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'a', parents: [] },
  ]);
  assert.deepEqual(
    rows.map((r) => r.lane),
    [0, 0, 0],
  );
  assert.ok(rows.every((r) => r.width === 1));
});

test('remote url parsing and providers', () => {
  assert.deepEqual(parseRemoteUrl('git@github.com:acme/widgets.git'), { domain: 'github.com', path: 'acme/widgets' });
  assert.deepEqual(parseRemoteUrl('https://user@gitlab.com/group/sub/proj.git'), { domain: 'gitlab.com', path: 'group/sub/proj' });
  assert.deepEqual(parseRemoteUrl('ssh://git@bitbucket.org:22/team/repo.git'), { domain: 'bitbucket.org', path: 'team/repo' });
  assert.deepEqual(parseRemoteUrl('git@ssh.dev.azure.com:v3/org/proj/repo'), { domain: 'dev.azure.com', path: 'org/proj/_git/repo' });

  const gh = getRemoteProvider('git@github.com:acme/widgets.git')!;
  assert.equal(gh.commitUrl('abc'), 'https://github.com/acme/widgets/commit/abc');
  assert.equal(gh.fileUrl('src/a b.ts', 'main', 4, 9), 'https://github.com/acme/widgets/blob/main/src/a%20b.ts#L5-L10');
  const gl = getRemoteProvider('https://gitlab.com/group/proj.git')!;
  assert.equal(gl.fileUrl('x.ts', 'dev', 0), 'https://gitlab.com/group/proj/-/blob/dev/x.ts#L1');
  const custom = getRemoteProvider('git@git.corp.io:team/app.git', [{ domain: 'git.corp.io', type: 'gitlab' }])!;
  assert.equal(custom.type, 'gitlab');
  assert.equal(getRemoteProvider('git@unknown.host:a/b.git'), undefined);
  assert.equal(linkifyIssues('fix #12 and (#3)', gh), 'fix [#12](https://github.com/acme/widgets/issues/12) and ([#3](https://github.com/acme/widgets/issues/3))');
});

test('misc parsers', () => {
  assert.deepEqual(parseNameStatus('M\0a.ts\0R100\0old.ts\0new.ts\0'), [
    { status: 'M', path: 'a.ts' },
    { status: 'R', path: 'new.ts', originalPath: 'old.ts' },
  ]);
  assert.equal(parseRemotes('origin\tgit@x:a/b.git (fetch)\norigin\tgit@x:a/b.git (push)\n').length, 1);
  assert.deepEqual(parseShortlog('    10\tAna <ana@x.io>\n     2\tLuis <l@x.io>\n')[0], { commits: 10, name: 'Ana', email: 'ana@x.io' });
  const wts = parseWorktrees('worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\n');
  assert.equal(wts[1].detached, true);
  assert.equal(wts[0].main, true);
});

test('date helpers', () => {
  const now = 1_700_000_000;
  assert.equal(fromNow(now - 3 * 86400, now, 'en'), '3 days ago');
  assert.equal(fromNow(now - 10, now, 'en'), 'just now');
  assert.equal(mixColors('#000000', '#ffffff', 0.5), '#808080');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
