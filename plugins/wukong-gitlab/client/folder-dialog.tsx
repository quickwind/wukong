import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { breadcrumbsOf } from "../shared/breadcrumbs.js";
import { createFolderRpc, listFoldersRpc, type FolderListing } from "../shared/rpc.js";

type Theme = PluginScreenProps["theme"];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createStyles(theme: Theme) {
  const { colors } = theme;
  return {
    backdrop: {
      flex: 1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      padding: 16,
      backgroundColor: "rgba(0, 0, 0, 0.55)",
    },
    dialog: {
      width: "100%" as const,
      maxWidth: 880,
      height: 640,
      maxHeight: "100%" as const,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface1,
      overflow: "hidden" as const,
    },
    header: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      padding: 16,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    title: { color: colors.foreground, fontSize: 16, fontWeight: "600" as const },
    close: { color: colors.foregroundMuted, fontSize: 18 },
    content: { flex: 1, padding: 16 },
    inlineSpaced: {
      marginTop: 12,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      gap: 8,
    },
    inline: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      gap: 8,
    },
    pill: {
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface2,
    },
    pillText: { color: colors.foreground, fontSize: 13, fontWeight: "500" as const },
    muted: { color: colors.foregroundMuted, fontSize: 13 },
    spaced: { marginTop: 12 },
    newInput: {
      flex: 1,
      color: colors.foreground,
      backgroundColor: colors.surface0,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      paddingVertical: 8,
      paddingHorizontal: 10,
      fontSize: 13,
    },
    crumb: { color: colors.accent, fontSize: 13, fontWeight: "500" as const },
    crumbCurrent: { color: colors.foreground, fontSize: 13, fontWeight: "600" as const },
    input: {
      marginTop: 12,
      color: colors.foreground,
      backgroundColor: colors.surface0,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      paddingVertical: 8,
      paddingHorizontal: 10,
      fontSize: 13,
    },
    row: { paddingVertical: 9, paddingHorizontal: 8, borderRadius: 6 },
    rowText: { color: colors.foreground, fontSize: 14, fontWeight: "500" as const },
    empty: { color: colors.foregroundMuted, textAlign: "center" as const, paddingVertical: 32 },
    error: { color: colors.statusDanger, marginTop: 12 },
    footer: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      padding: 16,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    selected: { flex: 1 },
    selectedPath: { color: colors.foreground, fontSize: 13 },
    button: {
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 6,
      backgroundColor: colors.accent,
    },
    buttonDisabled: {
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 6,
      backgroundColor: colors.accent,
      opacity: 0.5,
    },
    buttonText: { color: colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
    secondary: {
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: colors.border,
    },
    secondaryText: { color: colors.foreground, fontSize: 13 },
  };
}

type Styles = ReturnType<typeof createStyles>;

interface PathButtonProps {
  path: string;
  icon?: string;
  label: string;
  style: Styles["row"] | Styles["pill"] | undefined;
  textStyle: Styles["rowText"] | Styles["crumb"] | Styles["crumbCurrent"] | Styles["pillText"];
  onOpen(path: string): void;
}

function PathButton({ path, icon, label, style, textStyle, onOpen }: PathButtonProps) {
  const press = useCallback(() => onOpen(path), [onOpen, path]);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} style={style} onPress={press}>
      <Text style={textStyle}>{icon ? `${icon}  ${label}` : label}</Text>
    </Pressable>
  );
}

interface FolderRowsProps {
  listing: FolderListing | null;
  folders: FolderListing["folders"];
  loading: boolean;
  error: string | null;
  styles: Styles;
  onOpen(path: string): void;
}

function FolderRows({ listing, folders, loading, error, styles, onOpen }: FolderRowsProps) {
  return (
    <View style={styles.spaced}>
      {listing?.parent != null ? (
        <PathButton
          path={listing.parent}
          icon="📁"
          label=".. (Up to parent)"
          style={styles.row}
          textStyle={styles.rowText}
          onOpen={onOpen}
        />
      ) : null}
      {loading ? <Text style={styles.empty}>Loading folders...</Text> : null}
      {!loading && !error && folders.length === 0 ? (
        <Text style={styles.empty}>No matching folders found</Text>
      ) : null}
      {loading
        ? null
        : folders.map((folder) => (
            <PathButton
              key={folder.path}
              icon="📁"
              path={folder.path}
              label={folder.name}
              style={styles.row}
              textStyle={styles.rowText}
              onOpen={onOpen}
            />
          ))}
    </View>
  );
}

interface Props {
  theme: Theme;
  onSelect(path: string): void;
  onClose(): void;
}

