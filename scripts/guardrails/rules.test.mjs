import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONFIG,
  checkBaseBranch,
  checkBody,
  checkBranch,
  checkCi,
  checkIssue,
  checkMilestone,
  closingReference,
  evaluate,
  extractIssueNumber,
  extractReleaseVersion,
  isBotAuthor,
  isMergeUpBranch,
  isReleaseBranch,
  isVersionBranch,
  normalizeCheckContexts,
  strippedBody,
  titleAutofix,
} from './rules.mjs'

// ---------------------------------------------------------------------------
// R1 — branch name
// ---------------------------------------------------------------------------

describe('R1: extractIssueNumber / checkBranch', () => {
  it('accepts issue/123', () => {
    assert.equal(extractIssueNumber('issue/123'), 123)
    assert.equal(checkBranch({ branch: 'issue/123' }).violation, null)
  })

  it('accepts a descriptive suffix: issue/123-short-description', () => {
    assert.equal(extractIssueNumber('issue/123-short-description'), 123)
  })

  it('is case-insensitive: Issue/123', () => {
    assert.equal(extractIssueNumber('Issue/123'), 123)
    assert.equal(extractIssueNumber('ISSUE/42-Foo_Bar'), 42)
  })

  it('rejects issue/0 (no valid issue number)', () => {
    assert.equal(extractIssueNumber('issue/0'), null)
    assert.equal(checkBranch({ branch: 'issue/0' }).violation.rule, 'R1')
  })

  it('rejects issue/abc', () => {
    assert.equal(extractIssueNumber('issue/abc'), null)
  })

  it('rejects feature/123', () => {
    assert.equal(extractIssueNumber('feature/123'), null)
  })

  it('rejects a branch without prefix', () => {
    assert.equal(extractIssueNumber('main'), null)
    assert.equal(extractIssueNumber('123'), null)
  })

  it('rejects a number followed by non-suffix characters (issue/123abc)', () => {
    assert.equal(extractIssueNumber('issue/123abc'), null)
  })

  it('handles empty/missing branch names', () => {
    assert.equal(extractIssueNumber(''), null)
    assert.equal(extractIssueNumber(undefined), null)
  })

  it('honors a custom pattern without suffix support', () => {
    const strict = String.raw`^issue/(\d+)$`
    assert.equal(extractIssueNumber('issue/123', strict), 123)
    assert.equal(extractIssueNumber('issue/123-suffix', strict), null)
  })

  it('reports the offending branch in the violation message', () => {
    const { violation } = checkBranch({ branch: 'feature/123' })
    assert.match(violation.message, /feature\/123/)
    assert.ok(violation.action.length > 0)
  })
})

// ---------------------------------------------------------------------------
// R2 — issue exists (and is open)
// ---------------------------------------------------------------------------

