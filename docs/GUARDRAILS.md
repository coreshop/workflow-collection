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
`.github/sync.yml`. Three kinds of files are synced:

1. **Guardrail caller, issues-to-project caller + PR template** (enforce or
   OSS variant per group).
2. **Test workflows** — the minimal setup per bundle repo:
   - `static.yaml` — static analysis (all bundle repos)
   - `behat_domain.yml` — Behat domain suite, only for repos that have
     Behat tests (currently b2b-company and ticketing). The bundle class
     name (`run-bundle-installer`, e.g. `CoreShopB2BCompanyBundle`) is
     injected via the sync action's **templating** feature, which is why
     each Behat repo has its own sync group.
3. **Studio frontend build** — `studio-build.yml`, for the bundle repos that
   ship a Pimcore Studio plugin. See the next section.

**Extensible:** repos can add their own workflows next to the synced ones
(e.g. `behat_ui.yml` with the UI profile) — the sync only overwrites the
files it manages. Note: repo-owned extra workflows (b2b-company
`behat_ui.yml`, headless `behat.yml`) still trigger on `main` and must be
switched to `*.x` manually — see rollout.

**Important — trigger branches:** the synced workflows trigger on version
branches (`'*.x'`), **not** on `main`. The legacy callers in the bundle
repos still listen on `branches: [main]` and have been dead since the branch
rename (main → `1.x`/`2.x` on 2026-08-12) — the first sync replaces them.

## Studio frontend build

`.github/workflows/studio-build.yml` builds a bundle's Pimcore Studio plugin;
`templates/studio-build.yml` is the caller synced into the bundle repos. It
mirrors coreshop/CoreShop's `shared-frontend-build.yaml`, so the bundles follow
the same convention: **built assets are produced by CI, not committed by hand.**

- **Pull request** → `verify` job: `check-types` (if the bundle defines the
  script) plus the production build, nothing committed. PR diffs stay
  source-only.
  The type check is **advisory** (`continue-on-error`): the bundles inherit
  ~100 TS2307 errors from the aliased `@coreshop/*` sources in `vendor/`,
  which resolve their imports against the CoreShop monorepo's
  `node_modules` and therefore cannot be fixed from a bundle repo. The
  production build is the gate; type errors surface as a warning annotation.
- **Push to a version branch** (`'*.x'`) → `build` job: builds and commits the
  assets under `src/Resources/public/studio/<build-id>/` as
  `github-actions[bot]`, message `Build Studio bundle`. `paths-ignore` on that
  directory keeps the commit from triggering another build.

Bundle specifics that differ from the core monorepo:

- The npm project sits in `src/Resources/assets/pimcore-studio` and its rsbuild
  config aliases `@coreshop/*` into `vendor/coreshop/core-shop`, so the workflow
  runs `composer install` (`imap` extension included for
  inbound-email-rules) **before** the frontend build. One PHP version is
  enough, since only the vendor sources are needed; the caller passes it (see
  "PHP versions" below).
- The bundles gitignore their npm lock file (it holds `file:` paths into
  `vendor/`), so dependencies are installed with `npm install`, not `npm ci`.
- The build id is derived in the workflow as a sha256 over the bundle's Studio
  sources plus the CoreShop Studio sources from `vendor/` — the same
  deterministic-id idea as `studio-build.ts` in the core. The bundles' local
  `npm run build` script uses a random UUID, which would rewrite every asset
  path on every build, so the workflow calls `npx rsbuild build` directly with
  `CORESHOP_BUILD_ID` set.
- **Token:** the bundles' version branches carry no ruleset, so the commit is
  pushed with `GITHUB_TOKEN` and the caller's `contents: write`. If
  `STUDIO_BUILD_APP_ID` / `STUDIO_BUILD_APP_PRIVATE_KEY` are configured (they
  are repo secrets on coreshop/CoreShop, whose release branches *are*
  protected), the workflow uses that app's installation token instead. A
  refused push fails the job unless the branch simply moved on during the
  build.
- Repos without `src/Resources/assets/pimcore-studio` skip the build via the
  `detect` job, so a bundle can be added to the sync group before its plugin
  lands.
- The `assets_path` / `output_path` defaults assume the common `src/Resources`
  layout. A bundle whose sources sit elsewhere (ticketing has `src/Bundle/…`)
  must pass both inputs in its caller. That is one of the few legitimate
  reasons to deviate from the synced template — and since a sync run
  overwrites the file, such a repo needs the deviation re-applied, or the
  template needs a per-repo sync group.

## Installing Pimcore 12 vs 2026 (`behat.yml`)

`behat.yml` serves callers on both release lines, so a "Determine the Pimcore
major version" step derives the major from the matrix entry (comparing the
leading number, which holds for `^2026.1`, `~2026.1` and `2026.1.*` alike) and
every step that differs gates on it. `>= 2026` gets:

