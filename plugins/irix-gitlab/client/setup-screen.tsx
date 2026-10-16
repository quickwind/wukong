import { openExternalUrl, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text } from "react-native";
import {
  setupCreateSectionRpc,
  setupSaveRpc,
  setupStatusRpc,
  setupTestSectionRpc,
} from "../shared/rpc.js";
import { createSetupController, type SetupController, type TestOutcome } from "./setup-controller.js";

const INSTALL_UV = "https://docs.astral.sh/uv/getting-started/installation/";
const INSTALL_GITLAB = "uv tool install python-gitlab";
const TOKEN_STEPS =
  "In the page that opens, pick the longest expiry date it allows, click Generate token, then copy the token back here.";

function describeOutcome(outcome: TestOutcome): string {
  if (outcome.result === "unreachable") return `Cannot reach GitLab: ${outcome.detail ?? ""}`;
  if (outcome.result === "token-rejected") {
    return "GitLab rejected this section's token. It may have expired or been revoked.";
  }
  const parts = ["Connected."];
  if (outcome.expiresAt) parts.push(`The token expires on ${outcome.expiresAt}.`);
  if (outcome.missingScopes.length > 0) {
    parts.push(`The token is missing the scopes: ${outcome.missingScopes.join(", ")}.`);
  }
  return parts.join(" ");
}

function useController(): SetupController {
  const status = useRpc(setupStatusRpc);
  const testSection = useRpc(setupTestSectionRpc);
  const createSection = useRpc(setupCreateSectionRpc);
  const save = useRpc(setupSaveRpc);
  const [controller] = useState(() =>
    createSetupController({
      status: () => status({}),
      testSection: (section) => testSection({ section }),
      createSection,
      save,
      openUrl: openExternalUrl,
    }),
  );
  return controller;
}

