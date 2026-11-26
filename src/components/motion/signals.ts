import type { FileKind } from "./Artwork";

export const glyphCapacity = 8;
export const categoryCapacity = 5;

export type MotionSignal = (
  | { kind: "processing" | "failed" | "skipped" | "cancelled" | "uncertain" }
  | { kind: "classified"; category: string }
) & { fileKind?: FileKind };

export function createMotionFeed() {
  let listener: ((id: string, signal: MotionSignal) => void) | undefined;
  return {
    subscribe(next: NonNullable<typeof listener>) {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
    emit(id: string, signal: MotionSignal) {
      try {
        listener?.(id, signal);
      } catch {
        // The visual listener is optional. A failure must not escape into analysis.
        listener = undefined;
      }
    },
  };
}

export type MotionFeed = ReturnType<typeof createMotionFeed>;

export function createFrameBuffer() {
  const pending = new Map<string, MotionSignal>();
  return {
    add(id: string, signal: MotionSignal) {
      pending.delete(id);
      if (pending.size >= glyphCapacity) {
        const oldest = pending.keys().next();
        if (!oldest.done) pending.delete(oldest.value);
      }
      pending.set(id, signal);
    },
    drain() {
      const signals = [...pending.values()];
      pending.clear();
      return signals;
    },
  };
}
