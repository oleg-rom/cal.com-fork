# cal.com-fork — Human README

## What this repository is for

This repository is my **application workspace**.

It is a fork of the upstream Cal.com repository and exists for:

* Tracking upstream Cal.com changes
* Implementing **custom functionality**
* Producing **Docker images** via CI

This repo is the **only place** where Cal.com source code exists.

---

## How I work in this repo

### Branch rules (very important)

* `main` tracks upstream Cal.com
* I **never** work directly on `main`
* All work happens in **feature branches**

Examples:

* `feature/stripe-checkout`
* `feature/custom-auth`
* `fix/webhook-timeout`

---

## Typical workflow

1. Create a feature branch from `main`
2. Implement my changes
3. Keep the branch up to date with upstream if needed
4. Finalize and merge according to the agreed workflow
5. CI builds a Docker image automatically

---

## What CI does for me

CI in this repo:

* Builds Docker images from the source code
* Pushes images to **GitHub Container Registry (GHCR)**
* Tags images with a **git SHA**

I do **not** deploy from here.

---

## What I must never do here

* Never commit directly to `main`
* Never treat this repo as a deployment repo
* Never assume anything about the production server
* Never use or rely on `latest` Docker tags
* Never add server-specific secrets or configuration

---

## How this repo connects to production

This repo produces **artifacts only**.

Those artifacts are later:

* Pulled by `cal.com-deploy`
* Run on the server

This repo does **not** know how production is deployed — and it shouldn’t.
