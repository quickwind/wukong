import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import {
  FlatList,
  Text,
  View,
  type ListRenderItemInfo,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, MoreHorizontal, Pencil, X } from "lucide-react-native";
import type { MatchRange } from "@getpaseo/protocol/search/text-match";
import { confirmDialog } from "@/utils/confirm-dialog";
import { MaterialFileIcon } from "@/components/material-file-icon";
import {
  treeRowPaddingLeft,
  workspaceTreeRowStyles,
  WORKSPACE_TREE_ICON_LABEL_GAP,
  WORKSPACE_TREE_ICON_SIZE,
} from "@/components/tree-primitives";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useOverlayFlatListScrollbar } from "@/components/ui/overlay-scrollbar/use-overlay-flat-list-scrollbar";
import {
  paneContentToolbarIconSize,
  ToolbarButton,
  ToolbarControls,
} from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SearchField } from "@/components/ui/search-field";
import { EditingTextInput } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { replaceMatches, type Match, type ReplaceFile } from "./content-search";
import {
  describeReplace,
  matchKey,
  planReplace,
  previewSegments,
  summarizeReplace,
  type ReplaceSummary,
} from "./content-search-replace";
import type { FileGroup, SearchState } from "./content-search-state";
import { describeSearchFailure, useContentSearch } from "./use-content-search";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const ThemedPencil = withUnistyles(Pencil);
const ThemedCheck = withUnistyles(Check);
const ThemedX = withUnistyles(X);
const ThemedTextInput = withUnistyles(EditingTextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
  selectionColor: theme.colors.foreground,
}));
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

/** Drops the line's indentation, which only pushes the match out of a narrow pane. */
export function displayLine(
  text: string,
  ranges: readonly Match["ranges"][number][],
): { text: string; ranges: MatchRange[] } {
  const offset = text.length - text.trimStart().length;
  const shown: MatchRange[] = [];
  for (const range of ranges) {
    const start = Math.max(range.start - offset, 0);
    const end = range.end - offset;
    if (end > start) shown.push({ start, length: end - start });
  }
  return { text: text.slice(offset), ranges: shown };
}

function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { name: path, folder: "" }
    : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}

type ResultRow = { type: "file"; group: FileGroup } | { type: "match"; match: Match; key: string };

function resultRowKey(row: ResultRow): string {
  return row.type === "file" ? `file:${row.group.path}` : row.key;
}

function toRows(groups: readonly FileGroup[]): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const group of groups) {
    rows.push({ type: "file", group });
    group.matches.forEach((match, index) => {
      rows.push({ type: "match", match, key: `match:${group.path}:${index}` });
    });
  }
  return rows;
}

/** What the results need to show a replace: the text, and which lines and files are left out. */
export interface ReplaceControls {
  replacement: string;
  excludedMatches: ReadonlySet<string>;
  excludedFiles: ReadonlySet<string>;
  toggleMatch: (key: string) => void;
  toggleFile: (path: string) => void;
  /** False while a search or replace is running, or without a host. */
  canReplace: boolean;
  replaceMatch: (match: Match) => void;
  replaceFile: (path: string) => void;
}

function ExcludeButton({
  excluded,
  label,
  onPress,
  testID,
}: {
  excluded: boolean;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <ToolbarButton
      label={excluded ? `Include ${label}` : `Leave out ${label}`}
      compact
      hitSlop={8}
      testID={testID}
      onPress={onPress}
    >
      <ThemedX size={14} uniProps={excluded ? mutedColorMapping : extraMutedColorMapping} />
    </ToolbarButton>
  );
}

function ReplaceButton({
  label,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <ToolbarButton
      label={label}
      disabled={disabled}
      compact
      hitSlop={8}
      testID={testID}
      onPress={onPress}
    >
      <ThemedCheck size={14} uniProps={extraMutedColorMapping} />
    </ToolbarButton>
  );
}

