# 017 — Release workflow: stop at the branch — plan

## Goal

Make the release-preparation workflow succeed without the "create and approve
pull requests" permission, by ending at the pushed `release/vX.Y.Z` branch and
telling the operator how to open the PR.

## Changes

1. `.github/workflows/create-release-pr.yml`
   - Rename the workflow to `Prepare Release Branch`.
   - Drop the `pull-requests: write` permission (no longer needed; `contents: write`
     stays for the branch push).
   - Replace the `Create Pull Request` step with a `Next steps` step that writes the
     compare URL and an equivalent `gh pr create` command to the job summary and the
     log.
   - Keep the branch-cleanup-on-failure step unchanged.
   - Keep the file name so existing links and muscle memory still work.

2. `README.md`
   - Add a short "Releasing" section: run the workflow with a version, open the PR
     from the pushed branch, merge, and the publish workflow tags and publishes.

3. Specs: this pair under `docs/specs/017_*`.

## Not changed

- `npm-publish.yml` is untouched. It triggers on a merged PR from a `release/v*`
  branch, so a hand-opened PR still publishes. It needs the npm trusted publisher
  configured on npmjs.com (org `eggai-tech`, repo `configurable-agent`, workflow
  `npm-publish.yml`, environment `npm`) — that is a one-time console step, not a
  code change.

## Side effect worth knowing

PRs opened with `GITHUB_TOKEN` never trigger other workflows, so the old bot-opened
release PRs ran no CI. A human-opened PR gets normal CI and the changelog check.
