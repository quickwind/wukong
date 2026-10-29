import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import {
  FlatList,
  Text,
  View,
  type ListRenderItemInfo,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MoreHorizontal } from "lucide-react-native";
import type { MatchRange } from "@getpaseo/protocol/search/text-match";
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
import type { Match } from "./content-search";
import type { FileGroup, SearchState } from "./content-search-state";
import { useContentSearch } from "./use-content-search";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
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

function FileHeaderRow({ group }: { group: FileGroup }) {
  const { name, folder } = splitPath(group.path);
  return (
    <View
      style={[workspaceTreeRowStyles.row, { paddingLeft: treeRowPaddingLeft(0) }]}
      testID="content-search-file"
    >
      <View style={styles.rowInfo}>
        <View style={styles.rowIcon}>
          <MaterialFileIcon fileName={name} size={WORKSPACE_TREE_ICON_SIZE} />
        </View>
        <Text style={styles.fileName} numberOfLines={1}>
          {name}
          {folder ? <Text style={styles.folder}>{`  ${folder}`}</Text> : null}
        </Text>
      </View>
      <Text style={styles.count}>{group.matches.length}</Text>
    </View>
  );
}

type HoverState = PressableStateCallbackType & { hovered?: boolean };

function MatchRow({ match, onOpenMatch }: { match: Match; onOpenMatch: (match: Match) => void }) {
  const shown = useMemo(() => displayLine(match.text, match.ranges), [match.text, match.ranges]);
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
      <HighlightedText
        text={shown.text}
        ranges={shown.ranges}
        style={styles.matchText}
        numberOfLines={1}
      />
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
}: {
  search: SearchState;
  isCompact: boolean;
  onOpenMatch: (match: Match) => void;
}) {
  const listRef = useRef<FlatList<ResultRow>>(null);
  const scrollbar = useOverlayFlatListScrollbar(listRef, { enabled: !isCompact });
  const rows = useMemo(() => toRows(search.groups), [search.groups]);
  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<ResultRow>) =>
      item.type === "file" ? (
        <FileHeaderRow group={item.group} />
      ) : (
        <MatchRow match={item.match} onOpenMatch={onOpenMatch} />
      ),
    [onOpenMatch],
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

  const options = useMemo(
    () => ({ query, caseSensitive, regex, wholeWord, include, exclude }),
    [query, caseSensitive, regex, wholeWord, include, exclude],
  );
  const search = useContentSearch({ client, cwd, options });

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
      <SearchResults search={search} isCompact={isCompact} onOpenMatch={onOpenMatch} />
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
