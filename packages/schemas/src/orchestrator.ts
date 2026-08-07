import { z } from "zod";

/**
 * apps/service-orchestrator API request/response shapes (Phase 9).
 *
 * Money is MicroAlgo. Bigint is not JSON-serializable, so every money value
 * crossing the HTTP wire is a decimal string here — services convert with
 * microAlgo(BigInt(s)) at the boundary (same rule as
 * ProviderCatalogEntryWireSchema.price_micro_algo).
 *
 * The `attackNode` knob is a demo scenario override: it forces a specific task
 * node onto a specific provider. It only picks who pays — it never weakens the
 * policy guard, which still gates the provider's response before it reaches
 * treasury/ledger state.
 */

export const RunRequestSchema = z
  .object({
    goal: z.string().min(1),
    cap: z
      .string()
      .regex(/^\d+$/, "cap is MicroAlgo as a decimal string")
      .optional(),
    attackNode: z
      .object({
        nodeId: z.string().min(1),
        providerId: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RunRequest = z.infer<typeof RunRequestSchema>;

export const RunResponseSchema = z
  .object({
    taskId: z.string(),
  })
  .strict();

export type RunResponse = z.infer<typeof RunResponseSchema>;

export const ApproveRequestSchema = z
  .object({
    taskId: z.string().min(1),
    delta: z
      .string()
      .regex(/^\d+$/, "delta is MicroAlgo as a decimal string"),
  })
  .strict();

export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;

export const RejectRequestSchema = z
  .object({
    taskId: z.string().min(1),
  })
  .strict();

export type RejectRequest = z.infer<typeof RejectRequestSchema>;

export const RejectResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict();

export type RejectResponse = z.infer<typeof RejectResponseSchema>;