function FileHeaderRow({ group, replace }: { group: FileGroup; replace: ReplaceControls | null }) {
  const { name, folder } = splitPath(group.path);
  const toggleFile = replace?.toggleFile;
  const pressExclude = useCallback(() => toggleFile?.(group.path), [toggleFile, group.path]);
  const replaceFile = replace?.replaceFile;
  const pressReplace = useCallback(() => replaceFile?.(group.path), [replaceFile, group.path]);
  const excluded = replace?.excludedFiles.has(group.path) ?? false;
  return (
    <View
      style={[workspaceTreeRowStyles.row, { paddingLeft: treeRowPaddingLeft(0) }]}
      testID="content-search-file"
    >
      <View style={[styles.rowInfo, excluded ? styles.excluded : null]}>
        <View style={styles.rowIcon}>
          <MaterialFileIcon fileName={name} size={WORKSPACE_TREE_ICON_SIZE} />
        </View>
        <Text style={styles.fileName} numberOfLines={1}>
          {name}
          {folder ? <Text style={styles.folder}>{`  ${folder}`}</Text> : null}
        </Text>
      </View>
      <Text style={styles.count}>{group.matches.length}</Text>
      {replace ? (
        <ReplaceButton
          label="Replace in this file"
          disabled={!replace.canReplace || excluded}
          onPress={pressReplace}
          testID="content-search-replace-file"
        />
      ) : null}
      {replace ? (
        <ExcludeButton
          excluded={excluded}
          label={group.path}
          onPress={pressExclude}
          testID="content-search-exclude-file"
        />
      ) : null}
    </View>
  );
}

function segmentStyle(kind: "keep" | "old" | "new") {
  if (kind === "old") return styles.previewOld;
  if (kind === "new") return styles.previewNew;
  return undefined;
}

type HoverState = PressableStateCallbackType & { hovered?: boolean };

function MatchRow({
  match,
  onOpenMatch,
  replace,
}: {
  match: Match;
  onOpenMatch: (match: Match) => void;
  replace: ReplaceControls | null;
}) {
  const shown = useMemo(() => displayLine(match.text, match.ranges), [match.text, match.ranges]);
  const key = matchKey(match);
  const toggleMatch = replace?.toggleMatch;
  const pressExclude = useCallback(() => toggleMatch?.(key), [toggleMatch, key]);
  const replaceMatch = replace?.replaceMatch;
  const pressReplace = useCallback(() => replaceMatch?.(match), [replaceMatch, match]);
  const excluded =
    replace !== null && (replace.excludedMatches.has(key) || replace.excludedFiles.has(match.path));
  const segments = useMemo(
    () =>
      replace
        ? previewSegments(
            shown.text,
            shown.ranges.map((range) => ({ start: range.start, end: range.start + range.length })),
            replace.replacement,
          )
        : null,
    [replace, shown],
  );
  const press = useCallback(() => onOpenMatch(match), [match, onOpenMatch]);
  const style = useCallback(
    ({ hovered = false, pressed }: HoverState) => [
      workspaceTreeRowStyles.row,
      { paddingLeft: treeRowPaddingLeft(1) },
      (hovered || pressed) && workspaceTreeRowStyles.active,
    ],
    [],
  );
  return (
    <PressHighlight
      onPress={press}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={`${match.path}, line ${match.line}`}
      testID="content-search-result"
    >
      <Text style={styles.lineNumber} testID="content-search-line-number">
        {match.line}
      </Text>
      {segments ? (
        <Text
          style={[styles.matchText, excluded ? styles.excluded : null]}
          numberOfLines={1}
          testID="content-search-preview"
        >
          {segments.map((segment) => (
            <Text key={segment.id} style={segmentStyle(segment.kind)}>
              {segment.text}
            </Text>
          ))}
        </Text>
      ) : (
        <HighlightedText
          text={shown.text}
          ranges={shown.ranges}
          style={styles.matchText}
          numberOfLines={1}
        />
      )}
      {replace ? (
        <ReplaceButton
          label="Replace this match"
          disabled={!replace.canReplace || excluded}
          onPress={pressReplace}
          testID="content-search-replace-match"
        />
      ) : null}
      {replace ? (
        <ExcludeButton
          excluded={excluded}
          label={`line ${match.line}`}
          onPress={pressExclude}
          testID="content-search-exclude-match"
        />
      ) : null}
    </PressHighlight>
  );
}

function ResultsFooter({ search }: { search: SearchState }) {
  const warning = search.status === "done" && search.error !== null ? search.error : null;
  if (!search.truncated && warning === null) return null;
  return (
    <View style={styles.footer}>
      {search.truncated ? (
        <Text style={styles.muted}>Results are limited. Narrow the search.</Text>
      ) : null}
      {warning !== null ? <Text style={styles.muted}>{warning}</Text> : null}
    </View>
  );
}

function CenterMessage({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <View style={styles.centerState}>
      <Text style={error ? styles.errorText : styles.muted}>{text}</Text>
    </View>
  );
}

