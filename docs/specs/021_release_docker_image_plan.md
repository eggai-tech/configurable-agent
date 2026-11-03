# Plan: push the container image on release

## Finding

`ci.yml` builds and pushes `ghcr.io/eggai-tech/configurable-agent` on a push of a `v*.*.*` tag. The release tag is
pushed by the `create-tag` job of `npm-publish.yml` with `GITHUB_TOKEN`, and GitHub does not start workflows from
pushes made with `GITHUB_TOKEN`. So no workflow ran for `v0.3.0` or `v0.3.1`: the release images were not built by
CI (GHCR has `0.3.1` but no `0.3`, which the `{{major}}.{{minor}}` rule would have pushed).

## Fix

A `docker-publish` job in `npm-publish.yml`, after `create-tag`: check out `v<version>`, log in to GHCR with
`GITHUB_TOKEN` (`packages: write`), and build and push with the same actions as `ci.yml`. Tags come from
`docker/metadata-action` with `type=semver` and an explicit `value`, since the event is a merged PR, not a tag push:
`<version>`, and `<major>.<minor>` for a stable release (the action skips it for a prerelease). `latest` stays with
`ci.yml`, which pushes it from `main`.

The job is independent of `publish-npm`, so an npm failure does not hold back the image, and a re-run (or a
`workflow_dispatch` with the version) pushes the same tags again.

## Not changed

`ci.yml` keeps its tag trigger: a tag pushed by a person still builds there.
