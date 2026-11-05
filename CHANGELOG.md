# Changelog

## 0.2.3

- The extension ID is now `jamartif.gitsight-free`, because `gitsight` was already taken in the Visual Studio Marketplace. Settings (`gitsight.*`), commands and views are unchanged. If you installed an earlier version from a `.vsix`, uninstall it first so you do not end up with both.

## 0.2.2

### Security
- Release workflow: the version is validated as a whole string (`[[ =~ ]]`) before being written to `$GITHUB_OUTPUT`; with `grep`, a version containing a newline could add extra outputs.
- Branch and tag names are validated with `git check-ref-format`, which rejects names such as `branch.lock` or `a/.b`.

### Changes
- The `branchOrigin` history cache has a limit (500,000 SHAs, evicting the least recently used) and is cleared when a workspace folder is closed.
- `branchOrigin` uses the same limit (20,000 commits) for the commit's ancestry and for each branch's first-parent history, so it no longer misses the branch of old commits in long histories.

## 0.2.1

### Security
- Details panel: a commit message can no longer create its own links (e.g. `[#1](command:...)`). Only `#123` references are linked, to the remote's https issue URL, and the panel has `enableCommandUris: false`.
- Hovers: command links are limited to GitSight's own commands.
- Revisions starting with `-` are rejected before reaching git (prevents option injection such as `--output=<file>`). SHA search only accepts hexadecimal.
- Release workflow: the version typed by hand is passed through an environment variable instead of being interpolated into the script.

### Changes
- Author search treats the text literally (`--fixed-strings`), like message search.
- `branchOrigin` caches each branch's history while its tip does not change and runs at most 6 git processes at once.

## 0.2.0

- Commit details: shows the branch the commit was made on, the branch it branched from (with the fork commit) and the branches that contain it. Recovers the name of deleted branches from the merge commit message.
- Fixed the duplicated file count in the commit stats.

## 0.1.0

- First release: inline and status bar blame, hovers, CodeLens, file annotations (blame, heatmap, changes), Commits, File History, Line History, Branches, Remotes, Tags, Stashes, Worktrees, Contributors and Search & Compare views, interactive commit graph, commit details panel, links to GitHub/GitLab/Bitbucket/Azure DevOps/Gitea and Git actions (checkout, merge, rebase, cherry-pick, revert, reset, tags, stash, worktrees).
