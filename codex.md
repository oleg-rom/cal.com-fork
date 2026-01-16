# Codex Agent Instructions — `cal.com-fork`

## 1) Role and Objective

**Role:** DevOps-aware application engineer working in the Cal.com application fork.
**Primary objective:** Maintain a clean fork that tracks upstream Cal.com while enabling **custom changes** (e.g., Stripe Checkout) in **feature branches**, and producing **versioned Docker images** via CI for downstream deployment.

## 2) Canonical Architecture Context

- This repository contains **Cal.com application source code** plus custom modifications.
- **CI builds Docker images** from this repo and **pushes to GHCR**.
- The production server **never builds**; it only pulls images built here.

## 3) Branch Strategy and Change Control (Non-Negotiable)

### DO

- Treat `main` as a **clean upstream-tracking branch**.
- Perform **all custom app feature work** in **feature branches** (or short-lived integration branches if needed).
- Use `main` for **fork maintenance changes** that keep CI/build/deploy working (workflows, build scripts, docs) as long as they do **not** modify application code or introduce custom product features.
- Keep feature branches **small, reviewable, and focused** on a single change/theme.
- Rebase or merge upstream into feature branches as needed to keep them current (choose the method consistent with repo practice; do not invent a new flow without explicit direction).

### DO NOT

- **Never commit directly to `main`** without explicit user approval.
- **Never merge PRs into `main`** that contain custom app features.
- Never force-push to `main`.
- Never rewrite history of `main` or otherwise diverge `main` from upstream.

## 4) Upstream Handling Rules

### DO

- Keep the fork aligned with the upstream repository (`calcom/cal.com`) by regularly syncing `main` to upstream.
- Ensure upstream sync operations preserve the invariant: **`main` tracks upstream** and remains free of custom features.
- When upstream introduces changes affecting custom work, update feature branches accordingly (resolve conflicts, update integrations, adjust patches).

### DO NOT

- Do not “patch” upstream changes directly on `main`.
- Do not carry long-lived custom divergence on `main`.

## 5) CI Responsibilities (Fork Repo)

### DO

- Ensure CI is responsible for:
  - Building Docker images from this source tree.
  - Publishing images to **GHCR**.
  - Producing immutable image versions suitable for production use.
- Ensure CI outputs provide clear traceability:
  - Source commit → image tag → deployable artifact.

### DO NOT

- Do not shift build responsibilities to the server or the deploy repo.
- Do not add CI behaviors that require manual intervention on the server.

## 6) Image Tagging and Versioning (Non-Negotiable)

### DO

- Use **immutable tags** for all images.
- Use **git SHA tags** as the primary deploy/rollback identifier.
- Ensure tagging strategy supports:
  - Deterministic rollbacks
  - Auditable provenance
  - No ambiguity about what code is running

### DO NOT

- **Do not use `latest` tags** anywhere.
- Do not use mutable tags that can be repointed to different builds without a new identifier.

## 7) Separation of Concerns with `cal.com-deploy`

### DO

- Treat this repo as the **only source of truth for application code and image build inputs**.
- Communicate required runtime configuration changes (env vars, ports, migrations requirements, etc.) to the deploy repo via documentation or explicit change notes.

### DO NOT

- Do not introduce deployment-only files as the primary mechanism of running production (compose files, host Nginx config, server scripts) unless explicitly required for CI build context.
- Do not embed server-specific secrets or environment values in this repo.

## 8) Security and Secret Handling

### DO

- Keep secrets out of git history and out of repo files.
- Use CI secret stores / protected variables as appropriate (implementation details belong elsewhere; follow existing practice).

### DO NOT

- Do not commit API keys, private certificates, tokens, or production `.env` content.

## 9) What Codex Must Never Do in This Repo (Hard Prohibitions)

- Modify, commit to, merge into, or force-push `main` **without explicit user approval**.
- Introduce or rely on Docker image tags named `latest`.
- Implement “build on server” patterns (Compose build, remote Docker builds, ad-hoc host compilation).
- Move deployment ownership into this repo (compose as the production authority, host Nginx config as the runtime authority).
- Add undocumented coupling to the deploy repository (assumptions about file paths, server users, or host configuration not explicitly stated elsewhere).

## 10) Output Expectations When Working in This Repo

When proposing or executing changes, Codex must:

- State which branch is being used and why.
- Confirm whether changes target `main` or a feature branch, and why.
- Confirm CI-built image traceability (commit SHA → GHCR tag).
- Identify any downstream deploy repo updates required (without implementing them unless asked).
