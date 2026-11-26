import { useRef } from "react";
import { FolderGlyph, FileGlyph } from "./Artwork";
import { gsap, useGSAP } from "./engine";
import { categoryCapacity, createFrameBuffer, glyphCapacity } from "./signals";
import type { MotionFeed, MotionSignal } from "./signals";

const center = { x: 300, y: 112 };
const source = { x: 88, y: 112 };
const categoryX = 467;
const categoryOffsets = [0, -37, 37, -74, 74];
const svgY = (index: number) => center.y + categoryOffsets[index];
const slots = Array.from({ length: glyphCapacity }, (_, index) => index);

function Destination({
  name,
  y,
  enabled,
}: {
  name: string;
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
      <g ref={art}>
        <g transform="scale(.59)">
          <FolderGlyph />
        </g>
        <text x="23" y="4">
          {name.length > 23 ? name.slice(0, 22) + "…" : name}
        </text>
      </g>
    </g>
  );
}

export function AnalysisMotion({
  feed,
  categories,
  remaining,
  enabled,
  active,
}: {
  feed: MotionFeed;
  categories: string[];
  remaining: number;
  enabled: boolean;
  active: boolean;
}) {
  const scene = useRef<SVGSVGElement>(null);
  const names =
    categories.length > categoryCapacity
      ? [...categories.slice(0, categoryCapacity - 1), "Other categories"]
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
          end = ` C 365 112 399 ${y} 450 ${y}`;
        } else {
          const y =
            signal.kind === "failed"
              ? 155
              : signal.kind === "uncertain"
                ? 134
                : 175;
          end = ` C 326 112 334 ${y} 360 ${y}`;
        }
        element.dataset.outcome = signal.kind;
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
                path: `M ${source.x} ${source.y} C 177 63 218 112 300 112${processing ? "" : end}`,
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
      viewBox="0 0 630 224"
      aria-hidden="true"
      data-motion-scene="analysis"
    >
      <g className="motion-collection">
        {[
          "translate(83 125) rotate(-8)",
          "translate(62 99) rotate(-18)",
          "translate(81 83) rotate(12)",
        ]
          .slice(0, remaining)
          .map((transform) => (
            <g key={transform} transform={transform}>
              <FileGlyph />
            </g>
          ))}
      </g>
      <path className="motion-guide" d="M 110 112 C 177 68 218 112 286 112" />
      {names.map((name, index) => (
        <path
          key={name}
          className="motion-guide motion-route"
          d={`M 314 112 C 365 112 399 ${svgY(index)} 446 ${svgY(index)}`}
        />
      ))}
      <g transform={`translate(${center.x} ${center.y})`}>
        <circle className="motion-halo" r="31" />
        <circle className="motion-node" r="21" />
        <path
          className="motion-star"
          d="M0-15Q4-4 15 0Q4 4 0 15Q-4 4-15 0Q-4-4 0-15Z"
        />
      </g>
      {names.map((name, index) => (
        <Destination
          key={name}
          name={name}
          y={svgY(index)}
          enabled={enabled && active}
        />
      ))}
      {slots.map((slot) => (
        <g key={slot} data-motion-glyph="" opacity="0">
          <FileGlyph />
        </g>
      ))}
    </svg>
  );
}
