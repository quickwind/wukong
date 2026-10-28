// Irix: comments from a rendered preview exist on web only. This is the native build's stand-in;
// preview-comments.web.tsx is the real one.
import type { PluginFilePanelProps } from "@getpaseo/plugin/client";

export interface PreviewCommentsProps {
  serverId: string;
  workspaceId: string;
  filePath: string;
  file: PluginFilePanelProps["file"];
}

export function PreviewComments(_props: PreviewCommentsProps) {
  return null;
}