function SearchResults({
  search,
  isCompact,
  onOpenMatch,
  replace,
}: {
  search: SearchState;
  isCompact: boolean;
  onOpenMatch: (match: Match) => void;
  replace: ReplaceControls | null;
}) {
  const listRef = useRef<FlatList<ResultRow>>(null);
  const scrollbar = useOverlayFlatListScrollbar(listRef, { enabled: !isCompact });
  const rows = useMemo(() => toRows(search.groups), [search.groups]);
  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<ResultRow>) =>
      item.type === "file" ? (
        <FileHeaderRow group={item.group} replace={replace} />
      ) : (
        <MatchRow match={item.match} onOpenMatch={onOpenMatch} replace={replace} />
      ),
    [onOpenMatch, replace],
  );
  const footer = useMemo(() => <ResultsFooter search={search} />, [search]);

  if (search.status === "idle") return <CenterMessage text="Type at least 2 characters" />;
  if (search.status === "error")
    return <CenterMessage text={search.error ?? "Search failed"} error />;
  if (rows.length === 0) {
    if (search.status === "done") return <CenterMessage text="No results" />;
    return null;
  }
  return (
    <View style={styles.listFrame}>
      <FlatList
        ref={listRef}
        style={styles.list}
        data={rows}
        extraData={replace}
        renderItem={renderRow}
        keyExtractor={resultRowKey}
        ListFooterComponent={footer}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.listContent}
        onLayout={scrollbar.onLayout}
        onScroll={scrollbar.onScroll}
        onContentSizeChange={scrollbar.onContentSizeChange}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={!scrollbar.enabled}
        initialNumToRender={24}
        maxToRenderPerBatch={40}
        windowSize={12}
      />
      {scrollbar.overlay}
    </View>
  );
}

function SearchStatusLine({ search }: { search: SearchState }) {
  if (search.status === "searching") {
    return (
      <View style={styles.statusLine}>
        <ThemedLoadingSpinner size={14} uniProps={mutedColorMapping} />
        <Text style={styles.muted}>Searching…</Text>
      </View>
    );
  }
  if (search.status === "done" && search.matchCount > 0) {
    const results = search.matchCount === 1 ? "1 result" : `${search.matchCount} results`;
    const files = search.groups.length === 1 ? "1 file" : `${search.groups.length} files`;
    return (
      <View style={styles.statusLine}>
        <Text style={styles.muted}>{`${results} in ${files}`}</Text>
      </View>
    );
  }
  return null;
}

// The shared button chrome marks "on" with the same faint fill as hover, which is too weak for a
// toggle the search depends on, so an on toggle also gets the foreground glyph and a border.
function ToggleGlyph({ text, selected }: { text: string; selected: boolean }) {
  return (
    <Text style={[styles.toggleGlyph, selected ? styles.toggleGlyphSelected : null]}>{text}</Text>
  );
}

function ReplaceStatus({
  replacing,
  failure,
  summary,
  unversioned,
}: {
  replacing: boolean;
  failure: string | null;
  summary: ReplaceSummary | null;
  unversioned: number;
}) {
  return (
    <>
      {replacing ? <Text style={styles.hint}>Replacing…</Text> : null}
      {failure !== null ? <Text style={styles.errorText}>{failure}</Text> : null}
      {summary ? (
        <View testID="content-search-replace-summary">
          <Text style={styles.hint}>{describeReplace(summary)}</Text>
          {summary.skipped.map((entry) => (
            <Text key={entry.path} style={styles.hint}>
              {`${entry.path}: ${entry.reason}`}
            </Text>
          ))}
        </View>
      ) : null}
      {unversioned > 0 ? (
        <Text style={styles.hint}>
          {`${unversioned} file(s) cannot be checked and are left out. Search again.`}
        </Text>
      ) : null}
    </>
  );
}

