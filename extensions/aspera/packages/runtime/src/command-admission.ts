/** Typed refusal receipts survive authenticated transport without becoming connection failures. */
import type { CommandAdmissionRejection } from '@aspera/experiments'

/** A validated node receipt confirms that this specific launch did not start. */
export class CommandAdmissionRejected extends Error {
  /** @param receipt - authenticated, identity-bound pre-launch refusal. */
  constructor(readonly receipt: CommandAdmissionRejection) { super(receipt.detail); this.name = 'CommandAdmissionRejected' }
}
