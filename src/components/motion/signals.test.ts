import { expect, test, vi } from "vitest";
import { createFrameBuffer, createMotionFeed, glyphCapacity } from "./signals";

test("coalesces a burst into one bounded frame and retains the newest outcome per file", () => {
  const buffer = createFrameBuffer();
  for (let index = 0; index < 500; index++) {
    buffer.add(String(index), { kind: "processing" });
  }
  buffer.add("499", { kind: "classified", category: "Documents" });
  const frame = buffer.drain();
  expect(frame).toHaveLength(glyphCapacity);
  expect(frame.at(-1)).toEqual({ kind: "classified", category: "Documents" });
  expect(buffer.drain()).toEqual([]);
});

test("detaching a scene drops hidden signals and reopening does not replay them", () => {
  const feed = createMotionFeed();
  const first = vi.fn();
  const next = vi.fn();
  const close = feed.subscribe(first);
  feed.emit("a", { kind: "processing" });
  close();
  feed.emit("a", { kind: "cancelled" });
  const closeNext = feed.subscribe(next);
  expect(first).toHaveBeenCalledExactlyOnceWith("a", { kind: "processing" });
  expect(next).not.toHaveBeenCalled();
  feed.emit("b", { kind: "skipped" });
  closeNext();
  expect(next).toHaveBeenCalledExactlyOnceWith("b", { kind: "skipped" });
});

test("a broken visual listener cannot interrupt lifecycle delivery to the application", () => {
  const feed = createMotionFeed();
  const listener = vi.fn(() => {
    throw Error("Scene unavailable");
  });
  feed.subscribe(listener);
  expect(() => feed.emit("a", { kind: "processing" })).not.toThrow();
  feed.emit("a", { kind: "failed" });
  expect(listener).toHaveBeenCalledTimes(1);
});
