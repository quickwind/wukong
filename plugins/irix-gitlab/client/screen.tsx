import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { needsGitLabSetup } from "../shared/setup-hint.js";
import { FolderDialog } from "./folder-dialog.js";
import {
  pollCloneRpc,
  searchProjectsRpc,
  startCloneRpc,
  type CloneResult,
  type GitLabProject,
} from "../shared/rpc.js";

const SEARCH_DELAY_MS = 300;

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const POLL_INTERVAL_MS = 1000;
const GIVE_UP_AFTER_MS = 30 * 60 * 1000;

type CloneState =
  | { status: "idle" }
  | { status: "running"; path: string; fork: boolean; steps: string[] }
  | { status: "done"; path: string; fork: boolean; steps: string[]; result: CloneResult }
  | { status: "failed"; path: string; fork: boolean; steps: string[]; error: string };

const OPENING_STEP = "Opening the project…";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Starts a clone (or fork then clone) on the daemon, follows it, and opens the result. */
function useCloneJob(parentDirectory: string) {
  const start = useRpc(startCloneRpc);
  const poll = useRpc(pollCloneRpc);
  const paseo = usePaseo();
  const [state, setState] = useState<CloneState>({ status: "idle" });
  const running = state.status === "running";

  const run = useCallback(
    async (project: GitLabProject, fork: boolean) => {
      if (running) return;
      const path = project.path;
      let steps = ["Starting…"];
      setState({ status: "running", path, fork, steps });
      try {
        const { id } = await start({
          path,
          fork,
          parentDirectory: parentDirectory.trim() || undefined,
        });
        for (let waited = 0; waited <= GIVE_UP_AFTER_MS; waited += POLL_INTERVAL_MS) {
          const job = await poll({ id });
          steps = job.steps.length > 0 ? job.steps : steps;
          if (job.state === "failed") throw new Error(job.error ?? "The clone failed");
          if (job.state === "done" && job.result) {
            setState({ status: "running", path, fork, steps: [...steps, OPENING_STEP] });
            await paseo.workspaces.open(job.result.directory);
            setState({
              status: "done",
              path,
              fork,
              steps: [...steps, OPENING_STEP],
              result: job.result,
            });
            return;
          }
          setState({ status: "running", path, fork, steps });
          await sleep(POLL_INTERVAL_MS);
        }
        throw new Error("The clone is taking too long; check the daemon log");
      } catch (error) {
        setState({ status: "failed", path, fork, steps, error: messageOf(error) });
      }
    },
    [running, start, poll, paseo, parentDirectory],
  );

  const dismiss = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, dismiss };
}

function createStyles(theme: PluginScreenProps["theme"], compact: boolean) {
  return {
    screen: {
      flex: 1,
      padding: compact ? 16 : 24,
      backgroundColor: theme.colors.surface0,
    },
    label: { color: theme.colors.foregroundMuted, marginBottom: 4, marginTop: 12 },
    input: {
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 6,
      padding: 10,
    },
    row: {
      padding: 12,
      marginTop: 8,
      borderRadius: 6,
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
      borderWidth: 1,
    },
    title: { color: theme.colors.foreground, fontWeight: "600" as const },
    muted: { color: theme.colors.foregroundMuted, marginTop: 2 },
    button: {
      marginTop: 8,
      padding: 8,
      alignSelf: "flex-start" as const,
      borderRadius: 6,
      backgroundColor: theme.colors.accent,
    },
    buttonText: { color: theme.colors.accentForeground },
    buttons: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
    secondaryButton: {
      marginTop: 8,
      padding: 8,
      alignSelf: "flex-start" as const,
      borderRadius: 6,
      borderColor: theme.colors.accent,
      borderWidth: 1,
    },
    secondaryButtonText: { color: theme.colors.accent },
    backdrop: {
      flex: 1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      padding: 16,
      backgroundColor: "rgba(0, 0, 0, 0.5)",
    },
    dialog: {
      width: "100%" as const,
      maxWidth: 520,
      padding: 20,
      borderRadius: 10,
      backgroundColor: theme.colors.surface0,
      borderColor: theme.colors.border,
      borderWidth: 1,
    },
    dialogTitle: { color: theme.colors.foreground, fontWeight: "700" as const, fontSize: 16 },
    dialogSubtitle: { color: theme.colors.foregroundMuted, marginTop: 2 },
    stepRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      marginTop: 10,
      gap: 10,
    },
    stepMark: { width: 18, textAlign: "center" as const, color: theme.colors.statusSuccess },
    stepMarkFailed: { width: 18, textAlign: "center" as const, color: theme.colors.statusDanger },
    stepText: { color: theme.colors.foreground, flexShrink: 1 },
    stepTextPending: { color: theme.colors.foregroundMuted, flexShrink: 1 },
    dialogFooter: {
      marginTop: 18,
      flexDirection: "row" as const,
      justifyContent: "flex-end" as const,
    },
    error: { color: theme.colors.statusDanger, marginTop: 12 },
    success: { color: theme.colors.statusSuccess, marginTop: 12 },
  };
}

