import React, { useCallback, useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

const DEFAULT_ENABLED = true;
const DEFAULT_MINUTES = 15;
const MIN_MINUTES = 1;
const MAX_MINUTES = 1440;

function parseMinutes(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) {
    return null;
  }
  const value = Number(text.trim());
  return value >= MIN_MINUTES && value <= MAX_MINUTES ? value : null;
}

export function IrixIdleReleaseCard({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [isSaving, setIsSaving] = useState(false);

  const persisted = (config as Record<string, unknown> | null)?.idleRelease as
    | { enabled?: unknown; minutes?: unknown }
    | undefined;
  const enabled = typeof persisted?.enabled === "boolean" ? persisted.enabled : DEFAULT_ENABLED;
  const minutes =
    typeof persisted?.minutes === "number" && parseMinutes(String(persisted.minutes)) !== null
      ? persisted.minutes
      : DEFAULT_MINUTES;

  const [draft, setDraft] = useState(String(minutes));
  const [invalid, setInvalid] = useState(false);
  // The input captures its text once; only a new resetKey makes it show `draft` again.
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    setDraft(String(minutes));
    setInvalid(false);
    setResetKey((key) => key + 1);
  }, [minutes]);

  const save = useCallback(
    (idleRelease: { enabled?: boolean; minutes?: number }) => {
      setIsSaving(true);
      void patchConfig({ idleRelease } as unknown as MutableDaemonConfigPatch)
        .catch((error) => {
          setDraft(String(minutes));
          setInvalid(false);
          setResetKey((key) => key + 1);
          Alert.alert(
            "Unable to update setting",
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          setIsSaving(false);
        });
    },
    [minutes, patchConfig],
  );

  const handleToggle = useCallback(
    (next: boolean) => {
      if (isSaving) {
        return;
      }
      save({ enabled: next });
    },
    [isSaving, save],
  );

  const handleChangeText = useCallback((text: string) => {
    setDraft(text);
    setInvalid(false);
  }, []);

  const commitMinutes = useCallback(() => {
    if (isSaving) {
      return;
    }
    const next = parseMinutes(draft);
    if (next === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (next !== minutes) {
      save({ minutes: next });
    }
  }, [draft, isSaving, minutes, save]);

  if (!isConnected) {
    return null;
  }

  return (
    <View style={settingsStyles.card} testID="host-page-idle-release-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Release idle agents</Text>
          <Text style={settingsStyles.rowHint}>
            {enabled
              ? `Close an idle Claude or Devin agent's process after ${minutes} minutes. The chat stays; it reopens when you open it or send a message.`
              : "Idle agents keep their process until the daemon restarts."}
          </Text>
        </View>
        <Switch
          value={enabled}
          disabled={isSaving}
          onValueChange={handleToggle}
          accessibilityLabel="Release idle agents"
          testID="host-page-idle-release-switch"
        />
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Idle minutes</Text>
          {invalid ? (
            <Text style={settingsStyles.rowError}>Enter a whole number from 1 to 1440.</Text>
          ) : null}
        </View>
        <FormTextInput
          size="sm"
          initialValue={draft}
          resetKey={resetKey}
          onChangeText={handleChangeText}
          onBlur={commitMinutes}
          onSubmitEditing={commitMinutes}
          editable={!isSaving}
          keyboardType="number-pad"
          inputMode="numeric"
          selectTextOnFocus
          style={styles.minutesInput}
          accessibilityLabel="Idle minutes"
          testID="host-page-idle-release-minutes"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  minutesInput: {
    width: 112,
    textAlign: "right",
  },
});
