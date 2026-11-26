import { useId, useRef } from "react";
import { FolderGlyph, FileGlyph } from "./Artwork";
import type { FileKind } from "./Artwork";
import { gsap, useGSAP } from "./engine";
import { categoryCapacity, createFrameBuffer, glyphCapacity } from "./signals";
import type { MotionFeed, MotionSignal } from "./signals";

const center = { x: 368, y: 132 };
const source = { x: 117, y: 133 };
const categoryX = 612;
const categoryOffsets = [0, -45, 45, -90, 90];
const incoming = "C 217 68 264 159 368 132";
const types: FileKind[] = ["image", "pdf", "text", "data", "other"];
const route = (y: number) => `C 480 132 490 ${y} 594 ${y}`;
const toneFor = (name: string): FileKind => {
  if (/image|photo|screenshot|art/i.test(name)) return "image";
  if (/document|text|note/i.test(name)) return "data";
  if (/code|data/i.test(name)) return "text";
  return "other";
};
const svgY = (index: number) => center.y + categoryOffsets[index];
const slots = Array.from({ length: glyphCapacity }, (_, index) => index);

function Destination({
  name,
  count,
  y,
  enabled,
}: {
  name: string;
  count: number;
  y: number;
  enabled: boolean;
}) {
  const art = useRef<SVGGElement>(null);
  const revealed = useRef(false);
  useGSAP(
    () => {
      if (revealed.current) return;
      revealed.current = true;
      if (enabled && art.current)
        gsap.from(art.current, {
          opacity: 0,
          scale: 0.82,
          transformOrigin: "center",
          duration: 0.23,
        });
    },
    { scope: art, dependencies: [enabled], revertOnUpdate: true },
  );
  return (
    <g
      transform={`translate(${categoryX} ${y})`}
      data-motion-destination={name}
      data-motion-y={y}
    >
      <g ref={art} data-tone={toneFor(name)}>
        <rect
          className="motion-destination-panel"
          x="-17"
          y="-19"
          width="175"
          height="38"
          rx="11"
        />
        <g transform="scale(.76)">
          <FolderGlyph tone={toneFor(name)} />
        </g>
        <text className="motion-category-label" x="34" y="-1">
          {name.length > 17 ? name.slice(0, 16) + "…" : name}
        </text>
        <text className="motion-category-count" x="34" y="13">
          {count} {count === 1 ? "file" : "files"}
        </text>
      </g>
    </g>
  );
}