- **An OpenSearch client config** (`config/local/opensearch.yaml`) written
  before the install, because a 2026 install brings up the Generic Data Index
  and talks to OpenSearch during the install itself.
- **The profile-based installer.** Pimcore 2026.1 replaced the installer's
  flags: `--skip-database-config` no longer exists, and the bundles plus the
  env-var definitions come from an install profile —
  `--install-profile 'CoreShop\Bundle\CoreBundle\InstallProfile\CoreShopInstallProfile'
  --skip-validation`. No `--env`: `APP_ENV=test` from the job env already
  selects the environment.
- **`pimcore:deployment:classes-rebuild --force --create-classes` and
  `generic-data-index:update:index -r`** before `coreshop:install`. The profile
  registers the Studio and Generic Data Index bundles but does not deploy the
  class definitions or create the search index, so anything writing objects
  fails without these.

Everything below 2026 keeps the Pimcore 12 invocation unchanged. All of it is
taken from coreshop/CoreShop's own `behat.yml` on 2026.x — same OpenSearch
image, same DSN, same command order — so the bundles install Pimcore exactly
the way the core does.

The one part that cannot be conditional is the **OpenSearch service
container** (GitHub Actions has no `if:` on `services`), so it starts for
`^12.*` entries too, where it sits idle. `PIMCORE_OPENSEARCH_DSN` is likewise
a plain job env var, unread on 12.

## `secrets: inherit` is mandatory in every caller

A called workflow gets **no** secrets by default, so a caller without
`secrets: inherit` reaches `static.yml` / `behat.yml` with `PIMCORE_SECRET`
and friends empty. Pimcore 12.3 tolerated an empty encryption secret; 2026.1
aborts the container compile with `` `pimcore.encryption.secret` is not set ``,
which reads like a bundle config problem and is not one. `static.yml` and
`behat.yml` therefore fail fast with a step that names the missing
`secrets: inherit`.

All synced templates carry it. Repo-owned workflows next to the synced ones
(b2b-company `behat_ui.yml`, headless `behat.yml`, the `cla-check.yaml`
callers) are **not** covered by the sync and have to be fixed in the repo —
`cla.yaml` reads `secrets.CLA_ACTION_ACCESS_TOKEN`, so its callers need it
too.

## PHP versions

The reusable workflows default to the CoreShop 5 matrix (`static.yml`,
`behat.yml`: `["8.3", "8.4"]`; `studio-build.yml`: `8.3`). A release line's
matrix does **not** belong in those defaults — it belongs in the caller, and
the synced templates set it: `templates/static.yml` passes
`php_versions: '["8.4", "8.5"]'` and `templates/studio-build.yml` passes
`php_version: '8.4'`, matching CoreShop 2026.1's `~8.4 || ~8.5` and
coreshop/CoreShop's own 2026.x matrix.

This works because the sync only writes to a repo's **default branch**, which
is the current development line (2026.x). Older release branches keep the
caller they were synced with, so bumping the templates never changes their
matrix. When the development line moves on, the templates are updated and the
next sync carries the new matrix into every default branch.

Bundles must therefore **not** override the matrix locally: a local deviation
in a synced file is overwritten by the next sync run.

`templates/behat-domain.yml` is still on the reusable default and needs the
same treatment (plus `pimcore_versions`) once the Behat repos — b2b-company
and ticketing — are migrated to 2026.1.

## Releasing: moving the `v1` tag

Callers reference the reusable workflows by tag (`@v1`), so **a merge to
`main` changes nothing for them.** Every change under `.github/workflows/**`
needs a release, or the callers keep running the old code — or, for a newly
added workflow, fail with "workflow file issue" and zero jobs because the
file does not exist at `v1` (this happened to `studio-build.yml`, see #11).

After merging such a change:

```sh
git fetch origin
git tag v1.<minor>.<patch> origin/main     # new immutable version tag
git tag -f v1 origin/main                  # move the major tag
git push origin v1.<minor>.<patch>
git push -f origin v1
```

`v1` is a moving major tag and always points at the newest `v1.x.y`
(`v1` == `v1.3.1` at the time of writing). Compatible changes move `v1`
forward; a breaking change gets a `v2` tag and the callers are switched by
the sync. The tags are moved by hand — nothing in CI does it.

## Infrastructure

- **Org secrets for the test workflows:** Pimcore 12 requires
  `PIMCORE_SECRET`, `PIMCORE_INSTANCE_IDENTIFIER` and `PIMCORE_PRODUCT_KEY`
  at container compile time. They live as coreshop org secrets; the synced
  callers pass them with `secrets: inherit` and `static.yml`/`behat.yml`
  export them as env (same pattern as the coreshop/CoreShop workflows).
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
  `@v1` by the sync. See "Releasing: moving the `v1` tag".

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
