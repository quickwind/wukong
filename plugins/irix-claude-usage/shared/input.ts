import { z } from "zod";

export const inputSchema = z.object({ store: z.literal("claude-cli") }).strict();
export type UsageInput = z.infer<typeof inputSchema>;
