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

---

## 11) Session Log: Docker Build CI Fixes (2026-01-16)

### Goal
Get the Docker image build workflow (`.github/workflows/docker-build-push-ghcr.yml`) to successfully build and push images to GHCR.

### Commits Made (on `main` — fork maintenance, not app features)

1. **`e78c24e32`** — `fix(ci): strip quotes from env values in Docker build workflow`
   - **Problem:** `.env.example` contains quoted values like `NEXT_PUBLIC_API_V2_URL="http://localhost:5555/api/v2"`. When copied to `GITHUB_ENV`, quotes became part of the value, causing Next.js rewrite validation to fail with "Invalid rewrite found".
   - **Fix:** Changed `cat .env >> $GITHUB_ENV` to use sed to strip quotes:
     ```bash
     sed -E "s/^([^=]+)=[\"']?([^\"']*)[\"']?$/\1=\2/" .env >> $GITHUB_ENV
     ```

2. **`b0b2e57f4`** — `fix(ci): add missing database env vars for runtime test`
   - **Problem:** The "Test runtime" step failed because:
     - `scripts/start.sh` calls `scripts/wait-for-it.sh ${DATABASE_HOST}` but `DATABASE_HOST` wasn't set
     - Prisma migration failed with "User was denied access" because `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` weren't in `GITHUB_ENV`
   - **Fix:** Added to "Copy env" step:
     ```bash
     echo "POSTGRES_USER=unicorn_user" >> $GITHUB_ENV
     echo "POSTGRES_PASSWORD=magical_password" >> $GITHUB_ENV
     echo "POSTGRES_DB=calendso" >> $GITHUB_ENV
     ```
   - Added to docker run command:
     ```bash
     -e DATABASE_HOST=database:5432 \
     ```

### Current State — ✅ SUCCESS (2026-01-17)
- **Build succeeded**: Run ID `21092546534`
- **Image pushed**: `ghcr.io/oleg-rom/cal.com-fork:sha-b0b2e57f41011ab8fc8f5a1bc004d78ef4bf912c`
- Workflow URL: https://github.com/oleg-rom/cal.com-fork/actions

### Key Files
- Workflow: `.github/workflows/docker-build-push-ghcr.yml`
- Dockerfile: `./Dockerfile` (multi-stage: builder → builder-two → runner)
- Start script: `scripts/start.sh` (runs migrations, seeds app store, starts Next.js)
- Env template: `.env.example`

### Build Process Overview
1. Workflow triggers on push to `main`, version tags, or manual dispatch
2. Starts postgres container from `docker-compose.yml`
3. Builds image with build args from `.env.example`
4. Tests runtime by starting container and health-checking `/auth/login`
5. Pushes to `ghcr.io/oleg-rom/cal.com-fork:sha-<full-commit-sha>`

### Known Issues Fixed
| Issue | Root Cause | Fix Commit |
|-------|-----------|------------|
| "Invalid rewrite found" | Quoted env values in GITHUB_ENV | `e78c24e32` |
| "you need to provide a host and port" | Missing DATABASE_HOST | `b0b2e57f4` |
| "User was denied access on database" | Missing POSTGRES_* vars | `b0b2e57f4` |
| "permission_denied: write_package" | GHCR package not linked to repo | Manual fix in GitHub UI |

### Additional Fixes (2026-01-17)
- **GHCR permissions**: Added repository write access to the package via GitHub UI (Package Settings → Manage Actions access)
- **Disabled cron workflows**: All upstream Cal.com cron jobs disabled via `gh workflow disable` (they require `APP_URL` and `CRON_API_KEY` secrets not needed for this fork)
