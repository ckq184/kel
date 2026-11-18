export interface ImChannelCapabilities {
  channel_type: string;
  label: string;
  can_bind_workspace: boolean;
  can_bind_session: boolean;
  supports_thread_map: boolean;
  supports_activation_modes: boolean;
  supports_owner_mention: boolean;
  supports_streaming_updates: boolean;
  supports_file_send: boolean;
}

export const IM_CHANNEL_ORDER = ['feishu', 'qq', 'wechat'] as const;

export type ImChannelType = (typeof IM_CHANNEL_ORDER)[number];

export const IM_CHANNEL_CAPABILITIES: Record<
  ImChannelType,
  ImChannelCapabilities
> = {
  feishu: {
    channel_type: 'feishu',
    label: '飞书',
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: true,
    supports_activation_modes: true,
    supports_owner_mention: true,
    supports_streaming_updates: true,
    supports_file_send: true,
  },
  qq: {
    channel_type: 'qq',
    label: 'QQ',
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: false,
    supports_activation_modes: false,
    supports_owner_mention: true,
    supports_streaming_updates: true,
    supports_file_send: true,
  },
  wechat: {
    channel_type: 'wechat',
    label: '微信',
    can_bind_workspace: true,
    can_bind_session: true,
    supports_thread_map: false,
    supports_activation_modes: false,
    supports_owner_mention: false,
    supports_streaming_updates: false,
    supports_file_send: false,
  },
};

export function getImChannelCapabilities(
  channelType: string | null | undefined,
): ImChannelCapabilities | undefined {
  return channelType
    ? IM_CHANNEL_CAPABILITIES[channelType as ImChannelType]
    : undefined;
}