interface ProjectRowProps {
  project: GitLabProject;
  styles: ReturnType<typeof createStyles>;
  busy: boolean;
  /** What the running job on this row is doing, or null if it is not the running row. */
  activeKind: "clone" | "fork" | null;
  onClone(project: GitLabProject, fork: boolean): void;
}

function ProjectRow({ project, styles, busy, activeKind, onClone }: ProjectRowProps) {
  const pressClone = useCallback(() => onClone(project, false), [onClone, project]);
  const pressFork = useCallback(() => onClone(project, true), [onClone, project]);
  // Projects that are not the user's own (a team's, or one a colleague shared) are cloned through
  // the user's own fork; the user's own projects are cloned as they are.
  const offersFork = project.canFork;
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{project.path}</Text>
      {project.forkedFrom ? <Text style={styles.muted}>Fork of {project.forkedFrom}</Text> : null}
      {project.description ? <Text style={styles.muted}>{project.description}</Text> : null}
      <View style={styles.buttons}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Clone ${project.path}`}
          style={styles.button}
          disabled={busy}
          onPress={pressClone}
        >
          <Text style={styles.buttonText}>
            {activeKind === "clone" ? "Cloning…" : "Clone and open"}
          </Text>
        </Pressable>
        {offersFork ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Fork and clone ${project.path}`}
            style={styles.secondaryButton}
            disabled={busy}
            onPress={pressFork}
          >
            <Text style={styles.secondaryButtonText}>
              {activeKind === "fork" ? "Forking…" : "Fork clone"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function StepList({
  state,
  styles,
  theme,
}: {
  state: Exclude<CloneState, { status: "idle" }>;
  styles: ReturnType<typeof createStyles>;
  theme: PluginScreenProps["theme"];
}) {
  return (
    <View>
      {state.steps.map((step, index) => {
        const isLast = index === state.steps.length - 1;
        const current = isLast && state.status === "running";
        const failed = isLast && state.status === "failed";
        return (
          <View key={step} style={styles.stepRow}>
            {current ? (
              <ActivityIndicator size="small" color={theme.colors.accent} />
            ) : (
              <Text style={failed ? styles.stepMarkFailed : styles.stepMark}>
                {failed ? "✕" : "✓"}
              </Text>
            )}
            <Text style={current ? styles.stepText : styles.stepTextPending}>{step}</Text>
          </View>
        );
      })}
    </View>
  );
}

function ProgressDialog({
  state,
  styles,
  theme,
  onClose,
}: {
  state: CloneState;
  styles: ReturnType<typeof createStyles>;
  theme: PluginScreenProps["theme"];
  onClose(): void;
}) {
  if (state.status === "idle") return null;
  const finished = state.status !== "running";
  return (
    <Modal visible transparent animationType="fade" onRequestClose={finished ? onClose : undefined}>
      <View style={styles.backdrop}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <Text style={styles.dialogTitle}>{state.fork ? "Fork clone" : "Clone and open"}</Text>
          <Text style={styles.dialogSubtitle}>{state.path}</Text>
          <StepList state={state} styles={styles} theme={theme} />
          {state.status === "done" ? <Text style={styles.success}>{describe(state)}</Text> : null}
          {state.status === "failed" ? <Text style={styles.error}>{state.error}</Text> : null}
          {finished ? (
            <View style={styles.dialogFooter}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={styles.button}
                onPress={onClose}
              >
                <Text style={styles.buttonText}>Close</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function activeKindFor(state: CloneState, path: string): "clone" | "fork" | null {
  if (state.status !== "running" || state.path !== path) return null;
  return state.fork ? "fork" : "clone";
}

function describe(state: Extract<CloneState, { status: "done" }>): string {
  const { result } = state;
  if (result.forkedFrom) {
    return (
      `${result.alreadyCloned ? "Opened your existing clone of" : "Forked and cloned"} ` +
      `${result.clonedPath} in ${result.directory}. Its "upstream" remote is ${result.forkedFrom}.`
    );
  }
  return `${result.alreadyCloned ? "Opened existing clone " : "Cloned and opened "}${result.directory}`;
}

export function AddFromGitLabScreen({
  theme,
  layout,
  openGitLabSettings,
}: PluginScreenProps & { openGitLabSettings?: () => void }) {
  const search = useRpc(searchProjectsRpc);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [localFolder, setLocalFolder] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const debouncedQuery = useDebounced(query);
  const paseo = usePaseo();

  const results = useQuery({
    queryKey: ["irix-gitlab", "search", debouncedQuery],
    queryFn: () => search({ query: debouncedQuery }),
  });
  const cloneRoot = results.data?.cloneRoot ?? "";

  const { state: cloneState, run: runClone, dismiss } = useCloneJob(folder);

  const openLocal = useMutation({
    mutationFn: async (directory: string) => (await paseo.workspaces.open(directory)).directory,
  });
  const openBrowsed = useCallback(
    (directory: string) => {
      setBrowsing(false);
      setLocalFolder(directory);
      openLocal.mutate(directory);
    },
    [openLocal],
  );
  const startBrowsing = useCallback(() => setBrowsing(true), []);
  const stopBrowsing = useCallback(() => setBrowsing(false), []);
  const openLocalFolder = useCallback(() => {
    const directory = localFolder.trim();
    if (directory) openLocal.mutate(directory);
  }, [localFolder, openLocal]);

  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);

  return (
    <View style={styles.screen}>
      <Text style={styles.label}>Search your GitLab projects</Text>
      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="group/project"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Search GitLab projects"
      />
      <Text style={styles.label}>Clone into</Text>
      <TextInput
        style={styles.input}
        value={folder}
        onChangeText={setFolder}
        placeholder={cloneRoot || "Default folder"}
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Folder to clone into"
      />

      <Text style={styles.label}>Or open a folder that is already on this machine</Text>
      <TextInput
        style={styles.input}
        value={localFolder}
        onChangeText={setLocalFolder}
        onSubmitEditing={openLocalFolder}
        placeholder="/absolute/path/to/project"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Local folder to open"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open local folder"
        style={styles.button}
        disabled={openLocal.isPending || !localFolder.trim()}
        onPress={openLocalFolder}
      >
        <Text style={styles.buttonText}>Open folder</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Browse for a local folder"
        style={styles.secondaryButton}
        disabled={openLocal.isPending}
        onPress={startBrowsing}
      >
        <Text style={styles.secondaryButtonText}>Browse…</Text>
      </Pressable>
      {browsing ? (
        <FolderDialog theme={theme} onSelect={openBrowsed} onClose={stopBrowsing} />
      ) : null}
      {openLocal.error ? <Text style={styles.error}>{messageOf(openLocal.error)}</Text> : null}
      {openLocal.data ? <Text style={styles.success}>Opened {openLocal.data}</Text> : null}

      <ProgressDialog state={cloneState} styles={styles} theme={theme} onClose={dismiss} />
      {results.error ? <Text style={styles.error}>{messageOf(results.error)}</Text> : null}
      {results.error && openGitLabSettings && needsGitLabSetup(messageOf(results.error)) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open GitLab settings"
          style={styles.secondaryButton}
          onPress={openGitLabSettings}
        >
          <Text style={styles.secondaryButtonText}>Open GitLab settings</Text>
        </Pressable>
      ) : null}

      <ScrollView>
        {results.isFetching && !results.data ? (
          <ActivityIndicator color={theme.colors.accent} />
        ) : null}
        {results.data?.projects.map((project) => (
          <ProjectRow
            key={project.path}
            project={project}
            styles={styles}
            busy={cloneState.status === "running"}
            activeKind={activeKindFor(cloneState, project.path)}
            onClone={runClone}
          />
        ))}
        {results.data && results.data.projects.length === 0 ? (
          <Text style={styles.muted}>No projects found.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
