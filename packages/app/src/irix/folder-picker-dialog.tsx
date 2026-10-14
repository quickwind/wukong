import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { useGlobalWebOverlayLayer, useWebOverlayRegistration } from "@/lib/overlay-root";
import {
  breadcrumbsOf,
  createFolder,
  listFolders,
  settleFolderPick,
  usePendingFolderPick,
  type FolderListing,
  type FolderPickerClient,
} from "./folder-picker";

const AdaptiveTextInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

interface DialogShellProps {
  title: string;
  footer: ReactNode;
  onClose(): void;
  children: ReactNode;
}

/**
 * The dialog is drawn inside Add project's own modal, not in the app's overlay root. Add project
 * is a react-native-web Modal that traps focus inside itself; a dialog outside it makes the two
 * pull focus back and forth forever and freezes the page. The dialog registers as the top overlay
 * so Escape and Tab belong to it, and it sits inside the Modal's DOM so the trap is satisfied.
 */
function DialogShell({ title, footer, onClose, children }: DialogShellProps) {
  const layer = useGlobalWebOverlayLayer("modal", true);
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      onClose();
      return true;
    },
    [onClose],
  );
  const setScope = useWebOverlayRegistration({ active: true, layer, onKeyDown });
  return (
    <View style={styles.overlay} testID="irix-folder-picker">
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View ref={setScope} style={styles.card}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.content} keyboardShouldPersistTaps="always">
          {children}
        </ScrollView>
        <View style={styles.footer}>{footer}</View>
      </View>
    </View>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type HoverState = PressableStateCallbackType & { hovered?: boolean };

interface PathButtonProps {
  path: string;
  icon?: string;
  label: string;
  variant: "pill" | "row" | "crumb" | "crumb-current";
  onOpen(path: string): void;
}

function textStyleFor(variant: PathButtonProps["variant"]) {
  if (variant === "crumb") return styles.crumb;
  if (variant === "crumb-current") return styles.crumbCurrent;
  if (variant === "pill") return styles.pillText;
  return styles.rowText;
}

