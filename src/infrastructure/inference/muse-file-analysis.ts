import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import config from "../../../fixtures/file-semantic-v1.json";
import { deviceErrorSchema } from "../../features/discovery/application/contracts";
import {
  manifestSchema,
  semanticAnalysis,
} from "../../features/file-analysis/application/contracts";
import type { FileAnalysisPort } from "../../features/file-analysis/application/workflow";
import { failureSchema } from "../../features/inference/application/contracts";
import { runScopedDeviceOperation } from "../device/tauri-device";
import { interpretStructuredResponse } from "./muse-ember";
import type { createMuseConnection } from "./tauri-muse-transport";

const nativeReply = z.strictObject({
  dispatched: z.boolean(),
  error: failureSchema.nullable(),
  reply: z
    .strictObject({
      httpStatus: z.literal(200),
      body: z.string().max(256 * 1024),
    })
    .nullable(),
});

export function createMuseFileAnalysis(
  connection: ReturnType<typeof createMuseConnection>,
): FileAnalysisPort {
  return {
    async prepare(scope, files, signal) {
      try {
        if (!connection.session()) await connection.credentials.status();
        const sessionId = connection.session();
        if (!sessionId) return { error: "permissionDenied" };
        const manifest = await runScopedDeviceOperation(
          scope,
          signal,
          (request) =>
            invoke("prepare_file_analysis", {
              request: { ...request, sessionId, fileIds: files },
            }).then((raw) => manifestSchema.parse(raw)),
        );
        if (signal.aborted) {
          await this.discard(manifest.planId);
          return { error: "cancelled" };
        }
        return { manifest };
      } catch (error) {
        return {
          error: deviceErrorSchema.safeParse(error).data ?? "transportError",
        };
      }
    },
    async approve(planId) {
      return z.boolean().parse(
        await invoke("approve_file_analysis", {
          request: { sessionId: connection.session(), planId },
        }),
      );
    },
    async discard(planId) {
      await invoke("discard_file_analysis", {
        request: { sessionId: connection.session(), planId },
      }).catch(() => undefined);
    },
    async infer(planId, fileId, signal) {
      if (signal.aborted)
        return { dispatch: "local", error: { code: "cancelled" } };
      const request = connection.nextRequest();
      if (!request)
        return { dispatch: "local", error: { code: "staleSession" } };
      const cancel = () => {
        void invoke("cancel_muse_ember_inference", request).catch(
          () => undefined,
        );
      };
      signal.addEventListener("abort", cancel, { once: true });
      const start = performance.now();
      try {
        const result = nativeReply.parse(
          await invoke("infer_muse_ember_file", {
            request: { ...request, planId, fileId },
          }),
        );
        const dispatch = result.dispatched ? "dispatched" : "local";
        if (result.error) return { dispatch, error: result.error };
        if (!result.reply || !result.dispatched)
          return { dispatch: "ambiguous", error: { code: "invalidResponse" } };
        const parsed = interpretStructuredResponse(
          result.reply.body,
          {
            provider: "Meta Model API",
            model: config.model,
            elapsedMs: Math.round(performance.now() - start),
            diagnostics: {
              schemaVersion: config.name,
              reasoningEffort: config.reasoning,
              outputTokenLimit: config.maxOutputTokens,
              httpStatus: result.reply.httpStatus,
            },
          },
          semanticAnalysis,
        );
        return parsed.ok
          ? { dispatch, result: parsed.value, metrics: parsed.metrics }
          : { dispatch, error: parsed.error, metrics: parsed.metrics };
      } catch {
        return { dispatch: "ambiguous", error: { code: "transportError" } };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}
