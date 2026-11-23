/**
 * A channel refused an outbound operation before contacting the provider, so
 * the message is known not to exist on the other side (ISSUE-19).
 *
 * Throw this only when no provider call was made — for example a missing
 * reply token or a size limit checked locally. The outbox state machine
 * treats it like an explicit provider rejection: the row fails instead of
 * being fenced as `uncertain`. Anything that happens after the request left
 * the process stays an ordinary error.
 *
 * This module has no dependencies on purpose: both channel adapters and the
 * outbox state machine import it without pulling in each other.
 */
export class ChannelPreSendRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelPreSendRejection';
  }
}