function ContentSearchBody({
  serverId,
  cwd,
  onOpenMatch,
}: {
  serverId: string;
  cwd: string;
  onOpenMatch: (match: Match) => void;
}) {
  const isCompact = useIsCompactFormFactor();
  const client = useHostRuntimeClient(serverId);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [excludedMatches, setExcludedMatches] = useState<ReadonlySet<string>>(new Set());
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [replacing, setReplacing] = useState(false);
  const [replaceFailure, setReplaceFailure] = useState<string | null>(null);
  const [replaced, setReplaced] = useState<ReplaceSummary | null>(null);
  const [refresh, setRefresh] = useState(0);

  const options = useMemo(
    () => ({ query, caseSensitive, regex, wholeWord, include, exclude }),
    [query, caseSensitive, regex, wholeWord, include, exclude],
  );
  const search = useContentSearch({ client, cwd, options, refresh });
  const plan = useMemo(
    () => planReplace(search.groups, excludedMatches, excludedFiles),
    [search.groups, excludedMatches, excludedFiles],
  );
  const toggleMatch = useCallback(
    (key: string) =>
      setExcludedMatches((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const toggleFile = useCallback(
    (path: string) =>
      setExcludedFiles((current) => {
        const next = new Set(current);
        if (!next.delete(path)) next.add(path);
        return next;
      }),
    [],
  );
  const canReplace =
    !replacing && search.status === "done" && client !== null && plan.files.length > 0;
  const replaceFiles = useCallback(
    async (files: ReplaceFile[]) => {
      if (!client) return;
      setReplacing(true);
      setReplaceFailure(null);
      setReplaced(null);
      const request = { cwd, query, caseSensitive, regex, wholeWord, replacement, files };
      try {
        setReplaced(summarizeReplace(await replaceMatches(client, request)));
        setExcludedMatches(new Set());
        setExcludedFiles(new Set());
        // The shown lines are out of date now; search again.
        setRefresh((value) => value + 1);
      } catch (error) {
        setReplaceFailure(describeSearchFailure(error));
      } finally {
        setReplacing(false);
      }
    },
    [client, cwd, query, caseSensitive, regex, wholeWord, replacement],
  );
  const runReplace = useCallback(async () => {
    if (!canReplace) return;
    const files = plan.files.length === 1 ? "1 file" : `${plan.files.length} files`;
    const confirmed = await confirmDialog({
      title: "Replace all",
      message: `Replace ${plan.matchCount} in ${files}? This writes to the files on disk.`,
      confirmLabel: "Replace",
      destructive: true,
    });
    if (confirmed) await replaceFiles(plan.files);
  }, [canReplace, plan, replaceFiles]);
  const pressReplaceAll = useCallback(() => {
    runReplace().catch(() => undefined);
  }, [runReplace]);
  const canReplaceNow = !replacing && search.status === "done" && client !== null;
  const replaceMatch = useCallback(
    (match: Match) => {
      const one = planReplace([{ path: match.path, matches: [match] }], new Set(), new Set());
      replaceFiles(one.files).catch(() => undefined);
    },
    [replaceFiles],
  );
  const replaceFile = useCallback(
    (path: string) => {
      const group = search.groups.filter((candidate) => candidate.path === path);
      replaceFiles(planReplace(group, excludedMatches, new Set()).files).catch(() => undefined);
    },
    [replaceFiles, search.groups, excludedMatches],
  );
  const replaceControls = useMemo<ReplaceControls | null>(
    () =>
      showReplace
        ? {
            replacement,
            excludedMatches,
            excludedFiles,
            toggleMatch,
            toggleFile,
            canReplace: canReplaceNow,
            replaceMatch,
            replaceFile,
          }
        : null,
    [
      showReplace,
      replacement,
      excludedMatches,
      excludedFiles,
      toggleMatch,
      toggleFile,
      canReplaceNow,
      replaceMatch,
      replaceFile,
    ],
  );
  const toggleReplace = useCallback(() => setShowReplace((value) => !value), []);

  const toggleCase = useCallback(() => setCaseSensitive((value) => !value), []);
  const toggleRegex = useCallback(() => setRegex((value) => !value), []);
  const toggleWord = useCallback(() => setWholeWord((value) => !value), []);
  const toggleDetails = useCallback(() => setShowDetails((value) => !value), []);
  const iconSize = paneContentToolbarIconSize(isCompact);

  return (
    <View style={styles.container}>
      <View style={styles.controls}>
        <View style={styles.queryRow}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            clearAccessibilityLabel="Clear search"
            testID="content-search-input"
            clearTestID="content-search-clear"
          />
          <ToolbarControls>
            <ToolbarButton
              label="Match case"
              selected={caseSensitive}
              style={caseSensitive ? styles.toggleSelected : undefined}
              compact={isCompact}
              hitSlop={4}
              testID="content-search-case"
              onPress={toggleCase}
            >
              <ToggleGlyph text="Aa" selected={caseSensitive} />
            </ToolbarButton>
            <ToolbarButton
              label="Match whole word"
              selected={wholeWord}
              style={wholeWord ? styles.toggleSelected : undefined}
              compact={isCompact}
              hitSlop={4}
              testID="content-search-word"
              onPress={toggleWord}
            >
              <ToggleGlyph text="ab" selected={wholeWord} />
            </ToolbarButton>
            <ToolbarButton
              label="Use regular expression (Rust regex syntax)"
              selected={regex}
              style={regex ? styles.toggleSelected : undefined}
              compact={isCompact}
              hitSlop={4}
              testID="content-search-regex"
              onPress={toggleRegex}
            >
              <ToggleGlyph text=".*" selected={regex} />
            </ToolbarButton>
            <ToolbarButton
              label="Replace"
              selected={showReplace}
              compact={isCompact}
              hitSlop={4}
              testID="content-search-replace-toggle"
              onPress={toggleReplace}
            >
              <ThemedPencil size={iconSize} uniProps={extraMutedColorMapping} />
            </ToolbarButton>
            <ToolbarButton
              label="Files to include and exclude"
              selected={showDetails}
              compact={isCompact}
              hitSlop={4}
              testID="content-search-details"
              onPress={toggleDetails}
            >
              <ThemedMoreHorizontal size={iconSize} uniProps={extraMutedColorMapping} />
            </ToolbarButton>
          </ToolbarControls>
        </View>
        {regex ? <Text style={styles.hint}>Rust regex syntax</Text> : null}
        {showReplace ? (
          <View style={styles.queryRow}>
            <ThemedTextInput
              initialValue={replacement}
              onChangeText={setReplacement}
              placeholder={regex ? "Replace with, $1 for a group" : "Replace with"}
              accessibilityLabel="Replace with"
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.globInput, styles.replaceInput]}
              testID="content-search-replace-input"
            />
            <ToolbarButton
              label={`Replace all (${plan.matchCount} in ${plan.files.length} files)`}
              disabled={!canReplace}
              compact={isCompact}
              hitSlop={4}
              testID="content-search-replace-all"
              onPress={pressReplaceAll}
            >
              <ToggleGlyph text="✓✓" selected={false} />
            </ToolbarButton>
          </View>
        ) : null}
        {showReplace && search.status === "done" && plan.matchCount > 0 ? (
          <Text style={styles.hint} testID="content-search-replace-plan">
            {`Replace ${plan.matchCount} in ${plan.files.length} ${plan.files.length === 1 ? "file" : "files"}`}
          </Text>
        ) : null}
        <ReplaceStatus
          replacing={replacing}
          failure={replaceFailure}
          summary={replaced}
          unversioned={showReplace ? plan.unversioned.length : 0}
        />
        {showDetails ? (
          <>
            <ThemedTextInput
              initialValue={include}
              onChangeText={setInclude}
              placeholder="Files to include, e.g. src/**, *.ts"
              accessibilityLabel="Files to include"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.globInput}
              testID="content-search-include"
            />
            <ThemedTextInput
              initialValue={exclude}
              onChangeText={setExclude}
              placeholder="Files to exclude"
              accessibilityLabel="Files to exclude"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.globInput}
              testID="content-search-exclude"
            />
          </>
        ) : null}
        <SearchStatusLine search={search} />
      </View>
      <SearchResults
        search={search}
        isCompact={isCompact}
        onOpenMatch={onOpenMatch}
        replace={replaceControls}
      />
    </View>
  );
}