describe('R2: checkIssue', () => {
  const openIssue = { exists: true, isPullRequest: false, state: 'OPEN', title: 'Title' }

  it('passes for an existing open issue', () => {
    assert.equal(checkIssue({ issueNumber: 5, issue: openIssue, requireIssueOpen: true }), null)
  })

  it('flags a missing issue', () => {
    const v = checkIssue({ issueNumber: 999, issue: { exists: false }, requireIssueOpen: true })
    assert.equal(v.rule, 'R2')
    assert.match(v.message, /#999/)
  })

  it('flags a number that points to a pull request instead of an issue', () => {
    const v = checkIssue({
      issueNumber: 7,
      issue: { exists: true, isPullRequest: true, state: null, title: null },
    })
    assert.equal(v.rule, 'R2')
    assert.match(v.message, /pull request/i)
  })

  it('flags a closed issue when require-issue-open is set', () => {
    const closed = { exists: true, isPullRequest: false, state: 'CLOSED', title: 'Title' }
    const v = checkIssue({ issueNumber: 5, issue: closed, requireIssueOpen: true })
    assert.equal(v.rule, 'R2')
    assert.match(v.message, /closed/)
  })

  it('accepts a closed issue when require-issue-open is off', () => {
    const closed = { exists: true, isPullRequest: false, state: 'CLOSED', title: 'Title' }
    assert.equal(checkIssue({ issueNumber: 5, issue: closed, requireIssueOpen: false }), null)
  })
})

// ---------------------------------------------------------------------------
// R3 — title autofix
// ---------------------------------------------------------------------------

describe('R3: titleAutofix', () => {
  const base = { issueNumber: 123, issueTitle: 'DAM import crashes' }

  it('fixes a title that is exactly the branch name', () => {
    const fixed = titleAutofix({ ...base, title: 'issue/123', branch: 'issue/123' })
    assert.equal(fixed, '#123 DAM import crashes')
  })

  it('fixes a title that differs only in casing (Issue/123)', () => {
    const fixed = titleAutofix({ ...base, title: 'Issue/123', branch: 'issue/123' })
    assert.equal(fixed, '#123 DAM import crashes')
  })

  it("fixes GitHub's auto-generated title for suffixed branches", () => {
    // Branch issue/123-dam-import -> GitHub suggests "Issue/123 dam import".
    const fixed = titleAutofix({ ...base, title: 'Issue/123 dam import', branch: 'issue/123-dam-import' })
    assert.equal(fixed, '#123 DAM import crashes')
  })

  it('leaves a title alone that merely CONTAINS the branch name', () => {
    assert.equal(titleAutofix({ ...base, title: 'issue/123 fix crash', branch: 'issue/123' }), null)
  })

  it('never touches a human-written title', () => {
    assert.equal(titleAutofix({ ...base, title: 'Repair the DAM import', branch: 'issue/123' }), null)
  })

  it('does nothing without an issue title to copy from', () => {
    assert.equal(titleAutofix({ issueNumber: 123, issueTitle: null, title: 'issue/123', branch: 'issue/123' }), null)
  })

  it('respects a custom title template', () => {
    const fixed = titleAutofix({
      ...base,
      title: 'issue/123',
      branch: 'issue/123',
      titleTemplate: '{issueTitle} (#{number})',
    })
    assert.equal(fixed, 'DAM import crashes (#123)')
  })

  it('returns null when the title already equals the rendered template', () => {
    assert.equal(titleAutofix({ ...base, title: '#123 DAM import crashes', branch: 'issue/123' }), null)
  })
})

// ---------------------------------------------------------------------------
// R4 — description
// ---------------------------------------------------------------------------

describe('R4: strippedBody / checkBody', () => {
  it('strips HTML comments (also multiline)', () => {
    assert.equal(strippedBody('<!-- please describe -->'), '')
    assert.equal(strippedBody('<!--\nmultiline\ncomment\n-->'), '')
  })

  it('flags a body that consists only of template comments', () => {
    const v = checkBody({ body: '<!-- What changed? -->\n<!-- Why? -->', minBodyChars: 10 })
    assert.equal(v.rule, 'R4')
  })

  it('strips markdown headings', () => {
    assert.equal(strippedBody('## What changed?\n### Why?'), '')
  })

  it('strips unchecked checkboxes but keeps checked ones', () => {
    const body = '- [ ] Tests written\n- [x] Tested locally'
    assert.equal(strippedBody(body), '- [x] Tested locally')
  })

  it('strips an unchecked checkbox without trailing text', () => {
    assert.equal(strippedBody('- [ ]'), '')
  })

  it('does not treat issue references like #123 as headings', () => {
    assert.equal(strippedBody('#123 hmm'), '#123 hmm')
  })

  it('enforces the exact threshold', () => {
    const text49 = 'a'.repeat(49)
    const text50 = 'a'.repeat(50)
    assert.equal(checkBody({ body: text49, minBodyChars: 50 }).rule, 'R4')
    assert.equal(checkBody({ body: text50, minBodyChars: 50 }), null)
  })

  it('flags empty and missing bodies', () => {
    assert.equal(checkBody({ body: '', minBodyChars: 1 }).rule, 'R4')
    assert.equal(checkBody({ body: null, minBodyChars: 1 }).rule, 'R4')
  })

  it('counts real prose surrounded by template noise', () => {
    const body = [
      '## What changed?',
      'The DAM import no longer crashes on umlauts, the encoding is detected correctly.',
      '- [ ] open point',
    ].join('\n')
    assert.equal(checkBody({ body, minBodyChars: 50 }), null)
  })
})

// ---------------------------------------------------------------------------
// R5 — CI
// ---------------------------------------------------------------------------

describe('R5: checkCi', () => {
  const ok = (name) => ({ name, kind: 'check', state: 'success' })
  const pending = (name) => ({ name, kind: 'check', state: 'pending' })
  const failed = (name) => ({ name, kind: 'check', state: 'failure' })

  it('passes when everything is green and mergeable', () => {
    const result = checkCi({ checks: [ok('build'), ok('lint')], mergeable: 'MERGEABLE' })
    assert.deepEqual(result.violations, [])
    assert.equal(result.pending, false)
  })

  it('does NOTHING while checks are still running', () => {
    const result = checkCi({ checks: [ok('build'), pending('tests')], mergeable: 'MERGEABLE' })
    assert.deepEqual(result.violations, [])
    assert.equal(result.pending, true)
  })

  it('treats mergeable UNKNOWN as pending, not as a violation', () => {
    const result = checkCi({ checks: [ok('build')], mergeable: 'UNKNOWN' })
    assert.deepEqual(result.violations, [])
    assert.equal(result.pending, true)
  })

  it('flags a definitive failure even while other checks still run', () => {
    const result = checkCi({ checks: [failed('tests'), pending('build')], mergeable: 'MERGEABLE' })
    assert.equal(result.violations.length, 1)
    assert.match(result.violations[0].message, /`tests`/)
  })

  it('flags merge conflicts', () => {
    const result = checkCi({ checks: [ok('build')], mergeable: 'CONFLICTING' })
    assert.equal(result.violations.length, 1)
    assert.match(result.violations[0].message, /conflict/i)
  })

  it('excludes the guardrail`s own check runs (no endless loop)', () => {
    const result = checkCi({
      checks: [failed('guardrail / guardrail'), ok('build')],
      mergeable: 'MERGEABLE',
      ownCheckNames: ['guardrail / guardrail'],
    })
    assert.deepEqual(result.violations, [])
    assert.equal(result.pending, false)
  })

  it('passes vacuously when a repo has no CI at all', () => {
    const result = checkCi({ checks: [], mergeable: 'MERGEABLE' })
    assert.deepEqual(result.violations, [])
    assert.equal(result.pending, false)
  })
})

describe('R5: normalizeCheckContexts', () => {
  it('maps check runs and statuses onto the neutral shape', () => {
    const nodes = [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: null },
      { __typename: 'CheckRun', name: 'deploy', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { __typename: 'CheckRun', name: 'slow', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      { __typename: 'CheckRun', name: 'optional', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { __typename: 'CheckRun', name: 'skipped', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
      { __typename: 'StatusContext', context: 'ci/other', state: 'PENDING' },
      { __typename: 'StatusContext', context: 'ci/fine', state: 'SUCCESS' },
    ]
    const states = Object.fromEntries(normalizeCheckContexts(nodes).map((c) => [c.name, c.state]))
    assert.deepEqual(states, {
      build: 'success',
      tests: 'failure',
      e2e: 'pending',
      deploy: 'failure',
      slow: 'failure',
      optional: 'success',
      skipped: 'success',
      gate: 'pending',
      'ci/legacy': 'failure',
      'ci/other': 'pending',
      'ci/fine': 'success',
    })
  })

  it('ignores unknown nodes gracefully', () => {
    assert.deepEqual(normalizeCheckContexts([null, {}, { __typename: 'Other' }]), [])
  })
})

// ---------------------------------------------------------------------------
// R6 — closing reference
// ---------------------------------------------------------------------------

describe('R6: closingReference', () => {
  it('appends when the body has no reference at all', () => {
    assert.equal(closingReference({ body: 'Description.', issueNumber: 123 }), 'Closes #123')
  })

  it('appends for an empty body', () => {
    assert.equal(closingReference({ body: '', issueNumber: 123 }), 'Closes #123')
  })

  it('does not append when GitHub already resolved the link', () => {
    assert.equal(closingReference({ body: '', issueNumber: 123, linkedIssueNumbers: [123] }), null)
  })

  it('does not append when a closing keyword is present (any casing)', () => {
    assert.equal(closingReference({ body: 'closes #123', issueNumber: 123 }), null)
    assert.equal(closingReference({ body: 'Fixes #123', issueNumber: 123 }), null)
    assert.equal(closingReference({ body: 'Resolved: #123', issueNumber: 123 }), null)
  })

  it('appends when only a bare #123 without keyword is present', () => {
    assert.equal(closingReference({ body: 'see #123', issueNumber: 123 }), 'Closes #123')
  })

  it('is exact about the number (no prefix matches)', () => {
    assert.equal(closingReference({ body: 'Closes #12', issueNumber: 123 }), 'Closes #123')
    assert.equal(closingReference({ body: 'Closes #1234', issueNumber: 123 }), 'Closes #123')
  })

  it('does nothing without an issue number', () => {
    assert.equal(closingReference({ body: '', issueNumber: null }), null)
  })
})

// ---------------------------------------------------------------------------
// R7 — base branch is a version branch
// ---------------------------------------------------------------------------

describe('R7: isVersionBranch / checkBaseBranch', () => {
  it('recognizes version branches with the default pattern', () => {
    assert.equal(isVersionBranch('1.x'), true)
    assert.equal(isVersionBranch('2.x'), true)
    assert.equal(isVersionBranch('10.x'), true)
  })

  it('rejects non-version branches', () => {
    assert.equal(isVersionBranch('main'), false)
    assert.equal(isVersionBranch('issue/123'), false)
    assert.equal(isVersionBranch('2.x-backport'), false)
    assert.equal(isVersionBranch(''), false)
    assert.equal(isVersionBranch(undefined), false)
  })

  it('passes PRs targeting a version branch', () => {
    assert.equal(checkBaseBranch({ baseBranch: '2.x' }), null)
  })

  it('flags PRs targeting a non-version branch', () => {
    const v = checkBaseBranch({ baseBranch: 'main' })
    assert.equal(v.rule, 'R7')
    assert.match(v.message, /`main`/)
    assert.ok(v.action.length > 0)
  })

  it('supports the extended core pattern (minor branches)', () => {
    const core = String.raw`^\d+\.(x|\d+)$`
    assert.equal(checkBaseBranch({ baseBranch: '5.1', versionBranchPattern: core }), null)
    assert.equal(checkBaseBranch({ baseBranch: '2026.x', versionBranchPattern: core }), null)
    assert.equal(checkBaseBranch({ baseBranch: 'main', versionBranchPattern: core }).rule, 'R7')
  })

  it('is disabled by an empty pattern', () => {
    assert.equal(checkBaseBranch({ baseBranch: 'main', versionBranchPattern: '' }), null)
    assert.equal(isVersionBranch('2.x', ''), false)
  })
})

// ---------------------------------------------------------------------------
// Merge-up detection
// ---------------------------------------------------------------------------

describe('isMergeUpBranch', () => {
  it('recognizes a version branch merged forward directly', () => {
    assert.equal(isMergeUpBranch('1.x'), true)
    assert.equal(isMergeUpBranch('2026.x'), true)
  })

  it('recognizes the upmerge branch convention', () => {
    assert.equal(isMergeUpBranch('upmerge/2.x_2026.x'), true)
    assert.equal(isMergeUpBranch('upmerge/5.1_2026.x'), true)
    assert.equal(isMergeUpBranch('UPMERGE/2.x_2026.x'), true)
  })

  it('rejects ordinary branches', () => {
    assert.equal(isMergeUpBranch('issue/123'), false)
    assert.equal(isMergeUpBranch('main'), false)
    assert.equal(isMergeUpBranch('feature/upmerge-tooling'), false)
    assert.equal(isMergeUpBranch(''), false)
    assert.equal(isMergeUpBranch(undefined), false)
  })

  it('honors a custom merge-up pattern', () => {
    const cfg = { mergeUpBranchPattern: String.raw`^merge-forward/` }
    assert.equal(isMergeUpBranch('merge-forward/2.x', cfg), true)
    assert.equal(isMergeUpBranch('upmerge/2.x_2026.x', cfg), false)
  })

  it('falls back to the version-branch pattern when the extra pattern is empty', () => {
    assert.equal(isMergeUpBranch('upmerge/2.x_2026.x', { mergeUpBranchPattern: '' }), false)
    assert.equal(isMergeUpBranch('2.x', { mergeUpBranchPattern: '' }), true)
  })
})

// ---------------------------------------------------------------------------
// Release detection + R8 — milestone
// ---------------------------------------------------------------------------

describe('extractReleaseVersion / isReleaseBranch', () => {
  it('recognizes the release branch convention and extracts the version', () => {
    assert.equal(extractReleaseVersion('release/5.1.0'), '5.1.0')
    assert.equal(extractReleaseVersion('release/4.1.13'), '4.1.13')
    assert.equal(extractReleaseVersion('release/2026.2.0'), '2026.2.0')
    assert.equal(isReleaseBranch('release/5.1.0'), true)
  })

  it('accepts pre-release suffixes', () => {
    assert.equal(extractReleaseVersion('release/2026.1.0-beta.1'), '2026.1.0-beta.1')
    assert.equal(extractReleaseVersion('release/5.2.0-RC1'), '5.2.0-RC1')
  })

  it('is case-insensitive', () => {
    assert.equal(extractReleaseVersion('Release/5.1.0'), '5.1.0')
  })

  it('rejects branches that are not a release', () => {
    assert.equal(extractReleaseVersion('release/foo'), null)
    assert.equal(extractReleaseVersion('release/5'), null)
    assert.equal(extractReleaseVersion('release/5.1.0/fix'), null)
    assert.equal(extractReleaseVersion('issue/123'), null)
    assert.equal(extractReleaseVersion('upmerge/5.1_2026.x'), null)
    assert.equal(extractReleaseVersion('feature/release-notes'), null)
    assert.equal(extractReleaseVersion(''), null)
    assert.equal(extractReleaseVersion(undefined), null)
    assert.equal(isReleaseBranch('issue/123'), false)
  })

  it('honors a custom pattern', () => {
    const custom = String.raw`^rel-(\d+\.\d+\.\d+)$`
    assert.equal(extractReleaseVersion('rel-1.2.3', custom), '1.2.3')
    assert.equal(extractReleaseVersion('release/1.2.3', custom), null)
  })

  it('an empty pattern disables release detection', () => {
    assert.equal(extractReleaseVersion('release/5.1.0', ''), null)
    assert.equal(isReleaseBranch('release/5.1.0', ''), false)
  })
})

describe('R8: checkMilestone', () => {
  it('passes when the milestone matches the released version', () => {
    assert.equal(checkMilestone({ version: '5.1.0', milestone: '5.1.0' }), null)
  })

  it('tolerates a leading v and surrounding whitespace on the milestone', () => {
    assert.equal(checkMilestone({ version: '5.1.0', milestone: 'v5.1.0' }), null)
    assert.equal(checkMilestone({ version: '5.1.0', milestone: ' 5.1.0 ' }), null)
  })

  it('flags a missing milestone', () => {
    const violation = checkMilestone({ version: '5.1.0', milestone: null })
    assert.equal(violation.rule, 'R8')
    assert.match(violation.message, /no milestone/)
    assert.match(violation.action, /5\.1\.0/)
  })

  it('flags a milestone of a different version', () => {
    const violation = checkMilestone({ version: '5.1.0', milestone: '5.0.2' })
    assert.equal(violation.rule, 'R8')
    assert.match(violation.message, /5\.0\.2/)
    assert.match(violation.message, /does not match/)
  })

  it('does not treat a pre-release as its final version', () => {
    assert.equal(checkMilestone({ version: '2026.1.0-beta.1', milestone: '2026.1.0' }).rule, 'R8')
  })
})

// ---------------------------------------------------------------------------
// Bot detection
// ---------------------------------------------------------------------------

describe('isBotAuthor', () => {
  it('matches webhook-style logins (renovate[bot])', () => {
    assert.equal(isBotAuthor('renovate[bot]'), true)
    assert.equal(isBotAuthor('dependabot[bot]'), true)
  })

  it('matches GraphQL-style logins without the [bot] suffix', () => {
    assert.equal(isBotAuthor('renovate'), true)
    assert.equal(isBotAuthor('github-actions'), true)
  })

  it('does not match humans', () => {
    assert.equal(isBotAuthor('pfaffenbauer'), false)
    assert.equal(isBotAuthor(''), false)
    assert.equal(isBotAuthor(undefined), false)
  })

  it('honors a custom bot list (e.g. the CD bot)', () => {
    const bots = [...DEFAULT_CONFIG.bots, 'coreshop-cd[bot]']
    assert.equal(isBotAuthor('coreshop-cd', bots), true)
    assert.equal(isBotAuthor('coreshop-cd[bot]', bots), true)
  })
})

// ---------------------------------------------------------------------------
// evaluate — integration of all rules
// ---------------------------------------------------------------------------

describe('evaluate', () => {
  const greenChecks = [{ name: 'build', kind: 'check', state: 'success' }]
  const humanFacts = {
    branch: 'issue/123',
    baseBranch: '2.x',
    title: 'issue/123',
    body: 'The DAM import no longer crashes on umlauts, the encoding is detected correctly.',
    authorLogin: 'pfaffenbauer',
    issue: { exists: true, isPullRequest: false, state: 'OPEN', title: 'DAM import crashes' },
    checks: greenChecks,
    mergeable: 'MERGEABLE',
    ownCheckNames: [],
    linkedIssueNumbers: [],
  }

  it('happy path: no violations, title autofix + closing reference', () => {
    const result = evaluate(humanFacts)
    assert.deepEqual(result.violations, [])
    assert.equal(result.isBot, false)
    assert.equal(result.isMergeUp, false)
    assert.equal(result.issueNumber, 123)
    assert.equal(result.titleFix, '#123 DAM import crashes')
    assert.equal(result.appendClosing, 'Closes #123')
    assert.equal(result.ciPending, false)
  })

  it('R1 violation skips the issue rules but still checks body and CI', () => {
    const result = evaluate({ ...humanFacts, branch: 'feature/123', body: '', issue: null })
    const rules = result.violations.map((v) => v.rule)
    assert.deepEqual(rules, ['R1', 'R4'])
    assert.equal(result.titleFix, null)
    assert.equal(result.appendClosing, null)
  })

  it('closed issue: violation and NO repairs', () => {
    const result = evaluate({
      ...humanFacts,
      issue: { exists: true, isPullRequest: false, state: 'CLOSED', title: 'DAM import crashes' },
    })
    assert.deepEqual(result.violations.map((v) => v.rule), ['R2'])
    assert.equal(result.titleFix, null)
    assert.equal(result.appendClosing, null)
  })

  it('closed issue passes when require-issue-open is off', () => {
    const result = evaluate(
      {
        ...humanFacts,
        issue: { exists: true, isPullRequest: false, state: 'CLOSED', title: 'DAM import crashes' },
      },
      { requireIssueOpen: false },
    )
    assert.deepEqual(result.violations, [])
  })

  it('flags a PR against a non-version base branch (R7)', () => {
    const result = evaluate({ ...humanFacts, baseBranch: 'main' })
    assert.deepEqual(result.violations.map((v) => v.rule), ['R7'])
  })

  it('R7 disabled via empty pattern accepts any base branch', () => {
    const result = evaluate({ ...humanFacts, baseBranch: 'main' }, { versionBranchPattern: '' })
    assert.deepEqual(result.violations, [])
  })

  it('merge-up PR (1.x -> 2.x): R1/R2/R4/R6 skipped, no repairs, R5/R7 apply', () => {
    const result = evaluate({
      ...humanFacts,
      branch: '1.x',
      baseBranch: '2.x',
      title: '1.x into 2.x',
      body: '',
      issue: null,
    })
    assert.equal(result.isMergeUp, true)
    assert.deepEqual(result.violations, [])
    assert.equal(result.titleFix, null)
    assert.equal(result.appendClosing, null)
  })

  it('merge-up PR still fails R5 on red CI and R7 on a wrong base', () => {
    const result = evaluate({
      ...humanFacts,
      branch: '1.x',
      baseBranch: 'main',
      body: '',
      issue: null,
      checks: [{ name: 'build', kind: 'check', state: 'failure' }],
    })
    assert.equal(result.isMergeUp, true)
    assert.deepEqual(result.violations.map((v) => v.rule), ['R7', 'R5'])
  })

  it('upmerge PR (upmerge/2.x_2026.x -> 2026.x): treated like a merge-up', () => {
    const result = evaluate({
      ...humanFacts,
      branch: 'upmerge/2.x_2026.x',
      baseBranch: '2026.x',
      title: '[UPMERGE] 2.x -> 2026.x',
      body: '',
      issue: null,
    })
    assert.equal(result.isMergeUp, true)
    assert.deepEqual(result.violations, [])
    assert.equal(result.issueNumber, null)
    assert.equal(result.titleFix, null)
    assert.equal(result.appendClosing, null)
  })

  it('upmerge PR still fails R5 on red CI and R7 on a wrong base', () => {
    const result = evaluate({
      ...humanFacts,
      branch: 'upmerge/2.x_2026.x',
      baseBranch: 'main',
      title: '[UPMERGE] 2.x -> main',
      body: '',
      issue: null,
      checks: [{ name: 'build', kind: 'check', state: 'failure' }],
    })
    assert.equal(result.isMergeUp, true)
    assert.deepEqual(result.violations.map((v) => v.rule), ['R7', 'R5'])
  })

  it('upmerge PR is judged by the branch, not by the title', () => {
    const withoutMarker = evaluate({
      ...humanFacts,
      branch: 'upmerge/2.x_2026.x',
      baseBranch: '2026.x',
      title: 'Bring 2.x forward',
      body: '',
      issue: null,
    })
    assert.equal(withoutMarker.isMergeUp, true)
    assert.deepEqual(withoutMarker.violations, [])

    const markerOnly = evaluate({
      ...humanFacts,
      branch: 'feature/upmerge',
      baseBranch: '2026.x',
      title: '[UPMERGE] 2.x -> 2026.x',
      body: '',
      issue: null,
    })
    assert.equal(markerOnly.isMergeUp, false)
    assert.deepEqual(markerOnly.violations.map((v) => v.rule), ['R1', 'R4'])
  })

  it('upmerge exemption can be switched off per repo', () => {
    const result = evaluate(
      {
        ...humanFacts,
        branch: 'upmerge/2.x_2026.x',
        baseBranch: '2026.x',
        title: '[UPMERGE] 2.x -> 2026.x',
        body: '',
        issue: null,
      },
      { mergeUpBranchPattern: '' },
    )
    assert.equal(result.isMergeUp, false)
    assert.deepEqual(result.violations.map((v) => v.rule), ['R1', 'R4'])
  })

  it('release PR (release/5.1.0 -> 5.1): R1/R2/R4/R6 skipped, R8 passes with the milestone', () => {
    const result = evaluate(
      {
        ...humanFacts,
        branch: 'release/5.1.0',
        baseBranch: '5.1',
        title: '[Release] 5.1.0',
        body: '',
        issue: null,
        milestone: '5.1.0',
      },
      { versionBranchPattern: String.raw`^\d+\.(x|\d+)$` },
    )
    assert.equal(result.isRelease, true)
    assert.equal(result.releaseVersion, '5.1.0')
    assert.equal(result.isMergeUp, false)
    assert.deepEqual(result.violations, [])
    assert.equal(result.issueNumber, null)
    assert.equal(result.titleFix, null)
    assert.equal(result.appendClosing, null)
  })

  it('release PR without a milestone fails R8', () => {
    const result = evaluate({
      ...humanFacts,
      branch: 'release/2.1.0',
      baseBranch: '2.x',
      title: '[Release] 2.1.0',
      body: '',
      issue: null,
      milestone: null,
    })
    assert.equal(result.isRelease, true)
    assert.deepEqual(result.violations.map((v) => v.rule), ['R8'])
  })

  it('release PR with the wrong milestone fails R8', () => {
    const result = evaluate({
      ...humanFacts,
      branch: 'release/2.1.0',
      baseBranch: '2.x',
      title: '[Release] 2.1.0',
      body: '',
      issue: null,
      milestone: '2.0.5',
    })
    assert.deepEqual(result.violations.map((v) => v.rule), ['R8'])
    assert.match(result.violations[0].message, /2\.0\.5/)
  })

  it('release PR still fails R5 on red CI and R7 on a wrong base', () => {
    const result = evaluate({
      ...humanFacts,
      branch: 'release/2.1.0',
      baseBranch: 'main',
      title: '[Release] 2.1.0',
      body: '',
      issue: null,
      milestone: '2.1.0',
      checks: [{ name: 'build', kind: 'check', state: 'failure' }],
    })
    assert.equal(result.isRelease, true)
    assert.deepEqual(result.violations.map((v) => v.rule), ['R7', 'R5'])
  })

  it('release PR is judged by the branch, not by the title', () => {
    const markerOnly = evaluate({
      ...humanFacts,
      branch: 'feature/release',
      baseBranch: '2.x',
      title: '[Release] 2.1.0',
      body: '',
      issue: null,
      milestone: '2.1.0',
    })
    assert.equal(markerOnly.isRelease, false)
    assert.deepEqual(markerOnly.violations.map((v) => v.rule), ['R1', 'R4'])
  })

  it('release detection can be switched off per repo', () => {
    const result = evaluate(
      {
        ...humanFacts,
        branch: 'release/2.1.0',
        baseBranch: '2.x',
        title: '[Release] 2.1.0',
        body: '',
        issue: null,
        milestone: '2.1.0',
      },
      { releaseBranchPattern: '' },
    )
    assert.equal(result.isRelease, false)
    assert.deepEqual(result.violations.map((v) => v.rule), ['R1', 'R4'])
  })

  it('a milestone on an ordinary PR is neither required nor checked', () => {
    assert.deepEqual(evaluate({ ...humanFacts, milestone: null }).violations, [])
    assert.deepEqual(evaluate({ ...humanFacts, milestone: '9.9.9' }).violations, [])
  })

  it('bot author: R1-R3/R6 skipped, R4 off by default, R5 still applies', () => {
    const result = evaluate({
      ...humanFacts,
      authorLogin: 'renovate[bot]',
      branch: 'renovate/symfony-7.x',
      body: '',
      issue: null,
      checks: [{ name: 'build', kind: 'check', state: 'failure' }],
    })
    assert.equal(result.isBot, true)
    assert.deepEqual(result.violations.map((v) => v.rule), ['R5'])
    assert.equal(result.titleFix, null)
    assert.equal(result.appendClosing, null)
  })

  it('bot author with bot-require-body: R4 applies', () => {
    const result = evaluate(
      { ...humanFacts, authorLogin: 'renovate[bot]', branch: 'renovate/x', body: '', issue: null },
      { botRequireBody: true },
    )
    assert.deepEqual(result.violations.map((v) => v.rule), ['R4'])
  })

  it('pending CI produces no violation but marks the result as pending', () => {
    const result = evaluate({
      ...humanFacts,
      title: 'A clean title',
      checks: [{ name: 'build', kind: 'check', state: 'pending' }],
    })
    assert.deepEqual(result.violations, [])
    assert.equal(result.ciPending, true)
  })

  it('collects multiple violations at once', () => {
    const result = evaluate({
      ...humanFacts,
      branch: 'issue/999',
      title: 'whatever',
      body: '<!-- template only -->',
      issue: { exists: false },
      checks: [{ name: 'build', kind: 'check', state: 'failure' }],
      mergeable: 'CONFLICTING',
    })
    assert.deepEqual(result.violations.map((v) => v.rule), ['R2', 'R4', 'R5', 'R5'])
  })
})
