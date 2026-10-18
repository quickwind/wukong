import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import type { MessagePayload } from "@/composer/types";
import type { PanelDescriptor } from "@/panels/panel-registry";
import { IRIX_BUILD } from "./build";

const AdaptiveTextInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

// Names typed next to a Create button, by what they are for. Module state because upstream builds
// the create request deep inside its own code, and one line there is cheaper than threading a prop.
const typedNames = new Map<string, string>();
const WORKSPACE_KEY = "workspace";

// Chat names the user has confirmed with Create chat, by draft id. The draft tab is titled with
// the name and the agent is created with it once the first message is sent.
const useChatNames = create<{ names: Record<string, string> }>(() => ({ names: {} }));

function typedTitle(key: string): { title?: string } {
  const title = typedNames.get(key)?.trim();
  return IRIX_BUILD && title ? { title } : {};
}

/** The `title` of a create-workspace request: spread into it. Empty when no name was typed. */
export function irixWorkspaceTitleField(): { title?: string } {
  return typedTitle(WORKSPACE_KEY);
}

/** The `title` of a draft agent's config: spread into it. Empty when no name was given. */
export function irixAgentTitleField(draftId: string): { title?: string } {
  const named = useChatNames.getState().names[draftId];
  return named ? { title: named } : typedTitle(draftId);
}

/** A draft chat tab's descriptor, titled with the name given to it (if any). */
export function useIrixDraftDescriptor(descriptor: PanelDescriptor, draftId: string) {
  const name = useChatNames((state) => state.names[draftId]);
  return IRIX_BUILD && name ? { ...descriptor, label: name, tooltip: name } : descriptor;
}

interface NameAndCreateBarProps {
  nameKey: string;
  placeholder: string;
  label: string;
  createLabel: string;
  onCreate(name: string): void;
  error?: string | null;
  onChangeName?(): void;
  pending?: boolean;
}

function NameAndCreateBar({
  nameKey,
  placeholder,
  label,
  createLabel,
  onCreate,
  error = null,
  onChangeName,
  pending = false,
}: NameAndCreateBarProps) {
  const handleCreate = useCallback(
    () => onCreate(typedNames.get(nameKey)?.trim() ?? ""),
    [onCreate, nameKey],
  );
  useEffect(() => {
    typedNames.delete(nameKey);
    return () => {
      typedNames.delete(nameKey);
    };
  }, [nameKey]);
  const changeName = useCallback(
    (value: string) => {
      typedNames.set(nameKey, value);
      onChangeName?.();
    },
    [nameKey, onChangeName],
  );
  if (!IRIX_BUILD) return null;
  return (
    <View style={styles.block}>
      <View style={styles.content}>
        <View style={styles.row}>
          <AdaptiveTextInput
            initialValue=""
            onChangeText={changeName}
            onSubmitEditing={handleCreate}
            placeholder={placeholder}
            editable={!pending}
            style={styles.input}
            accessibilityLabel={label}
            testID={`irix-name-${nameKey}`}
          />
          <Button
            variant="default"
            size="md"
            onPress={handleCreate}
            disabled={pending}
            testID={`irix-create-${nameKey}`}
          >
            {createLabel}
          </Button>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  );
}

interface IrixCreateWorkspaceBarProps {
  submit(payload: MessagePayload): Promise<void>;
  pending: boolean;
}

/**
 * A name and a Create button for the New workspace screen: make the workspace first, chat after.
 * Create is upstream's own empty submit (a workspace with no agent). Sending a message from the
 * composer still creates the workspace as before, using the name if one was typed. The empty path
 * creates the workspace in the screen's own chosen directory, so no cwd is passed.
 */
export function IrixCreateWorkspaceBar({ submit, pending }: IrixCreateWorkspaceBarProps) {
  const handleCreate = useCallback(
    () => void submit({ text: "", attachments: [], cwd: "" }),
    [submit],
  );
  return (
    <NameAndCreateBar
      nameKey={WORKSPACE_KEY}
      placeholder="Workspace name (optional; if empty, named from your first message)"
      label="Workspace name"
      createLabel="Create workspace"
      onCreate={handleCreate}
      pending={pending}
    />
  );
}

/**
 * The same for a new chat tab, except that nothing is created yet (so no model is needed): Create
 * chat titles the tab with the name and hides the bar, and the chat is created with that name when
 * the first message is sent. A chat must have a name to be created this way.
 */
export function IrixCreateAgentBar({ draftId }: { draftId: string }) {
  const named = useChatNames((state) => Boolean(state.names[draftId]));
  const [error, setError] = useState<string | null>(null);
  const handleCreate = useCallback(
    (name: string) => {
      if (!name) {
        setError("Give the chat a name, or just type your first message.");
        return;
      }
      useChatNames.setState((state) => ({ names: { ...state.names, [draftId]: name } }));
    },
    [draftId],
  );
  const clearError = useCallback(() => setError(null), []);
  if (named) return null;
  return (
    <NameAndCreateBar
      nameKey={draftId}
      placeholder="Chat name (optional; if empty, named from your first message)"
      label="Chat name"
      createLabel="Create chat"
      onCreate={handleCreate}
      error={error}
      onChangeName={clearError}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  // The same two-layer width as the composer below: inset, then a centered column.
  block: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[3],
  },
  content: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  input: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
