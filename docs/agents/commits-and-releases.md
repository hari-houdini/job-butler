# Commits and releases

## Commit messages: Conventional Commits, mandatory

Every commit subject follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>)<!>: <description>
```

Types: `feat` (new behaviour, minor bump before 1.0), `fix` (bug fix, patch), `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`, `revert`. Use `!` after the type/scope, or a `BREAKING CHANGE:` footer, for a breaking change (major bump).

Examples: `feat(discover): add the Ashby reader`, `fix(screen): cap fit at 49 when a rule fails`, `ci: lint pull request commits`.

Enforced in three places:

- **Locally:** `.githooks/commit-msg` runs commitlint on every commit (`npm install` sets `core.hooksPath`).
- **In CI:** the `check` workflow lints every commit in a pull request against its base.
- **Merge commits** (`Merge branch ...`) are exempt, as commitlint ignores them by default.

History before `4f31c6d` is not Conventional and is not rewritten. Release tooling ignores it (see `bootstrap-sha` below).

## Releases: release-please

[release-please](https://github.com/googleapis/release-please) reads the Conventional Commits on `main` and:

1. Opens (or updates) a **release PR** that bumps the version, writes the `CHANGELOG.md` entry and updates `.claude-plugin/plugin.json`.
2. When that PR merges, tags `vX.Y.Z` on `main` and creates the GitHub Release.

Nothing is published to npm (`"private": true`). The version is kept in `package.json`, `.release-please-manifest.json` and `.claude-plugin/plugin.json`. release-please bumps all three in the release PR, so don't edit them by hand.

Config: `release-please-config.json` (`bootstrap-sha`, `extra-files`) and `.github/workflows/release-please.yml`.

### The first release is v1.0.0

The repository has no tags, and the code is at `0.1.0`. The first release is `v1.0.0` (semver needs all three parts, so `v1` alone is not a valid tag).

- `release-please-config.json` sets `"release-as": "1.0.0"` on the package, so the release PR proposes 1.0.0 whatever the commits say.
- **After the v1.0.0 release PR is merged, delete the `release-as` line.** Otherwise every later release PR keeps proposing 1.0.0.

### Cutting a release

1. Merge work to `main` with Conventional Commit subjects.
2. Review the open release PR (`chore(main): release X.Y.Z`): check the CHANGELOG entry and the version bump.
3. Merge it. The tag and GitHub Release are created automatically.

Release PRs are opened by the workflow's `GITHUB_TOKEN`, which does not trigger other workflows. If `check` should run on a release PR, close and reopen it, or add a token later.