/** Browses the disk of the machine the daemon runs on, and makes new folders, to pick one. */
export function FolderDialog({ theme, onSelect, onClose }: Props) {
  const list = useRpc(listFoldersRpc);
  const create = useRpc(createFolderRpc);
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [location, setLocation] = useState<string | undefined>(undefined);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const next = await list({ path: location });
        if (!current) return;
        setListing(next);
        setTyped(next.path);
        setSearch("");
        setNaming(false);
      } catch (failure) {
        if (current) setError(messageOf(failure));
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [list, location]);

  const goTyped = useCallback(() => setLocation(typed.trim() || undefined), [typed]);
  const choose = useCallback(() => {
    if (listing?.path) onSelect(listing.path);
  }, [listing?.path, onSelect]);
  const startNaming = useCallback(() => {
    setNewName("");
    setError(null);
    setNaming(true);
  }, []);
  const stopNaming = useCallback(() => setNaming(false), []);
  const submitNew = useCallback(async () => {
    if (!listing?.path) return;
    try {
      // The new folder is opened, as the Windows dialog does.
      setLocation((await create({ parent: listing.path, name: newName })).path);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [create, listing?.path, newName]);
  const submitNewVoid = useCallback(() => void submitNew(), [submitNew]);

  const crumbs = useMemo(() => breadcrumbsOf(listing?.path ?? ""), [listing?.path]);
  const folders = useMemo(() => {
    const query = search.trim().toLowerCase();
    const all = listing?.folders ?? [];
    return query ? all.filter((folder) => folder.name.toLowerCase().includes(query)) : all;
  }, [listing?.folders, search]);
  const canChoose = !!listing?.path;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <View style={styles.header}>
            <Text style={styles.title}>Select folder</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.content} keyboardShouldPersistTaps="always">
            {listing && listing.shortcuts.length > 0 ? (
              <View style={styles.inline}>
                <Text style={styles.muted}>Quick:</Text>
                {listing.shortcuts.map((shortcut) => (
                  <PathButton
                    key={shortcut.path}
                    icon={shortcut.label === "OneDrive" ? "☁️" : "📁"}
                    path={shortcut.path}
                    label={shortcut.label}
                    style={styles.pill}
                    textStyle={styles.pillText}
                    onOpen={setLocation}
                  />
                ))}
              </View>
            ) : null}
            <View style={styles.inlineSpaced}>
              {crumbs.map((crumb, index) => (
                <Fragment key={crumb.path}>
                  {index > 1 || (index === 1 && crumbs[0]?.label !== "/") ? (
                    <Text style={styles.muted}>/</Text>
                  ) : null}
                  <PathButton
                    path={crumb.path}
                    label={crumb.label}
                    style={undefined}
                    textStyle={index === crumbs.length - 1 ? styles.crumbCurrent : styles.crumb}
                    onOpen={setLocation}
                  />
                </Fragment>
              ))}
            </View>
            <TextInput
              style={styles.input}
              value={typed}
              onChangeText={setTyped}
              onSubmitEditing={goTyped}
              placeholder="Type or paste a path, then press Enter"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Folder path"
            />
            <TextInput
              style={styles.input}
              value={search}
              onChangeText={setSearch}
              placeholder="Search folders in this directory..."
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Search folders"
            />
            {naming ? (
              <View style={styles.inlineSpaced}>
                <TextInput
                  style={styles.newInput}
                  value={newName}
                  onChangeText={setNewName}
                  onSubmitEditing={submitNewVoid}
                  placeholder="New folder name"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  accessibilityLabel="New folder name"
                />
                <Pressable accessibilityRole="button" style={styles.secondary} onPress={stopNaming}>
                  <Text style={styles.secondaryText}>Cancel</Text>
                </Pressable>
                <Pressable accessibilityRole="button" style={styles.button} onPress={submitNewVoid}>
                  <Text style={styles.buttonText}>Create</Text>
                </Pressable>
              </View>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <FolderRows
              listing={listing}
              folders={folders}
              loading={loading}
              error={error}
              styles={styles}
              onOpen={setLocation}
            />
          </ScrollView>
          <View style={styles.footer}>
            <Pressable
              accessibilityRole="button"
              style={styles.secondary}
              disabled={!canChoose || naming}
              onPress={startNaming}
            >
              <Text style={styles.secondaryText}>New folder</Text>
            </Pressable>
            <View style={styles.selected}>
              <Text style={styles.muted}>Selected:</Text>
              <Text style={styles.selectedPath} numberOfLines={1}>
                {listing?.path || "(none)"}
              </Text>
            </View>
            <Pressable accessibilityRole="button" style={styles.secondary} onPress={onClose}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose folder"
              style={canChoose ? styles.button : styles.buttonDisabled}
              disabled={!canChoose}
              onPress={choose}
            >
              <Text style={styles.buttonText}>Choose Folder</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
