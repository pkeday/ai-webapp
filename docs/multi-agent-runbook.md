# Multi-Agent Runbook (MVP)

Use this runbook when running parallel Codex sessions on this repo.

## Step 1: Create lane branches

Run from repo root:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b codex/prd-<topic>
git checkout -b codex/schema-service-<topic>
git checkout -b codex/consumer-<topic>
git checkout -b codex/qa-release-<topic>
```

Use one branch per active session.

## Step 2: Work in order

1. PRD lane finalizes acceptance criteria and contract.
2. Schema/Service lane builds backend changes.
3. Consumer lane integrates frontend/client changes.
4. QA/Release lane validates and merges.

## Step 3: Keep lanes isolated

- PRD lane should avoid service/client code edits.
- Service lane should avoid `app.js`, `index.html`, `style.css`.
- Consumer lane should avoid backend service internals.
- QA/Release lane should avoid feature coding except hotfixes.

## Step 4: Merge order

1. PRD/Spec PR
2. Schema + Service PR
3. Consumer PR
4. QA + Release PR

If PR2 and PR3 depend on each other, rebase both on latest `main` before QA merge.

## Step 5: Release checklist

- Confirm API health and status endpoints.
- Confirm frontend uses expected contract fields.
- Confirm data counts look sane before and after deploy.
- Confirm rollback path is available (revert commit or redeploy previous version).

## Fast safety checks

```bash
# backend
cd backend && npm run check

# frontend syntax
node --check ../app.js
```
