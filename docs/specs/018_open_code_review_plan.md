# 018 — Replace QualOps with Open Code Review: plan

## Current state

`.github/workflows/qualops.yml` runs `eggai-tech/qualops@stable` on
`pull_request` against `main`, authenticating with the `ANTHROPIC_API_KEY`
repository secret and `GITHUB_TOKEN`. That is the only QualOps reference in
the repo apart from a historical mention in `docs/specs/015_*`.

## Target (from the Open Code Review CI/CD docs)

Open Code Review (OCR) ships a composite action, `alibaba/open-code-review`,
plus a reference workflow at `examples/github_actions/ocr-review.yml`. The
action installs the `@alibaba-group/open-code-review` CLI, checks the repo
out with full history, runs `ocr review` in branch-range mode, and posts
findings as inline PR review comments with a sticky summary.

Required inputs:

| Input               | Source in this repo                                    |
|---------------------|--------------------------------------------------------|
| `llm_url`           | `https://api.anthropic.com/v1/messages` (hardcoded)    |
| `llm_auth_token`    | `secrets.ANTHROPIC_API_KEY` (reused from QualOps)       |
| `llm_model`         | `vars.OCR_LLM_MODEL`, falling back to `claude-opus-5-5` |
| `llm_use_anthropic` | `true`                                                 |

The upstream recipe expects `OCR_LLM_URL` / `OCR_LLM_AUTH_TOKEN` secrets and
`OCR_LLM_MODEL` / `OCR_LLM_USE_ANTHROPIC` variables. Per the user's
instruction we reuse the existing `ANTHROPIC_API_KEY` secret instead, so no
new secret is required. The model can still be overridden with a repository
variable.

## Steps

1. Delete `.github/workflows/qualops.yml`.
2. Add `.github/workflows/ocr-review.yml` based on the upstream recipe:
   - `pull_request_target` (opened / synchronize / reopened) on `main`, plus
     `issue_comment` re-review via `/open-code-review` or `@open-code-review`
     from MEMBER / OWNER / COLLABORATOR authors.
   - Upstream's conditional concurrency group so unrelated PR comments do
     not cancel a running review.
   - `permissions: contents: read, pull-requests: write`.
   - Pin the action to `alibaba/open-code-review@v1.13.2` (latest release at
     time of writing) instead of `@main`; inputs are identical between the
     two.
3. Record the specs under `docs/specs/018_*`.
4. Commit in small steps (specs, then workflow swap).

## Notes

- `pull_request_target` is what upstream recommends so that secrets are
  available to fork PRs; the action only reads the diff and never executes
  PR code.
- The action's default `llm_extra_body` disables thinking mode, which is a
  valid Anthropic request field; left at default.
- `ANTHROPIC_API_KEY` remains the single LLM credential; nothing to add in
  repository settings unless the model should change.