export function GitLabSetupScreen({ theme }: PluginSurfaceProps) {
  const controller = useController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const errorStyle = useMemo(() => ({ color: theme.colors.statusDanger }), [theme]);
  const newTokenRef = useRef<SettingsInputHandle>(null);
  const renewTokenRef = useRef<SettingsInputHandle>(null);

  useEffect(() => {
    void controller.load();
  }, [controller]);

  const openNewTokenPage = useCallback(() => void controller.openTokenPage("new"), [controller]);
  const openSectionTokenPage = useCallback(
    () => void controller.openTokenPage("section"),
    [controller],
  );
  const createNew = useCallback(() => {
    void controller.submitNewSection();
    newTokenRef.current?.replaceText("");
  }, [controller]);
  const renew = useCallback(() => {
    void controller.submitRenewedToken();
    renewTokenRef.current?.replaceText("");
  }, [controller]);
  const runTest = useCallback(() => void controller.runTest(), [controller]);
  const save = useCallback(() => void controller.save(), [controller]);
  const reload = useCallback(() => void controller.load(), [controller]);
  const sectionOptions = useMemo(
    () =>
      (state.status?.sections ?? [])
        .filter((entry) => entry.usable)
        .map((entry) => ({ label: entry.name, value: entry.name })),
    [state.status],
  );
  const sectionUrl = state.status?.sections.find((entry) => entry.name === state.section)?.url;

  if (state.loading && !state.status) return <Text style={style}>Checking GitLab setup…</Text>;
  if (!state.status) {
    return (
      <SettingsSection title="GitLab">
        <Text style={errorStyle}>{state.loadError}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={reload} />
      </SettingsSection>
    );
  }
  const { status } = state;

  if (!status.tools.gitlab.found) {
    return (
      <SettingsSection title="GitLab">
        <SettingsCard>
          <SettingsRow
            label="python-gitlab is not installed"
            hint={`Irix reaches GitLab through python-gitlab. Install it, then reload this page: ${INSTALL_GITLAB}`}
          />
          {status.tools.uv.found ? null : (
            <SettingsRow
              label="uv is not installed either"
              hint={`Install uv first, then run the command above: ${INSTALL_UV}`}
            />
          )}
          <SettingsAction label="After installing" actionLabel="Check again" onPress={reload} />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const showForm = controller.showNewSectionForm();
  const needsToken = controller.needsNewToken();
  const outcome = state.test.outcome;

  return (
    <>
      {status.overrides.length > 0 ? (
        <SettingsSection title="Environment overrides">
          <SettingsCard>
            {status.overrides.map((name) => (
              <SettingsRow
                key={name}
                label={name}
                hint="This variable is set and wins over the value saved here."
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}

      {sectionOptions.length > 0 && !state.adding ? (
        <SettingsSection title="GitLab account">
          <SettingsCard>
            <SettingsSelect
              label="Config section"
              hint={`From ${status.cfgPath}`}
              value={state.section ?? ""}
              options={sectionOptions}
              onValueChange={controller.selectSection}
            />
            <SettingsRow label="GitLab URL" hint="Set by the section. Choose another section to change it.">
              <Text style={style}>{sectionUrl ?? ""}</Text>
            </SettingsRow>
            <SettingsAction
              label="Connection"
              actionLabel={state.test.running ? "Testing…" : "Test"}
              disabled={state.test.running || !state.section}
              onPress={runTest}
            />
            {outcome ? (
              <SettingsRow label="Result">
                <Text style={outcome.result === "ok" && !needsToken ? style : errorStyle}>
                  {describeOutcome(outcome)}
                </Text>
              </SettingsRow>
            ) : null}
            {state.test.error ? (
              <SettingsRow label="Test failed">
                <Text style={errorStyle}>{state.test.error}</Text>
              </SettingsRow>
            ) : null}
            <SettingsAction
              label="Another GitLab"
              actionLabel="Add a section"
              onPress={controller.startAdding}
            />
          </SettingsCard>
          {needsToken ? (
            <SettingsCard>
              <SettingsAction
                label="This token needs replacing"
                actionLabel="Generate a new token"
                onPress={openSectionTokenPage}
              />
              <SettingsRow label="Then" hint={TOKEN_STEPS} />
              <SettingsInput
                ref={renewTokenRef}
                label="New token"
                secureTextEntry
                onChangeText={controller.setToken}
                disabled={state.busy}
                error={state.formError}
              />
              <SettingsAction
                label="Replace the stored token"
                actionLabel={state.busy ? "Checking…" : "Save token"}
                disabled={state.busy || !state.token}
                onPress={renew}
              />
            </SettingsCard>
          ) : null}
        </SettingsSection>
      ) : null}

      {showForm ? (
        <SettingsSection title="Add a GitLab account">
          <SettingsCard>
            <SettingsInput
              label="GitLab URL"
              placeholder="https://gitlab.example.com"
              initialValue={state.url}
              onChangeText={controller.setUrl}
              disabled={state.busy}
            />
            <SettingsAction
              label="Personal access token"
              actionLabel="Get token"
              onPress={openNewTokenPage}
              disabled={!state.url.trim()}
            />
            <SettingsRow
              label="In GitLab"
              hint={`The page opens with the name and permissions (api, read_repository, write_repository) filled in. ${TOKEN_STEPS}`}
            />
            <SettingsInput
              ref={newTokenRef}
              label="Token"
              secureTextEntry
              onChangeText={controller.setToken}
              disabled={state.busy}
              error={state.formError}
            />
            <SettingsAction
              label="Store it in the python-gitlab config"
              actionLabel={state.busy ? "Checking…" : "Create"}
              disabled={state.busy || !state.url.trim() || !state.token}
              onPress={createNew}
            />
            {state.adding ? (
              <SettingsAction label="Not now" actionLabel="Cancel" onPress={controller.cancelAdding} />
            ) : null}
          </SettingsCard>
        </SettingsSection>
      ) : null}

      {state.section && !showForm ? (
        <SettingsSection title="Projects">
          <SettingsCard>
            <SettingsInput
              label="Clone folder"
              hint="Where new clones go. An absolute path, or one starting with ~/"
              initialValue={state.cloneRoot}
              onChangeText={controller.setCloneRoot}
              disabled={state.saving}
              error={state.saveError}
            />
            <SettingsAction
              label="Irix settings"
              actionLabel={state.saving ? "Saving…" : "Save"}
              disabled={state.saving}
              onPress={save}
            />
            {state.savedResult ? (
              <SettingsRow
                label="Saved"
                hint={
                  state.savedResult.restartNeeded
                    ? `Using ${state.savedResult.url}. Project search and clone use it now; merge-request features use it after the daemon restarts.`
                    : `Using ${state.savedResult.url}.`
                }
              />
            ) : null}
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </>
  );
}
