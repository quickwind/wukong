// Irix: the way to send file comments when there are no diff comments to send them with. The
// choice of agent and the send follow the diff's own send (review/feedback/use-feedback.ts).
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useAppSettings } from "@/hooks/use-settings";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { deriveWorkspaceTabModel } from "@/screens/workspace/workspace-tab-model";
import {
  WorkspaceTabIcon,
  WorkspaceTabPresentationResolver,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { buildFileCommentKey } from "./model";
import { takeFileCommentsForSend } from "./send";
import { useFileComments } from "./store";

const PROMPT =
  "Here are my comments on lines of files in this workspace. Please go through them and make the changes they ask for.";

interface Recipient {
  agentId: string;
  tab: WorkspaceTabDescriptor;
}

export function FileCommentSendButton({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const comments = useFileComments(buildFileCommentKey({ serverId, workspaceId }));
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const { settings } = useAppSettings();
  const toast = useToast();
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  // Subscribes this component to the workspace's tabs; the recipients are read fresh below.
  useWorkspaceLayoutStore((store) => (workspaceKey ? store.layoutByWorkspace[workspaceKey] : null));
  const recipients = readRecipients(workspaceKey);

  const send = useCallback(
    async (recipient: Recipient) => {
      if (!client) return;
      setFailure(null);
      setSending(true);
      const taken = takeFileCommentsForSend(serverId, workspaceId);
      try {
        const steer = settings.sendBehavior === "steer";
        await dispatchComposerAgentMessage({
          client,
          agentId: recipient.agentId,
          text: PROMPT,
          attachments: taken.attachments,
          encodeImages: async () => [],
          submission: createMessageSubmissionWriter(serverId),
          activeTurnBehavior: steer ? "steer" : "interrupt",
          activeTurnId: steer
            ? (selectAgentTurnPresentation(
                useSessionStore.getState().sessions[serverId],
                recipient.agentId,
              ).turnId ?? undefined)
            : undefined,
        });
        taken.clearSent();
        toast.show(<Text>Sent {countLabel(comments.length)} to the agent.</Text>, {
          variant: "success",
        });
      } catch (error) {
        setFailure(error instanceof Error ? error.message : "Could not send the comments.");
      } finally {
        setSending(false);
      }
    },
    [client, comments.length, serverId, settings.sendBehavior, toast, workspaceId],
  );

  if (comments.length === 0) return null;
  const unavailable = unavailableReason(connected, recipients.length);
  const label = sending ? "Sending…" : `Send ${countLabel(comments.length)} to an agent`;
  return (
    <View style={styles.container} pointerEvents="box-none">
      {failure || unavailable ? <Text style={styles.note}>{failure ?? unavailable}</Text> : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          style={styles.trigger}
          disabled={sending || unavailable !== null}
          accessibilityRole="button"
          accessibilityLabel={label}
          testID="irix-file-comments-send"
        >
          <Text style={styles.triggerText}>{label}</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="center">
          {recipients.map((recipient) => (
            <RecipientItem
              key={recipient.tab.key}
              recipient={recipient}
              serverId={serverId}
              workspaceId={workspaceId}
              onSend={send}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function RecipientItem({
  recipient,
  serverId,
  workspaceId,
  onSend,
}: {
  recipient: Recipient;
  serverId: string;
  workspaceId: string;
  onSend: (recipient: Recipient) => Promise<void>;
}) {
  const choose = useCallback(() => void onSend(recipient), [onSend, recipient]);
  const render = useCallback(
    (presentation: WorkspaceTabPresentation): ReactNode => (
      <RecipientRow presentation={presentation} onSelect={choose} />
    ),
    [choose],
  );
  return (
    <WorkspaceTabPresentationResolver
      tab={recipient.tab}
      serverId={serverId}
      workspaceId={workspaceId}
    >
      {render}
    </WorkspaceTabPresentationResolver>
  );
}

function RecipientRow({
  presentation,
  onSelect,
}: {
  presentation: WorkspaceTabPresentation;
  onSelect: () => void;
}) {
  const leading = useMemo(
    () => <WorkspaceTabIcon presentation={presentation} backdrop="surface0" />,
    [presentation],
  );
  return (
    <DropdownMenuItem leading={leading} onSelect={onSelect}>
      {presentation.label}
    </DropdownMenuItem>
  );
}

function countLabel(count: number): string {
  return count === 1 ? "1 comment" : `${count} comments`;
}

function unavailableReason(connected: boolean, recipientCount: number): string | null {
  if (!connected) return "The host is not connected.";
  if (recipientCount === 0) return "Open an agent tab to send to.";
  return null;
}

function readRecipients(workspaceKey: string | null): Recipient[] {
  const tabs = workspaceKey
    ? useWorkspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)
    : [];
  const recipients: Recipient[] = [];
  for (const { descriptor } of deriveWorkspaceTabModel({ tabs }).tabs) {
    if (descriptor.target.kind === "agent") {
      recipients.push({ agentId: descriptor.target.agentId, tab: descriptor });
    }
  }
  return recipients;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: theme.spacing[4],
    alignItems: "center",
    gap: theme.spacing[2],
  },
  trigger: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  triggerText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
}));
