import { z } from "zod";

export const inputSchema = z.object({ store: z.literal("devin-cli") }).strict();
export type UsageInput = z.infer<typeof inputSchema>;
