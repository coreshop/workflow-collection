// Pure rule evaluation for the PR guardrail.
//
// Everything in this module is side-effect free: input is a plain object
// describing the PR (title, body, branch, base branch, issue state, check
// states), output is a list of violations plus the repair actions (title
// autofix, closing reference). All API access lives in github.mjs; the
// orchestration lives in run-guardrail.mjs. This keeps every rule
// unit-testable with node:test.
//
// Violation shape: { rule: 'R1', title: string, message: string, action: string }
// `message` and `action` are developer-facing texts that end up in the
// sticky PR comment.
//
// Every rule is evaluated on its own and reported on its own: a failed rule
// never hides the result of another one, so a single comment shows
// everything that has to be fixed.

/** All rules in the order the sticky comment lists them. */
export const RULES = Object.freeze([
  Object.freeze({ rule: 'R1', title: 'Branch name' }),
  Object.freeze({ rule: 'R2', title: 'Linked issue' }),
  Object.freeze({ rule: 'R3', title: 'Title' }),
  Object.freeze({ rule: 'R4', title: 'Description' }),
  Object.freeze({ rule: 'R5', title: 'CI' }),
  Object.freeze({ rule: 'R6', title: 'Closing reference' }),
  Object.freeze({ rule: 'R7', title: 'Base branch' }),
  Object.freeze({ rule: 'R8', title: 'Release milestone' }),
])

export const DEFAULT_CONFIG = Object.freeze({
  enforce: false,
  minBodyChars: 50,
  requireIssueOpen: true,
  // Case-insensitive. Capture group 1 must contain the issue number.
  // A descriptive suffix after the number is allowed (issue/123-dam-import).
  branchPattern: String.raw`^issue/(\d+)(?:-.*)?$`,
  // Base branches PRs must target (R7). Also identifies merge-up PRs whose
  // head is itself a version branch. Empty string disables R7.
  versionBranchPattern: String.raw`^\d+\.x$`,
  // Head branches that are a merge-up although they are not named after a
  // version branch — the org's upmerge convention (`upmerge/2.x_2026.x`, as
  // used by coreshop/CoreShop). Empty string disables the extra pattern.
  mergeUpBranchPattern: String.raw`^upmerge/`,
  // Head branches of release PRs (`release/5.1.0`, as used by
  // coreshop/CoreShop). Case-insensitive. Capture group 1 must contain the
  // released version; R8 requires a milestone of that name. Empty string
  // disables release detection (and with it R8).
  releaseBranchPattern: String.raw`^release/(\d+(?:\.\d+)+(?:-[0-9A-Za-z.]+)?)$`,
  titleTemplate: '#{number} {issueTitle}',
  bots: Object.freeze(['renovate[bot]', 'dependabot[bot]', 'github-actions[bot]']),
  botRequireBody: false,
  bypassLabel: 'guardrail-bypass',
})

// --- R1: branch name ---------------------------------------------------------

/**
 * Extract the issue number from a head branch name.
 * Returns a positive integer or null when the branch does not follow the
 * pattern (including `issue/0`, which can never be a valid issue number).
 */
export function extractIssueNumber(branch, branchPattern = DEFAULT_CONFIG.branchPattern) {
  const re = new RegExp(branchPattern, 'i')
  const match = re.exec(branch ?? '')
  if (!match || match[1] === undefined) return null
  const number = Number.parseInt(match[1], 10)
  return Number.isInteger(number) && number > 0 ? number : null
}

/** R1 — the head branch must match `issue/<number>` (case-insensitive). */
export function checkBranch({ branch, branchPattern = DEFAULT_CONFIG.branchPattern }) {
  const issueNumber = extractIssueNumber(branch, branchPattern)
  if (issueNumber !== null) return { issueNumber, violation: null }
  return {
    issueNumber: null,
    violation: {
      rule: 'R1',
      title: 'Branch name',
      message: `Branch \`${branch ?? ''}\` does not follow the \`issue/<number>\` scheme.`,
      action:
        'Rename the branch to `issue/<issue-number>` (e.g. `issue/123` or `issue/123-dam-import`) and reopen the PR. The number must point to an issue in this repository.',
    },
  }
}

// --- R2: issue exists (and is open) -------------------------------------------

/**
 * R2 — the issue referenced by the branch must exist in the same repository.
 * `issue` is the normalized lookup result:
 *   { exists: boolean, isPullRequest: boolean, state: 'OPEN'|'CLOSED'|null, title: string|null }
 * A number that resolves to a pull request is NOT a valid issue. Without an
 * issue number (R1 failed) there is nothing to look up, which fails R2 too.
 */
