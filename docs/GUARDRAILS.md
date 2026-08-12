# PR Guardrails for CoreShop

> Modeled after the guardrail system in
> [`cors-gmbh/shared-workflows`](https://github.com/cors-gmbh/shared-workflows),
> adapted to CoreShop specifics (version branches, public OSS core, the
> existing test workflows in this repo).
>
> - Reusable workflows: [`pr-guardrail.yml`](../.github/workflows/pr-guardrail.yml), [`add-to-project.yml`](../.github/workflows/add-to-project.yml)
> - Rule logic + tests: [`scripts/guardrails/`](../scripts/guardrails/) (CI: [`guardrails-ci.yml`](../.github/workflows/guardrails-ci.yml))
> - Distribution: [`sync-files.yml`](../.github/workflows/sync-files.yml) with configuration in [`.github/sync.yml`](../.github/sync.yml)

A central quality gate for pull requests across all CoreShop repositories.
The guardrail runs as a reusable workflow from this repo and is distributed
to the target repos via file sync — each target repo only contains a small
caller workflow, the logic stays central.

## The rules

| Rule | Checks | On violation |
|---|---|---|
| **R1** | Branch is named `issue/<number>` (case-insensitive, suffix allowed: `issue/123-dam-import`) | Violation |
| **R2** | Issue `<number>` exists in **this** repo and is open. A PR number does not count as an issue. | Violation |
| **R3** | Title autofix: if the PR title is just the branch name, it is replaced with `#<number> <issue title>`. Other titles are **never** touched. | Repair, no violation |
| **R4** | The PR description contains real prose (min. 50 characters). HTML comments, Markdown headings and empty checkboxes do not count. | Violation |
| **R5** | All check runs and commit statuses on the head commit are green (Behat/static/CLA included), no merge conflicts. Pending checks trigger nothing — only a final failure or a conflict counts. | Violation |
| **R6** | If the closing reference to the issue from R1 is missing, the guardrail appends `Closes #<number>` to the PR body. | Repair, no violation |
| **R7** | The PR targets a **version branch** (`^\d+\.x$`, e.g. `2.x`). | Violation |

**Merge-up exception:** PRs whose head branch is itself a version branch
(e.g. `1.x` → `2.x`) are exempt from R1, R2, R4 and R6 — by nature they have
no issue and usually no prose body. R5 (green CI) and R7 still apply.

## Two modes

- **Private bundle repos** (b2b-company, ticketing, headless, …):
  `enforce: true`. A violation converts the PR back to **draft**, the sticky
  comment lists the violated rules with one concrete action sentence each,
  and the guardrail job fails.
- **`coreshop/CoreShop`** (public, external contributors): advisory mode
  (`enforce: false`, `require-issue-open: false`) with the OSS PR template.
  Fork contributors do not branch as `issue/<number>` — the guardrail only
  comments, the check stays green.

## Mechanics (as in the CORS reference implementation)

- **Sticky comment** with a fixed marker, updated instead of re-created; on
  success it shrinks to a short confirmation.
- **Draft PRs** are skipped (single exception: title autofix R3). The full
  check starts on "Ready for review".
- **Bot PRs** (`dependabot[bot]`, `renovate[bot]`, `github-actions[bot]`,
  configurable): R1–R3 and R6 are skipped, R5 still applies.
- **Bypass** exclusively via the **`guardrail-bypass`** label: only people
  with `admin`/`maintain` may set it (collaborator API check), a permanent
  audit comment records person, role and time. For anyone else the label is
  removed immediately. There is no other bypass.

## Project board: "CoreShop Development"

Every new **issue** and every new **PR** in the connected repos is added
automatically to the org project
[**CoreShop Development** (coreshop/projects/1)](https://github.com/orgs/coreshop/projects/1)
(a dedicated reusable workflow, analogous to CORS `pr-to-project.yml`, but
with a fixed target project). Linking/synchronizing with the CORS Chronos
board (cors-gmbh/projects/14) is deliberately **not** part of this setup and
can happen later as a separate step — crossing the org boundary would
require a machine-user PAT.

## File sync: guardrail callers **and** test workflows

Distribution is handled by a `sync-files.yml` in this repo
(BetaHuhn/repo-file-sync-action) with group configuration in
`.github/sync.yml`. Two kinds of files are synced:

1. **Guardrail caller, issues-to-project caller + PR template** (enforce or
   OSS variant per group).
2. **Test workflows** — the minimal setup per bundle repo:
   - `static.yaml` — static analysis (all bundle repos)
   - `behat_domain.yml` — Behat domain suite, only for repos that have
     Behat tests (currently b2b-company and ticketing). The bundle class
     name (`run-bundle-installer`, e.g. `CoreShopB2BCompanyBundle`) is
     injected via the sync action's **templating** feature, which is why
     each Behat repo has its own sync group.

**Extensible:** repos can add their own workflows next to the synced ones
(e.g. `behat_ui.yml` with the UI profile) — the sync only overwrites the
files it manages. Note: repo-owned extra workflows (b2b-company
`behat_ui.yml`, headless `behat.yml`) still trigger on `main` and must be
switched to `*.x` manually — see rollout.

**Important — trigger branches:** the synced workflows trigger on version
branches (`'*.x'`), **not** on `main`. The legacy callers in the bundle
repos still listen on `branches: [main]` and have been dead since the branch
rename (main → `1.x`/`2.x` on 2026-08-12) — the first sync replaces them.

## Infrastructure

- **GitHub App "CoreShop CD Bot"** (to be created, org coreshop),
  credentials as org secrets `GH_APP_ID` / `GH_APP_PRIVATE_KEY`, made
  visible to all target repos. Permissions:

  | Level | Permission | Access | Purpose |
  |---|---|---|---|
  | Repository | Metadata | Read | Base (implicit), collaborator permission check |
  | Repository | Contents | Read & Write | File sync writes files/branches |
  | Repository | Workflows | Read & Write | File sync distributes into `.github/workflows/` |
  | Repository | Pull requests | Read & Write | Title/body autofix, draft conversion, sync PRs |
  | Repository | Issues | Read & Write | Issue lookup (R2), sticky/audit comments, label removal |
  | Repository | Checks | Read | Read check runs (R5) |
  | Repository | Commit statuses | Read | Read commit statuses (R5) |
  | Organization | Projects | Read & Write | Auto-add to the CoreShop Development board |

- **Rule logic + tests** go into `scripts/guardrails/` (ported from
  `cors-gmbh/shared-workflows` and adapted for R7 and the merge-up
  exception).
- **Versioning** as before: callers reference `@v1` (a tag, not a branch).
  The guardrail is a compatible addition ⇒ move `v1` forward; breaking
  changes ⇒ `v2`. Legacy callers still referencing `@main` are switched to
  `@v1` by the sync.

## Rollout

1. Create the GitHub App and install it in all target repos, set the org
   secrets (manual, org owner).
2. Merge reusable workflows + scripts + templates + sync into this repo,
   move `v1` forward.
3. Merge the open Pimcore 12 migration PRs (`update/pimcore-12`, all 14
   bundles) **before** the enforce rollout — they violate R1/R2.
4. Run the sync, merge the sync PRs in the target repos.
5. Fix the triggers of repo-owned extra workflows that are not covered by
   the sync (b2b-company `behat_ui.yml`, headless `behat.yml`): `main` →
   `'*.x'`.
6. Create the `guardrail-bypass` label in the target repos (optional, so it
   shows up in the label picker).
