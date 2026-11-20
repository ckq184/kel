import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { CHANNEL_OPTIONS } from '../utils/task-utils';
import type { ChannelAccount } from '../stores/channel-accounts';

/**
 * Derive per-provider connected booleans from /api/channel-accounts.
 *
 * Replaces the removed GET /api/config/user-im/status: that endpoint answered
 * `{feishu,qq,wechat}` with the live-connector probe (imManager.isXConnected)
 * for the user's legacy singleton connectors. The account list's `status`
 * field is produced by the backend's `projectedTransportStatus`, which is the
 * same live probe (`isChannelAccountConnected`) projected onto each account —
 * including the auto-projected legacy default account — so "provider has at
 * least one transport-connected account" reproduces the old semantics.
 */
export function deriveConnectedChannels(
  accounts: Pick<ChannelAccount, 'provider' | 'status'>[],
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const ch of CHANNEL_OPTIONS) {
    result[ch.key] = accounts.some(
      (account) =>
        account.provider === ch.key && account.status === 'connected',
    );
  }
  return result;
}

/**
 * Fetch connected IM channel status once on mount.
 * Returns a stable Record<string, boolean> keyed by channel name.
 */
export function useConnectedChannels(): Record<string, boolean> {
  const [connected, setConnected] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api
      .get<{ accounts: ChannelAccount[] }>('/api/channel-accounts')
      .then((data) => {
        setConnected(deriveConnectedChannels(data.accounts));
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  return connected;
}