/** Content search for the Files panel: query, toggles, globs, and matches grouped by file. */
export function IrixContentSearchPanel(props: {
  serverId: string;
  workspaceId: string | null;
  cwd: string;
  onOpenMatch: (match: Match) => void;
}): ReactElement {
  // A new workspace starts a new search rather than carrying the last query into another tree.
  return (
    <ContentSearchBody
      key={`${props.serverId}:${props.workspaceId ?? ""}`}
      serverId={props.serverId}
      cwd={props.cwd}
      onOpenMatch={props.onOpenMatch}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  controls: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  queryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  toggleGlyph: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  toggleGlyphSelected: {
    color: theme.colors.foreground,
  },
  toggleSelected: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  globInput: {
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.sm,
    outlineWidth: 0,
  },
  replaceInput: {
    flex: 1,
  },
  excluded: {
    opacity: 0.4,
  },
  previewOld: {
    color: theme.colors.destructive,
    textDecorationLine: "line-through",
  },
  previewNew: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  statusLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 20,
  },
  listFrame: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  list: {
    flex: 1,
    minHeight: 0,
  },
  listContent: {
    paddingBottom: theme.spacing[4],
  },
  rowInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: WORKSPACE_TREE_ICON_LABEL_GAP,
    minWidth: 0,
  },
  rowIcon: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  fileName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  folder: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginLeft: theme.spacing[2],
  },
  lineNumber: {
    minWidth: theme.spacing[8],
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  matchText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    gap: theme.spacing[1],
    paddingTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
