import type {
  ChannelAccountCreateInput,
  ChannelAccountPatchInput,
  ChannelProvider,
} from '../stores/channel-accounts';

export type ChannelAuthMode = 'credentials' | 'bot_token' | 'qr_session';

export interface CredentialField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ChannelSetupGuide {
  title: string;
  steps: string[];
  action?: {
    label: string;
    url: string;
  };
  nextStep: string;
}

export interface ChannelProviderOption {
  value: ChannelProvider;
  label: string;
  description: string;
  authMode: ChannelAuthMode;
  credentials: CredentialField[];
  setupGuide: ChannelSetupGuide;
  supportsTest: boolean;
  supportsPairing: boolean;
}

/**
 * The account list is shared, while every provider keeps its real onboarding
 * protocol. In particular, QR results are server-managed protocol output and
 * must never be exposed as editable credentials.
 */
export const CHANNEL_PROVIDER_OPTIONS: ChannelProviderOption[] = [
  {
    value: 'feishu',
    label: '飞书',
    description: '通过飞书自建应用接收消息，Owner 会在首次私聊时自动识别。',
    authMode: 'credentials',
    credentials: [
      {
        key: 'appId',
        label: '飞书应用 App ID',
        required: true,
        help: '在企业自建应用的“凭证与基础信息”中复制。',
      },
      {
        key: 'appSecret',
        label: '飞书应用 App Secret',
        required: true,
        secret: true,
        help: '与 App ID 在同一页；请不要填写 Verification Token。',
      },
    ],
    setupGuide: {
      title: '先创建飞书企业自建应用',
      steps: [
        '在飞书开放平台创建企业自建应用，并启用“机器人”能力。',
        '在“凭证与基础信息”复制 App ID 和 App Secret。',
        '事件订阅选择长连接，添加 im.message.receive_v1，申请消息与资源权限后发布应用。',
      ],
      action: {
        label: '打开飞书开放平台',
        url: 'https://open.feishu.cn/app',
      },
      nextStep: '发布后在飞书里给 Bot 发起私聊，CKQClaw 会自动识别账号 Owner。',
    },
    supportsTest: true,
    supportsPairing: false,
  },
  {
    value: 'qq',
    label: 'QQ',
    description: '使用 QQ Bot 应用凭证接入；保存后通过配对码授权聊天。',
    authMode: 'credentials',
    credentials: [
      {
        key: 'appId',
        label: 'QQ 机器人 AppID',
        required: true,
        help: 'QQ 开放平台生成的机器人应用 ID，不是 QQ 号。',
      },
      {
        key: 'appSecret',
        label: 'QQ 机器人 AppSecret',
        required: true,
        secret: true,
        help: '创建或重置机器人时显示的密钥，不是 QQ 密码。',
      },
    ],
    setupGuide: {
      title: '先创建 QQ 官方机器人',
      steps: [
        '用手机 QQ 扫码登录 QQ 开放平台，点击“创建机器人”。',
        '在机器人页面复制 AppID 和 AppSecret。',
        '保存 AppSecret；丢失后需要在 QQ 开放平台重置。',
      ],
      action: {
        label: '打开 QQ 开放平台',
        url: 'https://q.qq.com/qqbot/openclaw/index.html',
      },
      nextStep:
        '连接成功后生成配对码，在 QQ Bot 私聊或目标群聊中发送 /pair <配对码>。',
    },
    supportsTest: true,
    supportsPairing: true,
  },
  {
    value: 'wechat',
    label: '微信',
    description: '创建账号后使用微信扫码授权，再通过配对码授权具体微信会话。',
    authMode: 'qr_session',
    credentials: [],
    setupGuide: {
      title: '创建后使用微信扫码',
      steps: [
        '填写账号名称，并在下一步选择默认工作区。',
        '点击“创建并扫码”，CKQClaw 会生成微信登录二维码。',
        '用手机微信扫码确认；如微信要求验证码，直接在 CKQClaw 中输入。',
      ],
      nextStep:
        '扫码授权只建立渠道账号；连接后还需要生成配对码，授权具体微信会话。',
    },
    supportsTest: true,
    supportsPairing: true,
  },
];

export function providerDefinition(provider: ChannelProvider) {
  return CHANNEL_PROVIDER_OPTIONS.find((item) => item.value === provider)!;
}

export function providerLabel(provider: ChannelProvider): string {
  return providerDefinition(provider)?.label ?? provider;
}

export function providerAuthMode(provider: ChannelProvider): ChannelAuthMode {
  return providerDefinition(provider)?.authMode ?? 'credentials';
}

export function supportsChannelConnectionTest(
  provider: ChannelProvider,
): boolean {
  return providerDefinition(provider)?.supportsTest ?? false;
}

export function supportsChannelPairing(provider: ChannelProvider): boolean {
  return providerDefinition(provider)?.supportsPairing ?? false;
}

export function normalizeCredentials(values: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value.length > 0),
  );
}

export interface AccountFormValues {
  provider: ChannelProvider;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  defaultWorkspaceJid: string;
  credentials: Record<string, string>;
  replaceCredentials: boolean;
}

export function buildChannelAccountPayload(
  values: AccountFormValues,
  mode: 'create' | 'edit',
): ChannelAccountCreateInput | ChannelAccountPatchInput {
  const common = {
    name: values.name.trim(),
    enabled: values.enabled,
    is_default: values.isDefault,
    default_workspace_jid:
      values.defaultWorkspaceJid === 'none' ? null : values.defaultWorkspaceJid,
  };
  const credentials = normalizeCredentials(values.credentials);
  if (mode === 'create')
    return { ...common, provider: values.provider, credentials };
  return values.replaceCredentials ? { ...common, credentials } : common;
}

export function validateChannelAccountForm(
  values: AccountFormValues,
  mode: 'create' | 'edit',
) {
  if (!values.name.trim()) return '请输入账号名称';
  if (mode === 'edit' && !values.replaceCredentials) return null;
  const fields = providerDefinition(values.provider)?.credentials ?? [];
  const missing = fields.filter(
    (field) => field.required && !values.credentials[field.key]?.trim(),
  );
  return missing.length
    ? `请填写：${missing.map((field) => field.label).join('、')}`
    : null;
}

export interface AccountScopedChannel {
  channel_account_id?: string | null;
  channel_account_name?: string | null;
}

export function channelAccountKey(channel: AccountScopedChannel): string {
  return channel.channel_account_id || 'legacy-default';
}

export function buildChannelAccountFilterOptions(
  channels: AccountScopedChannel[],
) {
  const options = new Map<string, string>();
  for (const channel of channels) {
    const key = channelAccountKey(channel);
    if (!options.has(key)) {
      options.set(key, channel.channel_account_name || '默认账号（旧版）');
    }
  }
  return Array.from(options, ([id, name]) => ({ id, name }));
}
