# 018 — Replace QualOps with Open Code Review

## User instructions

> Replace qualops in this repo (github action/workflow) with
> https://open-codereview.ai/docs
> Reuse the LLM env vars configured for qualops.

## Context supplied by the user

The docs site is a client-rendered app and `/docs` returns 404 to a plain
fetch, so the user exported the CI/CD docs page to a PDF. That page 
documents the GitHub Actions recipe for Alibaba's Open Code Review 
(`alibaba/open-code-review`).
