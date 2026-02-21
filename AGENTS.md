# AI Webapp Multi-Agent Workflow (MVP)

This repo uses a 4-lane multi-agent workflow.

## Ground Rules

- Mode: `MVP` with production-safe backend structure.
- Data safety is mandatory: do not delete historical data unless explicitly approved.
- Ignore unrelated local changes from other sessions.
- One lane, one branch, one PR.
- Only QA/Release lane can merge to `main`.

## Lanes

### 1) PRD/Spec lane

- Branch prefix: `codex/prd-`
- Scope:
- `docs/`
- `README.md`
- API contracts/spec text
- Deliverables:
- Problem statement
- Acceptance criteria
- Rollback criteria
- API/request-response contract

### 2) Schema + Service lane

- Branch prefix: `codex/schema-service-`
- Scope:
- `backend/src/`
- `backend/scripts/`
- `backend/README.md`
- DB migrations/schema notes
- Deliverables:
- Backward-compatible schema changes
- Service write logic
- Data migration/backfill plan

### 3) Consumer lane

- Branch prefix: `codex/consumer-`
- Scope:
- `app.js`
- `index.html`
- `style.css`
- Any consumer integration files
- Deliverables:
- UI/client integration for new backend contract
- Feature-flagged behavior when needed

### 4) QA + Release lane

- Branch prefix: `codex/qa-release-`
- Scope:
- Validation, regression checks, release notes
- Merge orchestration and deploy
- Deliverables:
- Test evidence
- Go/no-go decision
- Release + rollback steps

## Branching and Handoffs

- PRD lane opens first PR and freezes acceptance criteria.
- Schema/Service lane implements backend against frozen contract.
- Consumer lane implements frontend/client against same contract.
- QA/Release lane validates both and merges in safe order.

## Conflict Rules

- If two lanes need the same file, stop and re-scope before coding.
- Do not rebase away other lane commits without agreement.
- If unexpected file changes appear, stop and ask before proceeding.

## Required Checks Before Merge

- Backend syntax/tests pass.
- Frontend basic smoke check passes.
- No data-loss path introduced.
- Notes include monitoring checks and rollback action.
