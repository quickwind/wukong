import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_PREFERENCES } from "./level.js";

export const preferencesSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_PREFERENCES.enabled),
    warnPercent: z.number().int().min(1).max(99).default(DEFAULT_PREFERENCES.warnPercent),
    criticalPercent: z.number().int().min(2).max(100).default(DEFAULT_PREFERENCES.criticalPercent),
  })
  .refine((value) => value.warnPercent < value.criticalPercent, {
    message: "The warning threshold must be below the critical one",
    path: ["criticalPercent"],
  });

export const preferences = defineSettings({
  id: "thresholds",
  scope: "host",
  version: 1,
  schema: preferencesSchema,
});

// The client entry runs outside React, where `useSettings` is unavailable, so it reads the
// thresholds through this RPC.
export const preferencesRpc = defineRpc({
  name: "preferences",
  input: z.object({}),
  output: z.object({
    enabled: z.boolean(),
    warnPercent: z.number(),
    criticalPercent: z.number(),
  }),
});
