#!/usr/bin/env node
// Adds new issues and PRs to a fixed Projects V2 board (the org-wide
// "CoreShop Development" board by default).
//
// Unlike the CORS reference implementation (which resolves boards via the
// linked issues), the target board is fixed via PROJECT_OWNER /
// PROJECT_NUMBER — every issue and every PR of the connected repos lands on
// the same org board. Idempotent: addProjectV2ItemById returns the existing
// item when the content is already on the board.

import { readFileSync } from 'node:fs'
import { GitHubClient, GitHubApiError, requireEnv } from './github.mjs'

const PROJECT_QUERY = /* GraphQL */ `
  query Project($owner: String!, $number: Int!) {
    organization(login: $owner) {
      projectV2(number: $number) {
        id
        title
      }
    }
  }
`

async function main() {
  const [owner, repo] = requireEnv('GITHUB_REPOSITORY').split('/')
  const event = JSON.parse(readFileSync(requireEnv('GITHUB_EVENT_PATH'), 'utf8'))
  const projectOwner = requireEnv('PROJECT_OWNER')
  const projectNumber = Number.parseInt(requireEnv('PROJECT_NUMBER'), 10)

  // node_id is present on both issue and PR payloads.
  const content = event.pull_request ?? event.issue
  if (!content?.node_id) {
    console.log('No issue or pull_request payload in this event — nothing to do.')
    return
  }

  const api = new GitHubClient({ token: requireEnv('GUARDRAIL_TOKEN'), owner, repo })

  const { data, errors } = await api.graphql(PROJECT_QUERY, { owner: projectOwner, number: projectNumber })
  if (errors?.length) {
    throw new GitHubApiError('Project lookup failed', { details: JSON.stringify(errors) })
  }
  const project = data?.organization?.projectV2
  if (!project) {
    throw new GitHubApiError(`Project ${projectOwner}#${projectNumber} not found or not accessible.`)
  }

  const result = await api.graphql(
    /* GraphQL */ `
      mutation AddToProject($project: ID!, $content: ID!) {
        addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
          item {
            id
          }
        }
      }
    `,
    { project: project.id, content: content.node_id },
  )
  if (result.errors?.length) {
    throw new GitHubApiError('addProjectV2ItemById failed', { details: JSON.stringify(result.errors) })
  }
  const kind = event.pull_request ? 'PR' : 'Issue'
  console.log(`${kind} #${content.number}: added to project "${project.title}" (${projectOwner}#${projectNumber}).`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
