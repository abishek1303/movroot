import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { failureSchema } from "../../features/inference/application/contracts";
import type {
  CredentialSettings,
  Result,
} from "../../features/inference/application/provider";

const statusSchema = z.strictObject({
  sessionId: z.uuid(),
  source: z.enum(["environment", "secureStore", "missing"]),
  remainingDispatches: z.number().int().min(0).max(30),
});
const responseSchema = z.strictObject({
  httpStatus: z.literal(200),
  body: z.string().max(256 * 1024),
});
export type TransportReply = z.infer<typeof responseSchema>;
export type MuseTransport = (
  body: string,
  signal: AbortSignal,
) => Promise<Result<TransportReply>>;

function normalize(error: unknown) {
  const parsed = failureSchema.safeParse(error);
  return parsed.success ? parsed.data : { code: "transportError" as const };
}

export function createMuseConnection() {
  let sessionId: string | undefined;
  let sequence = 0;

  const credentials: CredentialSettings = {
    async status() {
      try {
        const parsed = statusSchema.safeParse(
          await invoke("muse_ember_key_status"),
        );
        if (!parsed.success)
          return { ok: false, error: { code: "transportError" } };
        if (sessionId !== parsed.data.sessionId) sequence = 0;
        sessionId = parsed.data.sessionId;
        return {
          ok: true,
          value: {
            source: parsed.data.source,
            remainingDispatches: parsed.data.remainingDispatches,
          },
        };
      } catch (error) {
        return { ok: false, error: normalize(error) };
      }
    },

    async save(key) {
      if (!sessionId) return { ok: false, error: { code: "staleSession" } };
      try {
        await invoke("set_muse_ember_key", { request: { sessionId, key } });
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: normalize(error) };
      }
    },

    async remove() {
      if (!sessionId) return { ok: false, error: { code: "staleSession" } };
      try {
        await invoke("remove_muse_ember_key", { sessionId });
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: normalize(error) };
      }
    },
  };

  const send: MuseTransport = async (body, signal) => {
    if (signal.aborted) return { ok: false, error: { code: "cancelled" } };
    if (!sessionId) {
      const status = await credentials.status();
      if (!status.ok) return status;
    }
    if (signal.aborted) return { ok: false, error: { code: "cancelled" } };
    const id = sessionId;
    const requestId = ++sequence;
    const cancel = () => {
      void invoke("cancel_muse_ember_inference", {
        sessionId: id,
        requestId,
      }).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = responseSchema.safeParse(
        await invoke("infer_muse_ember", {
          request: { sessionId: id, requestId, body },
        }),
      );
      if (signal.aborted) return { ok: false, error: { code: "cancelled" } };
      return result.success
        ? { ok: true, value: result.data }
        : { ok: false, error: { code: "transportError" } };
    } catch (error) {
      return {
        ok: false,
        error: signal.aborted ? { code: "cancelled" } : normalize(error),
      };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };

  function nextRequest() {
    if (!sessionId) return undefined;
    return { sessionId, requestId: ++sequence };
  }

  return { credentials, send, session: () => sessionId, nextRequest };
}
