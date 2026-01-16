# Cal.com Self-Hosted Setup — How I Work With This System (with Git commands)

## What this setup is

This setup splits **application development** and **production deployment** into two completely separate GitHub repositories.
This separation is intentional and strict. It keeps production stable, auditable, and easy to roll back.

Repositories:

1. **`cal.com-fork`** — application source + CI builds images to GHCR
2. **`cal.com-deploy`** — deployment-only repo that pins image SHAs and runs Docker Compose on the server

---

## Prerequisites (one-time per machine)

You should have both repos cloned locally:

```bash
git clone <YOUR_CAL_COM_FORK_REPO_URL> cal.com-fork
git clone <YOUR_CAL_COM_DEPLOY_REPO_URL> cal.com-deploy
```

---

## The workflow (what I do, in order)

## Step 1 — Work in `cal.com-fork` (code changes)

Move into the fork repo:

```bash
cd cal.com-fork
```

Make sure you are not on `main`:

```bash
git status
git branch --show-current
```

### Create a feature branch (always)

```bash
git checkout main
git pull
git checkout -b feature/<short-name>
```

Work, commit, push:

```bash
git add -A
git commit -m "feat: <what changed>"
git push -u origin feature/<short-name>
```

At this point, CI should build and publish an image to GHCR (after the workflow you use to produce images runs).

---

## Step 2 — Find the image SHA to deploy (GitHub UI)

* Go to `cal.com-fork` → **Actions** and confirm the build succeeded
* Go to `cal.com-fork` → **Packages** and locate the new image version
* Copy the **git SHA tag** used for the image

---

## Step 3 — Deploy via `cal.com-deploy` (pin SHA + deploy)

Move into the deploy repo:

```bash
cd ../cal.com-deploy
```

Pull the latest deploy repo state:

```bash
git checkout main
git pull
```

Update the pinned image SHA in the deploy repo (edit the compose/env reference used for image tags), then commit:

```bash
git add -A
git commit -m "deploy: Cal.com -> <SHA>"
git push
```

Then deploy on the server using your repo’s standard deploy method (script or documented steps).

---

## Rollback (fast and safe)

Rollbacks are done by restoring a previous SHA.

1. Find a previous known-good deploy commit:

```bash
git log --oneline
```

2. Revert the deploy commit:

```bash
git revert <DEPLOY_COMMIT_SHA>
git push
```

Then re-run the deployment procedure on the server (pull + restart).

---

## Rules I do not break

* I never commit to `cal.com-fork/main`
* I never build images on the server
* I never use `latest`
* Production changes happen only through `cal.com-deploy` commits
