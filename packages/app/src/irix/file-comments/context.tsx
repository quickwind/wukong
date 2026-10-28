// Irix: which file, in which workspace, the file view in front of the user shows. The editor's
// comment extension reads it; outside a provider (other panels, native) there are no comments.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { FileCommentContext } from "./context-value";
import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { PreviewComments } from "./preview-comments";
import { FileCommentSendButton } from "./send-button";

export const IrixFileCommentsContext = createContext<FileCommentContext | null>(null);

export function useIrixFileCommentContext(): FileCommentContext | null {
  return useContext(IrixFileCommentsContext);
}

function FileCommentsHost({
  serverId,
  workspaceId,
  filePath,
  children,
  file,
}: FileCommentContext & { children: ReactNode; file: PluginFilePanelProps["file"] }) {
  const value = useMemo(
    () => ({ serverId, workspaceId, filePath }),
    [serverId, workspaceId, filePath],
  );
  return (
    <IrixFileCommentsContext.Provider value={value}>
      <View style={styles.host}>
        {children}
        <FileCommentSendButton serverId={serverId} workspaceId={workspaceId} />
        <PreviewComments
          serverId={serverId}
          workspaceId={workspaceId}
          filePath={filePath}
          file={file}
        />
      </View>
    </IrixFileCommentsContext.Provider>
  );
}

/** What the built-in file panels render in: the context for the comments, and the send button. */
export function withIrixFileComments(
  props: {
    host: { id: string };
    workspaceId: string;
    params: { path: string };
    file: PluginFilePanelProps["file"];
  },
  children: ReactNode,
): ReactNode {
  return (
    <FileCommentsHost
      serverId={props.host.id}
      workspaceId={props.workspaceId}
      filePath={props.params.path}
      file={props.file}
    >
      {children}
    </FileCommentsHost>
  );
}

const styles = StyleSheet.create({ host: { flex: 1, minHeight: 0 } });
