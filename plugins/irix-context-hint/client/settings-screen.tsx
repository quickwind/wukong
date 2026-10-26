import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { preferences } from "../shared/preferences.js";

export function ContextHintSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  const [draft, setDraft] = useState<{ warn: string; critical: string } | null>(null);

  const ready = settings.status === "ready" ? settings : null;
  const toggle = useCallback(
    (enabled: boolean) => {
      if (ready) void ready.save({ ...ready.values, enabled }, ready.revision);
    },
    [ready],
  );
  const changeWarn = useCallback(
    (warn: string) =>
      setDraft((d) => ({ warn, critical: d?.critical ?? String(ready?.values.criticalPercent) })),
    [ready],
  );
  const changeCritical = useCallback(
    (critical: string) =>
      setDraft((d) => ({ warn: d?.warn ?? String(ready?.values.warnPercent), critical })),
    [ready],
  );
  const save = useCallback(async () => {
    if (!ready || !draft) return;
    const next = {
      ...ready.values,
      warnPercent: Number(draft.warn),
      criticalPercent: Number(draft.critical),
    };
    if (await ready.save(next, ready.revision)) setDraft(null);
  }, [ready, draft]);

  if (settings.status === "loading") return <Text style={textStyle}>Loading settings…</Text>;
  if (settings.status !== "ready" || !ready) {
    return (
      <SettingsSection title="Context hint">
        <Text style={textStyle}>{settings.status === "ready" ? "" : settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title="Context hint">
      <SettingsCard>
        <SettingsSwitch
          label="Warn when the context window is nearly full"
          value={ready.values.enabled}
          disabled={ready.saving}
          onValueChange={toggle}
        />
        <SettingsInput
          label="Warning at (% of the context window)"
          initialValue={String(ready.values.warnPercent)}
          onChangeText={changeWarn}
          disabled={ready.saving}
        />
        <SettingsInput
          label="Critical at (% of the context window)"
          initialValue={String(ready.values.criticalPercent)}
          onChangeText={changeCritical}
          disabled={ready.saving}
          error={ready.saveError}
        />
        <SettingsAction
          label="Thresholds"
          actionLabel="Save thresholds"
          disabled={ready.saving || draft === null}
          onPress={save}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
