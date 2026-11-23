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

/**
 * A provider explicitly refused the request and this operation produced no
 * visible message, so the message is known not to exist on the other side
 * (ISSUE-23).
 *
 * Unlike `ChannelPreSendRejection`, the provider was contacted. Throw this
 * only for response codes that prove the request was refused — for example
 * iLink `-14` (bot session expired) — and only when nothing from the same
 * send (an earlier text chunk, an image caption) has already reached the
 * user. The outbox state machine fails the row instead of fencing it as
 * `uncertain`.
 */
export class ChannelProviderRejection extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChannelProviderRejection';
  }
}