export function checkIssue({ issueNumber, issue, requireIssueOpen = DEFAULT_CONFIG.requireIssueOpen }) {
  if (!issueNumber) {
    return {
      rule: 'R2',
      title: 'Linked issue',
      message: 'The branch name carries no issue number, so the PR is not linked to an issue.',
      action:
        'Name the branch after an open issue of this repository (see R1). Create the issue first if there is none yet.',
    }
  }
  if (!issue || !issue.exists) {
    return {
      rule: 'R2',
      title: 'Linked issue',
      message: `There is no issue #${issueNumber} in this repository.`,
      action:
        'Create the ticket as an issue in this repository first, or rename the branch after an existing issue.',
    }
  }
  if (issue.isPullRequest) {
    return {
      rule: 'R2',
      title: 'Linked issue',
      message: `#${issueNumber} is a pull request, not an issue.`,
      action: 'Use the number of an issue (ticket) in the branch name, not the number of a pull request.',
    }
  }
  if (requireIssueOpen && issue.state !== 'OPEN') {
    return {
      rule: 'R2',
      title: 'Linked issue',
      message: `Issue #${issueNumber} is closed.`,
      action:
        'Reopen the issue (if the work is still in progress) or link the PR to an open issue via a new branch.',
    }
  }
  return null
}

// --- R3: title autofix (a repair, not a violation) -----------------------------

// Normalization intentionally maps spaces/underscores/hyphens onto one
// separator so that GitHub's auto-generated PR title for a branch
// (`issue/123-dam-import` -> "Issue/123 dam import") still counts as
// "title consists only of the branch name".
function normalizeForComparison(value) {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
}

/** True when the PR title is nothing but the branch name (see normalizeForComparison). */
export function isBranchNameTitle(title, branch) {
  return normalizeForComparison(title) === normalizeForComparison(branch)
}

/**
 * R3 without a valid issue: a title that is only the branch name cannot be
 * repaired, because the issue title to put there is unknown.
 */
export function checkTitle({ title, branch }) {
  if (!isBranchNameTitle(title, branch)) return null
  return {
    rule: 'R3',
    title: 'Title',
    message:
      'The PR title is only the branch name. The guardrail replaces it with the issue title, but only once the PR is linked to a valid issue (R1/R2).',
    action: 'Fix R1/R2 and the title is set automatically, or give the PR a title that says what it changes.',
  }
}

/** Render the `title-template` input. Placeholders: {number}, {issueTitle}. */
export function renderTitleTemplate(template, { number, issueTitle }) {
  return template.replaceAll('{number}', String(number)).replaceAll('{issueTitle}', issueTitle)
}

/**
 * R3 — if the PR title consists solely of the branch name (case-insensitive),
 * replace it with the issue title formatted via the template. Any other title
 * is left untouched — the guardrail never "improves" human-written titles.
 * Returns the new title or null.
 */
export function titleAutofix({
  title,
  branch,
  issueNumber,
  issueTitle,
  titleTemplate = DEFAULT_CONFIG.titleTemplate,
}) {
  if (!issueNumber || !issueTitle) return null
  if (!isBranchNameTitle(title, branch)) return null
  const fixed = renderTitleTemplate(titleTemplate, { number: issueNumber, issueTitle })
  return fixed === title ? null : fixed
}

// --- R4: description ----------------------------------------------------------

/**
 * Strip template noise from a PR body: HTML comments, markdown headings and
 * unchecked checkbox lines. What remains (collapsed whitespace) counts as
 * prose for the `min-body-chars` threshold.
 */
