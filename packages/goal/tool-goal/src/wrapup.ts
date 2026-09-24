/** Model-visible wrap-up instruction for a terminal autonomous goal update. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const GROUNDING =
  'Report only what earlier rounds and tool results in this session actually establish; '
  + 'when a detail is not in the session, say so instead of inventing it. '

/**
 * Render the closing-message instruction injected after an autonomous goal
 * round reports `complete` or `blocked`, replacing the former hard turn stop
 * so the model still addresses the user once before the turn ends.
 * @param objective - the terminal goal's objective, echoed for grounding.
 * @param blockedReason - the validated report for `blocked`; omitted for `complete`.
 * @param unattended - whether the closing message must avoid asking for human follow-up.
 * @returns a fresh one-block context for `ToolRunContext.deferContext()`.
 */
export function renderWrapupContext(objective: string, blockedReason?: string, unattended = false): ContentBlock[] {
  const heading = `Objective: ${JSON.stringify(objective)}\n`
  const text = blockedReason === undefined
    ? '<goal_complete>\n'
      + heading
      + 'The goal is marked complete and this autonomous run is ending. Write the closing '
      + 'message to the user now: state the outcome, summarize what was done and how it was '
      + 'verified, and point to the concrete results (files, commits, or other artifacts). '
      + GROUNDING
      + (unattended
        ? 'Address the user directly. Do not call any more tools or wait for an answer.\n'
        : 'Note anything the user should review or do next. Address the user directly. Do not '
          + "call any more tools in this run; further work waits for the user's next instruction.\n")
      + '</goal_complete>'
    : '<goal_blocked>\n'
      + heading
      + `Blocked: ${JSON.stringify(blockedReason)}\n`
      + 'The goal is marked blocked and this autonomous run is ending. Write the closing '
      + 'message to the user now: state what has been completed so far, describe the concrete '
      + 'blocking condition and what you tried. '
      + GROUNDING
      + (unattended
        ? 'Address the user directly, include any remaining constraints, and do not call more tools or wait for an answer.\n'
        : 'Say exactly what you need from the user to continue. Address the user directly. '
          + "Do not call any more tools in this run; further work waits for the user's next instruction.\n")
      + '</goal_blocked>'
  return [{ type: 'text', text }]
}
