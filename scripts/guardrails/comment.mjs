// Pure rendering of the guardrail's PR comments.
//
// The sticky status comment is identified by MARKER and gets updated in
// place. Rendering is fully deterministic (no timestamps in the sticky
// comment) so that identical evaluation results produce byte-identical
// bodies — the API layer then skips the write entirely (idempotency).

export const MARKER = '<!-- pr-guardrail -->'
export const AUDIT_MARKER = '<!-- pr-guardrail-audit -->'

const FOOTER =
  '<sub>Automated comment by the PR guardrail — details and FAQ: <a href="https://github.com/coreshop/workflow-collection/blob/main/docs/GUARDRAILS.md"><code>docs/GUARDRAILS.md</code></a> in <code>coreshop/workflow-collection</code>.</sub>'

/** Short success message the sticky comment is reduced to once all rules pass. */
export function renderSuccessComment() {
  return `${MARKER}\n✅ **PR Guardrail:** All rules pass.`
}

/**
 * Render the sticky status comment for a set of violations.
 * `enforce` toggles between the blocking text (PR was converted to draft)
 * and the clearly marked advisory mode.
 */
export function renderStatusComment({ violations, ciPending = false, enforce = false }) {
  if (!violations || violations.length === 0) return renderSuccessComment()

  const lines = [MARKER, '## 🚦 PR Guardrail', '']
  if (enforce) {
    lines.push(
      '> ❌ **This PR has been converted to draft** because the rules below are violated.',
      '> After fixing them, click **"Ready for review"** — the checks run again automatically.',
    )
  } else {
    lines.push(
      '> ⚠️ **Advisory mode:** this PR is **not** blocked (yet). Once the guardrail is switched to `enforce: true`, the points below would be violations.',
    )
  }
  lines.push('')

  for (const v of violations) {
    lines.push(`### ❌ ${v.rule} — ${v.title}`, v.message, '', `➡️ ${v.action}`, '')
  }

  if (ciPending) {
    lines.push('_ℹ️ Some CI checks are still running. The CI result is re-evaluated automatically once they finish._', '')
  }

  lines.push(FOOTER)
  return lines.join('\n')
}

/**
 * Permanent audit trail for an authorized bypass. Posted as a NEW comment
 * (never updated or removed) so the decision stays visible in the timeline.
 */
export function renderAuditComment({ login, role, timestamp, bypassLabel = 'guardrail-bypass' }) {
  return [
    AUDIT_MARKER,
    `🔓 **Guardrail bypass activated.** @${login} (permission: \`${role}\`) set the \`${bypassLabel}\` label at ${timestamp}.`,
    '',
    'All guardrail checks are skipped for this PR as long as the label is present.',
  ].join('\n')
}

/** Comment posted when a non-admin tried to set the bypass label. */
export function renderBypassDeniedComment({ login, bypassLabel = 'guardrail-bypass' }) {
  return [
    `🚫 @${login}: only people with \`admin\` or \`maintain\` permission on this repository may set the \`${bypassLabel}\` label.`,
    '',
    'The label has been removed; the guardrail continues normally.',
  ].join('\n')
}

/**
 * Compare two comment bodies ignoring line-ending and trailing-whitespace
 * differences (GitHub normalizes CRLF). Used to decide whether an API write
 * is necessary at all.
 */
export function commentsEqual(a, b) {
  const normalize = (s) => (s ?? '').replace(/\r\n/g, '\n').trimEnd()
  return normalize(a) === normalize(b)
}