export function AnalysisMotion({
  feed,
  categories,
  remainingKinds,
  enabled,
  active,
}: {
  feed: MotionFeed;
  categories: { name: string; count: number }[];
  remainingKinds: FileKind[];
  enabled: boolean;
  active: boolean;
}) {
  const scene = useRef<SVGSVGElement>(null);
  const halo = useId();
  const gradient = useId();
  const names =
    categories.length > categoryCapacity
      ? [
          ...categories.slice(0, categoryCapacity - 1),
          {
            name: "Other categories",
            count: categories
              .slice(categoryCapacity - 1)
              .reduce((sum, item) => sum + item.count, 0),
          },
        ]
      : categories;

  useGSAP(
    () => {
      const svg = scene.current;
      if (!enabled || !active || !svg) return;
      const glyphs = Array.from(
        svg.querySelectorAll<SVGGElement>("[data-motion-glyph]"),
      );
      const lanes = new Map<SVGGElement, gsap.Context>();
      const buffer = createFrameBuffer();
      let frame: number | undefined;

      function draw(element: SVGGElement, signal: MotionSignal) {
        const processing = signal.kind === "processing";
        let end: string;
        if (signal.kind === "classified") {
          const destinations = Array.from(
            svg?.querySelectorAll<SVGGElement>("[data-motion-destination]") ??
              [],
          );
          const destination =
            destinations.find(
              (folder) => folder.dataset.motionDestination === signal.category,
            ) ??
            destinations.find(
              (folder) =>
                folder.dataset.motionDestination === "Other categories",
            );
          const y = Number(destination?.dataset.motionY ?? center.y);
          end = ` ${route(y)}`;
        } else {
          const y =
            signal.kind === "failed"
              ? 178
              : signal.kind === "uncertain"
                ? 159
                : 197;
          end = ` C 401 132 403 ${y} 433 ${y}`;
        }
        element.dataset.outcome = signal.kind;
        element.dataset.kind = signal.fileKind ?? "text";
        const context = gsap.context(() => {
          gsap
            .timeline({
              onComplete: () => {
                lanes.get(element)?.revert();
                lanes.delete(element);
              },
            })
            .set(element, { opacity: 1 })
            .to(element, {
              motionPath: {
                path: `M ${source.x} ${source.y} ${incoming}${processing ? "" : end}`,
              },
              duration: processing ? 0.27 : 0.57,
              ease: "power1.inOut",
            })
            .to(element, { opacity: 0, duration: 0.1 });
        });
        lanes.set(element, context);
      }

      const unsubscribe = feed.subscribe((id, signal) => {
        buffer.add(id, signal);
        if (frame !== undefined) return;
        frame = requestAnimationFrame(() => {
          frame = undefined;
          const free = glyphs.filter((glyph) => !lanes.has(glyph));
          buffer
            .drain()
            .slice(0, free.length)
            .forEach((value, index) => draw(free[index], value));
        });
      });

      return () => {
        unsubscribe();
        if (frame !== undefined) cancelAnimationFrame(frame);
        for (const context of lanes.values()) context.revert();
        lanes.clear();
      };
    },
    {
      scope: scene,
      dependencies: [enabled, active, feed],
      revertOnUpdate: true,
    },
  );

  return (
    <svg
      ref={scene}
      className="analysis-motion"
      viewBox="0 0 790 264"
      aria-hidden="true"
      data-motion-scene="analysis"
    >
      <defs>
        <radialGradient id={halo}>
          <stop stopColor="var(--art-glow)" stopOpacity=".68" />
          <stop offset="1" stopColor="var(--art-glow)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={gradient} x2=".8" y2="1">
          <stop stopColor="var(--art-light)" />
          <stop offset="1" stopColor="var(--art-deep)" />
        </linearGradient>
      </defs>
      <path className="motion-trail" d={`M 57 154 ${incoming}`} />
      <path
        className="motion-thread"
        d={`M ${source.x} ${source.y} ${incoming}`}
      />
      <g className="motion-collection">
        {[
          "translate(88 131) rotate(-20) scale(1.56)",
          "translate(134 99) rotate(14) scale(1.39)",
          "translate(159 155) rotate(-8) scale(1.18)",
        ]
          .slice(0, remainingKinds.length)
          .map((transform, index) => (
            <g key={transform} transform={transform}>
              <FileGlyph kind={remainingKinds[index]} />
            </g>
          ))}
      </g>
      {remainingKinds.length > 0 && (
        <g className="art-particles">
          <circle cx="66" cy="99" r="2" />
          <circle cx="207" cy="107" r="2.5" />
          <circle cx="236" cy="149" r="1.8" />
          <circle cx="280" cy="123" r="1.3" />
          <circle cx="176" cy="78" r="1.4" />
        </g>
      )}
      {names.map(({ name }, index) => (
        <g key={name} data-tone={toneFor(name)}>
          <path
            className="motion-trail"
            d={`M 395 132 ${route(svgY(index))}`}
          />
          <path
            className="motion-thread"
            d={`M 395 132 ${route(svgY(index))}`}
          />
        </g>
      ))}
      <g transform={`translate(${center.x} ${center.y})`}>
        <circle r="82" fill={`url(#${halo})`} stroke="none" />
        <circle className="motion-node-ring" r="51" />
        <rect
          x="-35"
          y="-35"
          width="70"
          height="70"
          rx="22"
          fill={`url(#${gradient})`}
          className="motion-node-edge"
        />
        <rect
          x="-30"
          y="-30"
          width="60"
          height="60"
          rx="18"
          fill="var(--canvas)"
          opacity=".65"
          stroke="none"
        />
        <path
          className="motion-star"
          fill="#fff"
          d="M0-21Q5-6 21 0Q5 6 0 21Q-5 6-21 0Q-5-6 0-21Z"
        />
      </g>
      {names.map(({ name, count }, index) => (
        <Destination
          key={name}
          name={name}
          count={count}
          y={svgY(index)}
          enabled={enabled && active}
        />
      ))}
      {slots.map((slot) => (
        <g key={slot} data-motion-glyph="" opacity="0">
          <path className="motion-glyph-trail" d="M-35 4H-14M-25-3H-16" />
          {types.map((kind) => (
            <FileGlyph key={kind} kind={kind} />
          ))}
        </g>
      ))}
    </svg>
  );
}