function PathButton({ path, icon, label, variant, onOpen }: PathButtonProps) {
  const press = useCallback(() => onOpen(path), [onOpen, path]);
  const style = useCallback(
    ({ hovered = false, pressed }: HoverState) => [
      variant === "pill" && styles.pill,
      variant === "row" && styles.row,
      (hovered || pressed) && variant !== "crumb" && variant !== "crumb-current" && styles.active,
    ],
    [variant],
  );
  const textStyle = textStyleFor(variant);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={press} style={style}>
      <View style={styles.inline}>
        {icon ? <Text style={styles.icon}>{icon}</Text> : null}
        <Text style={textStyle} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

interface FolderRowsProps {
  listing: FolderListing | null;
  folders: FolderListing["folders"];
  loading: boolean;
  error: string | null;
  onOpen(path: string): void;
}

function FolderRows({ listing, folders, loading, error, onOpen }: FolderRowsProps) {
  return (
    <View>
      {listing?.parent != null ? (
        <PathButton
          variant="row"
          icon="📁"
          label=".. (Up to parent)"
          path={listing.parent}
          onOpen={onOpen}
        />
      ) : null}
      {loading ? <Text style={styles.empty}>Loading folders...</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!loading && !error && folders.length === 0 ? (
        <Text style={styles.empty}>No matching folders found</Text>
      ) : null}
      {loading
        ? null
        : folders.map((folder) => (
            <PathButton
              key={folder.path}
              variant="row"
              icon="📁"
              label={folder.name}
              path={folder.path}
              onOpen={onOpen}
            />
          ))}
    </View>
  );
}

function FolderPickerDialog({ client }: { client: FolderPickerClient }) {
  const [location, setLocation] = useState<string | undefined>(undefined);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [naming, setNaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const pathInput = useRef<EditingTextInputHandle>(null);
  const typedPath = useRef("");
  const newName = useRef("");

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const next = await listFolders(client, location);
        if (!current) return;
        setListing(next);
        setSearch("");
        setNaming(false);
        typedPath.current = next.path;
        pathInput.current?.replaceText(next.path);
      } catch (failure) {
        if (current) setError(messageOf(failure));
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => {
      current = false;
    };
  }, [client, location]);

  const cancel = useCallback(() => settleFolderPick(null), []);
  const choose = useCallback(() => {
    if (listing?.path) settleFolderPick(listing.path);
  }, [listing?.path]);
  const changePath = useCallback((text: string) => {
    typedPath.current = text;
  }, []);
  const goTyped = useCallback(() => setLocation(typedPath.current.trim() || undefined), []);
  const changeName = useCallback((text: string) => {
    newName.current = text;
  }, []);
  const startNaming = useCallback(() => {
    newName.current = "";
    setError(null);
    setNaming(true);
  }, []);
  const stopNaming = useCallback(() => setNaming(false), []);
  const create = useCallback(async () => {
    if (!listing?.path || creating) return;
    setCreating(true);
    setError(null);
    try {
      // Opening the new folder is what the Windows dialog does, and it is where the user is going.
      setLocation(await createFolder(client, listing.path, newName.current));
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setCreating(false);
    }
  }, [client, creating, listing?.path]);
  const submitCreate = useCallback(() => void create(), [create]);

  const crumbs = useMemo(() => breadcrumbsOf(listing?.path ?? ""), [listing?.path]);
  const folders = useMemo(() => {
    const query = search.trim().toLowerCase();
    const all = listing?.folders ?? [];
    return query ? all.filter((folder) => folder.name.toLowerCase().includes(query)) : all;
  }, [listing?.folders, search]);
  const canChoose = !!listing?.path;

  const footer = (
    <>
      <Button variant="secondary" size="sm" onPress={startNaming} disabled={!canChoose || naming}>
        New folder
      </Button>
      <View style={styles.selected}>
        <Text style={styles.muted}>Selected:</Text>
        <Text style={styles.selectedPath} numberOfLines={1}>
          {listing?.path || "(none)"}
        </Text>
      </View>
      <Button variant="secondary" size="sm" onPress={cancel}>
        Cancel
      </Button>
      <Button variant="default" size="sm" onPress={choose} disabled={!canChoose}>
        Choose Folder
      </Button>
    </>
  );

  return (
    <DialogShell title="Select folder" footer={footer} onClose={cancel}>
      <View style={styles.body}>
        {listing && listing.shortcuts.length > 0 ? (
          <View style={styles.shortcuts}>
            <Text style={styles.muted}>Quick:</Text>
            {listing.shortcuts.map((shortcut) => (
              <PathButton
                key={shortcut.path}
                variant="pill"
                icon={shortcut.label === "OneDrive" ? "☁️" : "📁"}
                label={shortcut.label}
                path={shortcut.path}
                onOpen={setLocation}
              />
            ))}
          </View>
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.inline}>
            {crumbs.map((crumb, index) => (
              <Fragment key={crumb.path}>
                {index > 1 || (index === 1 && crumbs[0]?.label !== "/") ? (
                  <Text style={styles.muted}> / </Text>
                ) : null}
                <PathButton
                  variant={index === crumbs.length - 1 ? "crumb-current" : "crumb"}
                  label={crumb.label}
                  path={crumb.path}
                  onOpen={setLocation}
                />
              </Fragment>
            ))}
          </View>
        </ScrollView>
        <AdaptiveTextInput
          ref={pathInput}
          initialValue=""
          onChangeText={changePath}
          onSubmitEditing={goTyped}
          placeholder="Type or paste a path, then press Enter"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          accessibilityLabel="Folder path"
        />
        <AdaptiveTextInput
          key={listing?.path}
          initialValue=""
          onChangeText={setSearch}
          placeholder="Search folders in this directory..."
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          accessibilityLabel="Search folders"
        />
        {naming ? (
          <View style={styles.newRow}>
            <AdaptiveTextInput
              initialValue=""
              onChangeText={changeName}
              onSubmitEditing={submitCreate}
              placeholder="New folder name"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              style={[styles.input, styles.grow]}
              accessibilityLabel="New folder name"
            />
            <Button variant="secondary" size="sm" onPress={stopNaming}>
              Cancel
            </Button>
            <Button variant="default" size="sm" onPress={submitCreate} disabled={creating}>
              Create
            </Button>
          </View>
        ) : null}
        <FolderRows
          listing={listing}
          folders={folders}
          loading={loading}
          error={error}
          onOpen={setLocation}
        />
      </View>
    </DialogShell>
  );
}

/** Draws the folder dialog while one is asked for. Mounted once, inside Add project. */
export function FolderPickerHost() {
  const pending = usePendingFolderPick();
  return pending ? <FolderPickerDialog client={pending.client} /> : null;
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0, 0, 0, 0.55)" },
  card: {
    width: 880,
    maxWidth: "100%",
    height: 640,
    maxHeight: "100%",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
    ...theme.shadow.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  close: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.lg },
  content: { flex: 1, minHeight: 0, padding: theme.spacing[4] },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  body: { gap: theme.spacing[3] },
  inline: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  shortcuts: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  pill: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  pillText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  icon: { fontSize: theme.fontSize.base },
  crumb: { color: theme.colors.accent, fontSize: theme.fontSize.sm },
  crumbCurrent: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.sm,
  },
  grow: { flex: 1 },
  newRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  row: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  active: { backgroundColor: theme.colors.surface2 },
  rowText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
  },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  selected: { flex: 1, minWidth: 0, gap: 2 },
  selectedPath: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