export function strippedBody(body) {
  return (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^[ \t]*#{1,6}[ \t]+.*$/gm, ' ')
    .replace(/^[ \t]*[-*+][ \t]+\[ \][ \t]*.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** R4 — the PR body must contain at least `minBodyChars` characters of prose. */
export function checkBody({ body, minBodyChars = DEFAULT_CONFIG.minBodyChars }) {
  const text = strippedBody(body)
  if (text.length >= minBodyChars) return null
  return {
    rule: 'R4',
    title: 'Description',
    message: `After stripping template noise (HTML comments, headings, empty checkboxes) the PR description contains only ${text.length} of at least ${minBodyChars} characters of prose.`,
    action:
      'Briefly describe in the PR body **what** changed and **why**. Template headings and unchecked checkboxes do not count as description.',
  }
}

// --- R5: CI (check runs, commit statuses, merge conflicts) ---------------------

/**
 * Map the GraphQL statusCheckRollup context nodes onto the neutral shape the
 * rule works with:
 *   { name, kind: 'check'|'status', state: 'success'|'failure'|'pending', url: string|null }.
 * Only definitive failures (FAILURE, CANCELLED, TIMED_OUT, STARTUP_FAILURE,
 * ERROR) map to 'failure'; everything unfinished or undecided is 'pending'.
 * `url` points at the log of the job (check run) or the external CI page
 * (commit status).
 */
export function normalizeCheckContexts(nodes = []) {
  const result = []
  for (const node of nodes) {
    if (!node || !node.__typename) continue
    if (node.__typename === 'CheckRun') {
      result.push({ name: node.name, kind: 'check', state: checkRunState(node), url: node.detailsUrl ?? null })
    } else if (node.__typename === 'StatusContext') {
      result.push({
        name: node.context,
        kind: 'status',
        state: statusContextState(node.state),
        url: node.targetUrl ?? null,
      })
    }
  }
  return result
}

function checkRunState(node) {
  if (node.status !== 'COMPLETED') return 'pending'
  switch (node.conclusion) {
    case 'SUCCESS':
    case 'NEUTRAL':
    case 'SKIPPED':
      return 'success'
    case 'FAILURE':
    case 'CANCELLED':
    case 'TIMED_OUT':
    case 'STARTUP_FAILURE':
      return 'failure'
    default:
      // ACTION_REQUIRED, STALE, null — not a definitive failure.
      return 'pending'
  }
}

function statusContextState(state) {
  switch (state) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    default:
      // PENDING, EXPECTED
      return 'pending'
  }
}

// Check names and URLs come from whatever workflow or app reported them —
// on a fork PR that is code the contributor controls. Keep a backtick from
// ending the code span and only link plain https URLs.
function codeSpan(text) {
  return `\`${String(text ?? '').replaceAll('`', "'")}\``
}

function safeUrl(url) {
  return typeof url === 'string' && /^https:\/\/[^\s<>]+$/.test(url) ? url : null
}

/**
 * One list line per failed check name. Matrix jobs of different workflows
 * can share a name (`Chunk 1, PHP 8.4, …` in Packages Bundles and Packages
 * Components); they are grouped on one line with a link per job instead of
 * repeating the same text.
 */
function failedCheckLines(failed) {
  const byName = new Map()
  for (const check of failed) {
    if (!byName.has(check.name)) byName.set(check.name, [])
    byName.get(check.name).push(safeUrl(check.url))
  }
  const lines = []
  for (const [name, urls] of byName) {
    const links = urls.filter(Boolean)
    if (urls.length === 1 && links.length === 1) {
      lines.push(`- [${codeSpan(name)}](<${links[0]}>)`)
    } else if (links.length > 0) {
      lines.push(`- ${codeSpan(name)} — ${links.map((url, i) => `[job ${i + 1}](<${url}>)`).join(', ')}`)
    } else {
      lines.push(`- ${codeSpan(name)}${urls.length > 1 ? ` (${urls.length}×)` : ''}`)
    }
  }
  return lines
}

/**
 * R5 — every check run / commit status on the head SHA must succeed and the
 * PR must be free of merge conflicts.
 *
 * Semantics required by the rollout plan:
 *   - a definitive failure is a violation immediately, even while other
 *     checks are still running;
 *   - checks that are merely pending (or mergeable UNKNOWN) never produce a
 *     violation — the guardrail waits for the next check_suite/status event;
 *   - the guardrail's own check runs (ownCheckNames) are excluded, otherwise
 *     a failed guardrail run would keep the PR red forever;
 *   - every failed check is listed, each linked to its log, so one round
 *     shows everything that has to be fixed.
 *
 * Returns { violations, pending }.
 */
export function checkCi({ checks = [], mergeable = 'UNKNOWN', ownCheckNames = [] }) {
  const own = new Set(ownCheckNames)
  const relevant = checks.filter((c) => !own.has(c.name))
  const failed = relevant.filter((c) => c.state === 'failure')
  const pending = relevant.some((c) => c.state === 'pending') || mergeable === 'UNKNOWN'

  const violations = []
  if (failed.length > 0) {
    const heading =
      failed.length === 1 ? '1 check failed on the current head:' : `${failed.length} checks failed on the current head:`
    violations.push({
      rule: 'R5',
      title: 'CI',
      message: [heading, '', ...failedCheckLines(failed)].join('\n'),
      action:
        'Fix the failed checks and push the fix. The guardrail re-evaluates automatically once CI completes.',
    })
  }
  if (mergeable === 'CONFLICTING') {
    violations.push({
      rule: 'R5',
      title: 'Merge conflict',
      message: 'The PR has merge conflicts with the base branch.',
      action: 'Merge the base branch into your branch (or rebase) and resolve the conflicts.',
    })
  }
  return { violations, pending }
}

// --- R6: closing reference (a repair, not a violation) --------------------------

const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+/i

function hasClosingKeywordFor(body, issueNumber) {
  const re = new RegExp(`${CLOSING_KEYWORD.source}#${issueNumber}\\b`, 'i')
  return re.test(body ?? '')
}

/**
 * R6 — make sure GitHub links the PR to the issue from R1 (Development
 * sidebar, Projects automation). If neither the resolved
 * closingIssuesReferences nor a closing keyword in the body reference the
 * issue, return the line to append; otherwise null.
 */
export function closingReference({ body, issueNumber, linkedIssueNumbers = [] }) {
  if (!issueNumber) return null
  if (linkedIssueNumbers.includes(issueNumber)) return null
  if (hasClosingKeywordFor(body, issueNumber)) return null
  return `Closes #${issueNumber}`
}

/**
 * R6 without a valid issue: the reference cannot be appended, so the PR stays
 * unlinked unless the body already closes some issue on its own.
 */
export function checkClosingReference({ body, linkedIssueNumbers = [] }) {
  if (linkedIssueNumbers.length > 0) return null
  if (new RegExp(`${CLOSING_KEYWORD.source}#\\d+\\b`, 'i').test(body ?? '')) return null
  return {
    rule: 'R6',
    title: 'Closing reference',
    message:
      'The PR body does not close any issue (`Closes #<number>`), and the guardrail can only add the reference once the PR is linked to a valid issue (R1/R2).',
    action: 'Fix R1/R2 and the reference is appended automatically, or add `Closes #<number>` to the PR body.',
  }
}

// --- R7: base branch is a version branch ----------------------------------------

/** True when the branch name matches the version-branch pattern (e.g. `2.x`). */
export function isVersionBranch(branch, versionBranchPattern = DEFAULT_CONFIG.versionBranchPattern) {
  if (!versionBranchPattern) return false
  return new RegExp(versionBranchPattern).test(branch ?? '')
}

/**
 * R7 — the PR must target a version branch. An empty pattern disables the
 * rule (repos without version branches).
 */
export function checkBaseBranch({ baseBranch, versionBranchPattern = DEFAULT_CONFIG.versionBranchPattern }) {
  if (!versionBranchPattern) return null
  if (isVersionBranch(baseBranch, versionBranchPattern)) return null
  return {
    rule: 'R7',
    title: 'Base branch',
    message: `The PR targets \`${baseBranch ?? ''}\`, which is not a version branch (pattern: \`${versionBranchPattern}\`).`,
    action:
      'Change the base branch of the PR to the version branch the change belongs to (e.g. `2.x` for the next major, or the maintained branch for a bugfix).',
  }
}

// --- Merge-up detection ---------------------------------------------------------

/**
 * True when the head branch belongs to a merge-up PR: either a version
 * branch merged forward directly (`1.x` -> `2.x`) or a branch following the
 * org's upmerge convention (`upmerge/2.x_2026.x`, title `[UPMERGE] …`).
 *
 * Detection is deliberately branch-only. The title is not part of the
 * condition: it is editable by anyone who can open the PR and therefore adds
 * no guarantee the branch name does not already give, while a second
 * required marker would turn a mistyped title into a guardrail failure. The
 * head branch also names what is actually being merged, which the title does
 * not have to.
 */
export function isMergeUpBranch(
  branch,
  {
    versionBranchPattern = DEFAULT_CONFIG.versionBranchPattern,
    mergeUpBranchPattern = DEFAULT_CONFIG.mergeUpBranchPattern,
  } = {},
) {
  if (isVersionBranch(branch, versionBranchPattern)) return true
  if (!mergeUpBranchPattern) return false
  return new RegExp(mergeUpBranchPattern, 'i').test(branch ?? '')
}

// --- Release detection + R8: milestone ------------------------------------------

/**
 * Extract the released version from a release head branch (`release/5.1.0`
 * -> `5.1.0`). Returns null when the branch is not a release branch or the
 * pattern is disabled.
 */
export function extractReleaseVersion(branch, releaseBranchPattern = DEFAULT_CONFIG.releaseBranchPattern) {
  if (!releaseBranchPattern) return null
  const match = new RegExp(releaseBranchPattern, 'i').exec(branch ?? '')
  if (!match || !match[1]) return null
  return match[1]
}

/**
 * True when the head branch belongs to a release PR (`release/<version>`,
 * title `[Release] <version>` by convention). Like the merge-up detection
 * this is branch-only: the title is not part of the condition.
 */
export function isReleaseBranch(branch, releaseBranchPattern = DEFAULT_CONFIG.releaseBranchPattern) {
  return extractReleaseVersion(branch, releaseBranchPattern) !== null
}

// A leading "v" on the milestone is tolerated (`v5.1.0` releases `5.1.0`).
function normalizeVersion(value) {
  return (value ?? '').trim().replace(/^v/i, '')
}

/**
 * R8 — a release PR must carry the milestone of the version it releases.
 * The milestone is what the release closes, so a release PR without one (or
 * with the wrong one) would leave the milestone open or close the wrong one.
 * `milestone` is the milestone title or null.
 */
export function checkMilestone({ version, milestone }) {
  if (!milestone) {
    return {
      rule: 'R8',
      title: 'Release milestone',
      message: `The release PR for \`${version}\` has no milestone.`,
      action: `Assign the milestone \`${version}\` to the PR (create it first if it does not exist yet). The milestone is closed with the release.`,
    }
  }
  if (normalizeVersion(milestone) !== normalizeVersion(version)) {
    return {
      rule: 'R8',
      title: 'Release milestone',
      message: `The release PR for \`${version}\` carries the milestone \`${milestone}\`, which does not match the released version.`,
      action: `Assign the milestone \`${version}\` to the PR, or rename the branch after the version the milestone stands for.`,
    }
  }
  return null
}

// --- Bot detection --------------------------------------------------------------

// GraphQL reports bot authors without the "[bot]" suffix ("renovate"), REST
// and webhook payloads with it ("renovate[bot]") — normalize both sides.
function normalizeLogin(login) {
  return (login ?? '').toLowerCase().replace(/\[bot\]$/, '')
}

export function isBotAuthor(login, bots = DEFAULT_CONFIG.bots) {
  const normalized = normalizeLogin(login)
  return normalized !== '' && bots.some((bot) => normalizeLogin(bot) === normalized)
}

// --- Master evaluation ------------------------------------------------------------

/**
 * Evaluate all rules against a fact object. Pure — the caller is responsible
 * for gathering the facts and applying the resulting actions.
 *
 * @param {object} facts
 * @param {string} facts.branch            head branch name
 * @param {string} facts.baseBranch        base branch name (R7, merge-up detection)
 * @param {string} facts.title             PR title
 * @param {string|null} facts.body         PR body
 * @param {string} facts.authorLogin       PR author login
 * @param {object|null} facts.issue        normalized issue lookup (see checkIssue)
 * @param {Array}  facts.checks            normalized check states (see normalizeCheckContexts)
 * @param {string} facts.mergeable         'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
 * @param {string[]} facts.ownCheckNames   check-run names of the guardrail itself
 * @param {number[]} facts.linkedIssueNumbers  issues already linked via closing references
 * @param {string|null} facts.milestone    milestone title (R8)
 * @param {object} config                  see DEFAULT_CONFIG
 *
 * `ruleResults` holds one entry per rule of RULES, in that order:
 *   { rule, title, status: 'pass'|'fail'|'pending'|'repaired'|'skipped', note: string|null }
 * `violations` holds the details of every rule with status 'fail' (R5 can
 * contribute two: failed checks and a merge conflict), in the same order.
 *
 * @returns {{ isBot: boolean, isMergeUp: boolean, isRelease: boolean,
 *             releaseVersion: string|null, issueNumber: number|null,
 *             ruleResults: Array, violations: Array, ciPending: boolean,
 *             titleFix: string|null, appendClosing: string|null }}
 */
export function evaluate(facts, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const isBot = isBotAuthor(facts.authorLogin, cfg.bots)
  // Merge-up PRs (a version branch merged forward directly, or an
  // `upmerge/<from>_<to>` branch) carry no issue by nature, so R1/R2/R6 and
  // the title autofix are skipped.
  const isMergeUp = isMergeUpBranch(facts.branch, {
    versionBranchPattern: cfg.versionBranchPattern,
    mergeUpBranchPattern: cfg.mergeUpBranchPattern,
  })
  // Release PRs (`release/<version>`) are the other issue-less PR type of the
  // release process: the changelog diff is their description. They skip the
  // same rules as a merge-up and are held to R8 (milestone) instead.
  const releaseVersion = extractReleaseVersion(facts.branch, cfg.releaseBranchPattern)
  const isRelease = releaseVersion !== null
  const results = new Map()
  let issueNumber = null
  let titleFix = null
  let appendClosing = null

  const fail = (...violations) => ({ status: 'fail', note: null, violations })
  const pass = () => ({ status: 'pass', note: null, violations: [] })
  const skip = (note) => ({ status: 'skipped', note, violations: [] })
  const repaired = (note) => ({ status: 'repaired', note, violations: [] })
  const outcome = (violation) => (violation ? fail(violation) : pass())

  // Bot PRs (Renovate, Dependabot, the CD bot's sync PRs, ...) have no
  // issue/<n> branches and no tickets: R1-R3 and R6 are skipped by design.
  const issueLess = isRelease ? 'release PR' : isMergeUp ? 'merge-up PR' : isBot ? 'bot PR' : null
  if (issueLess) {
    for (const rule of ['R1', 'R2', 'R3', 'R6']) results.set(rule, skip(issueLess))
  } else {
    const branchResult = checkBranch({ branch: facts.branch, branchPattern: cfg.branchPattern })
    issueNumber = branchResult.issueNumber
    results.set('R1', outcome(branchResult.violation))

    const issueViolation = checkIssue({
      issueNumber,
      issue: facts.issue,
      requireIssueOpen: cfg.requireIssueOpen,
    })
    results.set('R2', outcome(issueViolation))

    if (issueViolation) {
      // Without a valid issue the repairs cannot run; whatever they would
      // have fixed is reported instead of silently left as it is.
      results.set('R3', outcome(checkTitle({ title: facts.title, branch: facts.branch })))
      results.set(
        'R6',
        outcome(checkClosingReference({ body: facts.body, linkedIssueNumbers: facts.linkedIssueNumbers ?? [] })),
      )
    } else {
      titleFix = titleAutofix({
        title: facts.title,
        branch: facts.branch,
        issueNumber,
        issueTitle: facts.issue?.title,
        titleTemplate: cfg.titleTemplate,
      })
      results.set('R3', titleFix ? repaired('replaced with the issue title') : pass())
      appendClosing = closingReference({
        body: facts.body,
        issueNumber,
        linkedIssueNumbers: facts.linkedIssueNumbers ?? [],
      })
      results.set('R6', appendClosing ? repaired(`\`${appendClosing}\` appended`) : pass())
    }
  }

  if (isMergeUp || isRelease) {
    results.set('R4', skip(isRelease ? 'release PR' : 'merge-up PR'))
  } else if (isBot && !cfg.botRequireBody) {
    results.set('R4', skip('bot PR'))
  } else {
    results.set('R4', outcome(checkBody({ body: facts.body, minBodyChars: cfg.minBodyChars })))
  }

  // R5 applies to everyone, bots included.
  const ci = checkCi({
    checks: facts.checks,
    mergeable: facts.mergeable,
    ownCheckNames: facts.ownCheckNames,
  })
  results.set(
    'R5',
    ci.violations.length > 0
      ? fail(...ci.violations)
      : ci.pending
        ? { status: 'pending', note: 'checks still running', violations: [] }
        : pass(),
  )

  // R7 applies to everyone — a merge-up or release must target a version branch too.
  results.set(
    'R7',
    cfg.versionBranchPattern
      ? outcome(checkBaseBranch({ baseBranch: facts.baseBranch, versionBranchPattern: cfg.versionBranchPattern }))
      : skip('disabled'),
  )

  // R8 replaces the issue link for release PRs: the milestone is what ties
  // the PR to the version it releases.
  results.set(
    'R8',
    isRelease
      ? outcome(checkMilestone({ version: releaseVersion, milestone: facts.milestone }))
      : skip('only for release PRs'),
  )

  const ruleResults = RULES.map(({ rule, title }) => {
    const { status, note } = results.get(rule)
    return { rule, title, status, note }
  })
  const violations = RULES.flatMap(({ rule }) => results.get(rule).violations)

  return {
    isBot,
    isMergeUp,
    isRelease,
    releaseVersion,
    issueNumber,
    ruleResults,
    violations,
    ciPending: ci.pending,
    titleFix,
    appendClosing,
  }
}
