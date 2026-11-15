// Commit messages must follow Conventional Commits (see docs/agents/commits-and-releases.md).
// Merge commits are ignored by commitlint's defaults, so GitHub's "Merge pull request" commits pass.
export default {
  extends: ["@commitlint/config-conventional"],
};
