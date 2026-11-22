import { ArrowRight, Loader2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAgentProfilesStore } from '@/stores/agent-profiles';

// ISSUE-12 波 5 单元 5.10：删除前工作区迁移对话框自
// web/src/pages/AgentProfilesPage.tsx 原文搬运（原 1361-1431）。
// JSX 逐字节一致；计划偏差留痕（同 5.5/5.9）：handleMigrateAndDelete/
// deleteSelectedProfile 留守页面，经同名 props 注入。

type Store = ReturnType<typeof useAgentProfilesStore.getState>;
type ProfileRow = Store['profiles'][number];
type GovernanceSnapshot = Store['governanceByProfile'][string];

export interface AgentDeleteMigrationDialogProps {
  deleteDialogOpen: boolean;
  setDeleteDialogOpen: Dispatch<SetStateAction<boolean>>;
  deleting: boolean;
  selected: ProfileRow | null;
  governance: GovernanceSnapshot | undefined;
  profiles: ProfileRow[];
  deleteTargetId: string;
  setDeleteTargetId: Dispatch<SetStateAction<string>>;
  handleMigrateAndDelete: () => void | Promise<void>;
}

export function AgentDeleteMigrationDialog(
  props: AgentDeleteMigrationDialogProps,
) {
  const {
    deleteDialogOpen,
    setDeleteDialogOpen,
    deleting,
    selected,
    governance,
    profiles,
    deleteTargetId,
    setDeleteTargetId,
    handleMigrateAndDelete,
  } = props;

  return (
    <Dialog
      open={deleteDialogOpen}
      onOpenChange={(open) => !deleting && setDeleteDialogOpen(open)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>迁移工作区后删除智能体</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="leading-6 text-muted-foreground">
            「{selected?.name}」仍归属 {governance?.workspaces.length ?? 0}{' '}
            个工作区。删除前必须把它们迁移到同一个目标
            智能体；渠道绑定会随工作区归属一起更新。
          </p>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              目标智能体
            </label>
            <Select
              value={deleteTargetId}
              onValueChange={setDeleteTargetId}
              disabled={deleting}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择目标智能体" />
              </SelectTrigger>
              <SelectContent>
                {profiles
                  .filter((profile) => profile.id !== selected?.id)
                  .map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.is_default ? '主智能体' : profile.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="max-h-40 overflow-auto rounded-md border bg-muted/20 p-2">
            {governance?.workspaces.map((workspace) => (
              <div
                key={workspace.jid}
                className="truncate px-1 py-1 text-xs text-muted-foreground"
              >
                {workspace.name} · {workspace.folder}
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setDeleteDialogOpen(false)}
            disabled={deleting}
          >
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleMigrateAndDelete()}
            disabled={deleting || !deleteTargetId}
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowRight className="h-4 w-4" />
            )}
            迁移并删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
