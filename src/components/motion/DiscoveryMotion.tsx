import { useRef } from "react";
import { FolderGlyph, FileGlyph } from "./Artwork";
import { gsap, useGSAP } from "./engine";

const positions = [
  [168, 29],
  [196, 48],
  [177, 77],
  [217, 71],
  [228, 38],
];

export function DiscoveryMotion({
  pending,
  count,
  enabled,
}: {
  pending: boolean;
  count?: number;
  enabled: boolean;
}) {
  const scene = useRef<SVGSVGElement>(null);
  const revealed = useRef(false);
  const visibleCount = pending ? 0 : Math.min(positions.length, count ?? 0);
  useGSAP(
    () => {
      if (pending) {
        revealed.current = false;
        if (!enabled) return;
        const timeline = gsap.timeline();
        timeline.fromTo(
          ".motion-folder-front",
          { scaleY: 0.65 },
          { scaleY: 1, duration: 0.3, transformOrigin: "center bottom" },
        );
        timeline.to(
          ".discovery-indicator",
          {
            opacity: 0.24,
            duration: 0.65,
            stagger: 0.12,
            repeat: -1,
            yoyo: true,
          },
          0,
        );
      } else if (visibleCount && !revealed.current) {
        revealed.current = true;
        if (!enabled) return;
        gsap.from(".discovered-file", {
          x: -42,
          y: 14,
          opacity: 0,
          duration: 0.42,
          stagger: 0.055,
          ease: "power2.out",
        });
      }
    },
    {
      scope: scene,
      dependencies: [enabled, pending, visibleCount],
      revertOnUpdate: true,
    },
  );

  return (
    <svg
      className="discovery-motion"
      ref={scene}
      viewBox="0 0 290 110"
      aria-hidden="true"
      data-motion-scene="discovery"
    >
      <g transform="translate(112 59)">
        <FolderGlyph />
      </g>
      {pending &&
        [0, 1, 2].map((index) => (
          <circle
            key={index}
            className="discovery-indicator"
            cx={155 + index * 13}
            cy={59}
            r={2.6}
          />
        ))}
      {positions.slice(0, visibleCount).map(([x, y], index) => (
        <g key={index} transform={`translate(${x} ${y})`}>
          <g className="discovered-file">
            <FileGlyph />
          </g>
        </g>
      ))}
    </svg>
  );
}
