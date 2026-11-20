import { useState } from 'react';
import { AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  useMonitorStore,
  type UncertainChannelOutboxItem,
} from '../../stores/monitor';

const KIND_LABELS: Record<UncertainChannelOutboxItem['kind'], string> = {
  text: '文本',
  image: '图片',
  file: '文件',
  card: '卡片',
  mutation: '变更',
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 待人工确认的渠道投递（uncertain Channel Outbox）放行入口。
 *
 * 发送结果不明的 outbox 记录会围栏住整个回合，运行时无法自行判定，
 * 只能由管理员到目标会话核对后在这里人工放行；列表为空时整卡不渲染。
 */
export function UncertainOutboxCard() {
  const { uncertainItems, uncertainError, resolveUncertainOutbox } =
    useMonitorStore();
  const [messageIds, setMessageIds] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState<{
    id: string;
    resolution: 'delivered' | 'failed';
  } | null>(null);
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  // 列表为空时整卡不渲染
  if (uncertainItems.length === 0) return null;

  const handleResolve = async (
    item: UncertainChannelOutboxItem,
    resolution: 'delivered' | 'failed',
  ) => {
    const providerMessageId = (messageIds[item.id] ?? '').trim();
    if (resolution === 'delivered' && !providerMessageId) {
      setFeedback({ ok: false, text: '标记已投递前必须填写渠道消息 ID' });
      return;
    }
    setResolving({ id: item.id, resolution });
    setFeedback(null);
    try {
      await resolveUncertainOutbox(
        item.id,
        resolution,
        item.revision,
        providerMessageId || undefined,
      );
      setFeedback({
        ok: true,
        text: `已标记为${resolution === 'delivered' ? '已投递' : '投递失败'}，回合已放行`,
      });
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 409) {
        setFeedback({
          ok: false,
          text: '该记录已被他人处理或版本已更新，请依据最新列表重新确认',
        });
      } else {
        setFeedback({
          ok: false,
          text: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setResolving(null);
    }
  };

  return (
    <Card className="mb-6">
      <CardContent>
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              待人工确认的渠道投递
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              以下投递的发送结果不确定，已围栏整个回合：请到目标会话核对实际投递情况后放行，
              否则该回合将无法完成。标已投递须填写渠道消息 ID。
            </p>
          </div>
        </div>

        {uncertainError && (
          <div className="mb-3 text-sm text-error">
            加载待确认列表失败：{uncertainError}
          </div>
        )}
        {feedback && (
          <div
            className={`mb-3 flex items-center gap-2 text-sm ${feedback.ok ? 'text-success' : 'text-error'}`}
          >
            {feedback.ok ? (
              <CheckCircle className="w-4 h-4 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            )}
            {feedback.text}
          </div>
        )}

        <div className="space-y-3">
          {uncertainItems.map((item) => {
            const rowBusy = resolving?.id === item.id;
            return (
              <div
                key={item.id}
                className="rounded-lg border border-border p-3 space-y-2"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-xs text-foreground">
                    {item.id}
                  </span>
                  <Badge variant="warning">
                    {KIND_LABELS[item.kind] ?? item.kind}
                  </Badge>
                  <span className="text-muted-foreground">
                    {item.provider}
                    {item.chatId ? ` · ${item.chatId}` : ''}
                  </span>
                  <span className="text-muted-foreground">
                    第 {item.attempt} 次尝试
                  </span>
                  <span className="text-muted-foreground">
                    更新于 {formatTime(item.updatedAt)}
                  </span>
                  <span className="text-muted-foreground font-mono text-xs">
                    revision {item.revision}
                  </span>
                </div>
                {item.error && (
                  <p className="text-xs text-error break-all">{item.error}</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={messageIds[item.id] ?? ''}
                    onChange={(e) =>
                      setMessageIds((prev) => ({
                        ...prev,
                        [item.id]: e.target.value,
                      }))
                    }
                    placeholder="渠道消息 ID（providerMessageId，标已投递必填）"
                    className="w-72"
                    disabled={rowBusy}
                  />
                  <Button
                    onClick={() => handleResolve(item, 'delivered')}
                    disabled={resolving !== null}
                  >
                    {rowBusy && resolving?.resolution === 'delivered' && (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    )}
                    标已投递
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => handleResolve(item, 'failed')}
                    disabled={resolving !== null}
                  >
                    {rowBusy && resolving?.resolution === 'failed' && (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    )}
                    标失败
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
