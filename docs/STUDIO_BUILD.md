# Studio frontend build

`.github/workflows/studio-build.yml` is the one reusable workflow that builds the Pimcore
Studio plugins of the CoreShop core monorepo and of the bundle repos, and commits the
packaged builds back to the branch. `templates/studio-build.yml` is the caller synced into
the bundle repos; `templates/studio-build-core.yml` is the caller for coreshop/CoreShop
(not synced — the core has its own CI).

The convention is unchanged: **built assets are produced by CI, never by hand.** What is
committed changed with #29.

## The build archive model

The workflow follows Pimcore's own Studio build (pimcore/studio-ui-bundle#3779):

- **The build id is the identity of a build.** It is derived from the sources (the
  bundle's Studio sources plus the CoreShop Studio sources the rsbuild aliases inline from
  `vendor/`; the core derives its ids per bundle in `studio-build.ts`), so identical
  sources always yield the same id and any change bumps it.
- **The build is committed as one archive per bundle,
  `Resources/build-dist/build-<id>.zip`.** The expanded build under
  `Resources/public/studio/<id>/` is gitignored and reconstructed from the archive by
  Pimcore's `BuildArchiveExtractor` at `cache:warmup` (or lazily on first use while the
  directory is writable).
- **An existing archive for the current id is kept untouched.** The compiled output is
  not byte-reproducible — Rspack 1.x renders the Module Federation runtime data in
  hash-map order — so comparing bytes would produce a "changed" build on every run. With
  the id as identity, a commit only appears when the sources actually changed, which is
  what ended the churn of `Build Studio bundle` commits and the artifact conflicts on every
  upmerge (coreshop/CoreShop#3200).
- **Pull requests carry their own build.** The archive is committed for pushes and for
  pull requests from the same repository, so a pull request diff includes the archive of
  its sources and a release tag created right after a merge is complete. Pull requests
  from forks and manual runs build for verification only.

## Jobs

| Job | Token | What it does |
|---|---|---|
| `detect` | read | Finds the Studio npm project (bundles: `src/Resources/assets/pimcore-studio` or `src/Bundle/...`; core: `.`) and derives `output_path`, `archive_path` and `stage_pathspec` from it unless the caller passes them. Repos without a Studio project skip the build, so a bundle can be added to the sync group before its plugin lands. |
| `build` | read | Runs the repository code: optional `composer install`, `install_command`, advisory or blocking `npm run check-types`, the build id, `build_command`, packaging, then stages `stage_pathspec` and uploads the staged diff as a patch artifact. |
| `commit` | write | Runs **no** repository code: applies the patch on the branch and pushes it as `Build Studio bundle`. Gated to pushes and same-repository pull requests. Uses the `STUDIO_BUILD_APP_*` installation token where configured (coreshop/CoreShop, whose version branches carry a ruleset), `GITHUB_TOKEN` otherwise. A refused push fails the job unless the branch simply moved on during the build. |

Splitting build and commit is what keeps a fork's code away from the write-capable token
— the same structure Pimcore's reusable workflow uses.

## Packaging

For the bundles the `build` job writes `.build-id` into `<output_path>/<id>/` and runs
`studio-package-build --build-dir <output_path> --out-dir <archive_path>`, the bin that
`@pimcore/studio-ui-bundle` ships since 2025.4.12 / 2026.2.x. It keeps an existing archive
for the id, removes stray archives of other ids, and writes sorted entries with fixed
timestamps. A Studio project whose `node_modules` has no such bin is packaged by an
equivalent shell fallback (with a warning annotation asking to add the dependency).

The core passes `package: false`: `npm run build` (`studio-build.ts`) builds all bundles
and packages each of them itself; the workflow only stages and commits what it produced.

## Inputs

| Input | Default | Core passes |
|---|---|---|
| `commit` | `false` | `push` or same-repo pull request (see the templates) |
| `assets_path` | detected (`src/Resources/assets/pimcore-studio` or `src/Bundle/...`) | `.` |
| `output_path` | `<root>/Resources/public/studio` | — |
| `archive_path` | `<root>/Resources/build-dist` | — |
| `stage_pathspec` | `<archive_path>/*` | `src/CoreShop/Bundle/*/Resources/build-dist/*` |
| `composer` | `true` | `false` |
| `install_command` | `npm install --ignore-scripts --no-audit --no-fund` | `npm ci --ignore-scripts` |
| `build_command` | `npx rsbuild build` | `npm run build` |
| `package` | `true` | `false` |
| `typecheck_blocking` | `false` (bundles inherit TS2307 noise from the aliased `@coreshop/*` sources) | `true` |
| `node_version` | `22` | — |
| `php_version` | `8.3` (the synced template passes `8.4`, see GUARDRAILS.md "PHP and Pimcore versions") | — |
| `php_extensions`, `composer_command`, `runs_on` | as before | — |

## What a consuming repository needs

The workflow only commits the archive. Serving it needs three things in the repository:

1. **The entry point provider** implements
   `Pimcore\Bundle\StudioUiBundle\Build\BuildArchiveProviderInterface` via
   `BuildArchiveExtractionTrait` and names the archive and its target:

   ```php
   use Pimcore\Bundle\StudioUiBundle\Build\BuildArchive;
   use Pimcore\Bundle\StudioUiBundle\Build\BuildArchiveExtractionTrait;
   use Pimcore\Bundle\StudioUiBundle\Build\BuildArchiveProviderInterface;

   final class WebpackEntryPointProvider implements BuildArchiveProviderInterface
   {
       use BuildArchiveExtractionTrait;

       protected function buildArchive(): BuildArchive
       {
           return new BuildArchive(
               archiveGlob: __DIR__ . '/../Resources/build-dist/build*.zip',
               targetDir: __DIR__ . '/../Resources/public/studio',
           );
       }

       // getEntryPoints() / getOptionalEntryPoints() as before; drop the glob-based
       // getEntryPointsJsonLocations(), the trait provides it.
   }
   ```

   The trait receives the extractor through a `#[Required]` setter, so the provider must
   be autowired or its service definition needs the `setBuildArchiveExtractor` call.
   Pimcore's `StudioBuildCacheWarmer` iterates all entry point providers and extracts every
   `BuildArchiveProviderInterface`, so no cache warmer of your own is needed. The classes
   ship with `pimcore/studio-ui-bundle` **≥ 2025.4.9** (5.x line) / **≥ 2026.2.1** — raise
   the composer floor accordingly (Pimcore's own upgrade note says 2025.4.6, which is too
   low).

2. **Git attributes and ignores** (paths per layout):

   ```gitattributes
   src/Resources/build-dist/build-*.zip linguist-generated=true
   src/Resources/build-dist/build-*.zip binary
   src/Resources/build-dist/build-*.zip merge=ours
   ```

   ```gitignore
   src/Resources/public/studio/*
   src/Resources/public/.studio*
   ```

   `merge=ours` takes the current side's archive wholesale on merges instead of
   conflicting; the next build on the merged branch produces the right archive anyway.
   The previously committed expanded build is deleted once.

3. **Deployment note for the changelog / upgrade file:** read-only deployments must run
   `bin/console cache:warmup` (or `cache:clear`) during the build/deploy phase while
   `vendor/` is still writable — standard Pimcore deployments already do this. When
   `assets:install` runs in copy mode, run `cache:warmup` before it.

## Bundle specifics

- The npm project sits under the bundle's PSR-4 root and its rsbuild config aliases
  `@coreshop/*` into `vendor/coreshop/core-shop`, so the workflow runs `composer install`
  (`imap` extension included for inbound-email-rules) before the frontend build.
- The bundles gitignore their npm lock file (it holds `file:` paths into `vendor/`), so
  dependencies are installed with `npm install`, not `npm ci`.
- The bundles' local `npm run build` script uses a random build id, which would rewrite
  every asset path on every build, so the workflow calls `npx rsbuild build` directly with
  `CORESHOP_BUILD_ID` set to the derived id.
- `detect` resolves the paths because the plugin sits under `src` in most repos and under
  `src/Bundle` in others (ticketing, headless); the caller is a synced file, so a local
  override would be overwritten by the next sync run.
