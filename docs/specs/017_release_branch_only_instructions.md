# 017 — Release workflow: stop at the branch

## Context

The `Create Release PR` workflow fails at its last step with:

```
pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)
```

The repo setting "Allow GitHub Actions to create and approve pull requests" is off
and may not be enableable (it can be locked at the `eggai-tech` org level).

## User instructions (lightly cleaned)


keep the workflow but drop the PR-creation step. It still
validates the version, bumps `package.json` and the changelog, and pushes
`release/vX.Y.Z`. The operator then opens the PR by hand. Merging that PR still
triggers `npm-publish.yml`, because it matches on a merged PR whose head branch
is `release/v*`, not on who opened it.
