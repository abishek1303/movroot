import { useId, useRef } from "react";
import { FolderGlyph, FileGlyph } from "./Artwork";
import type { FileKind } from "./Artwork";
import { gsap, useGSAP } from "./engine";

const positions = [
  [111, 55, -17],
  [162, 30, 12],
  [211, 59, 15],
  [86, 90, -20],
  [235, 89, 16],
];

export function DiscoveryMotion({
  pending,
  kinds,
  enabled,
}: {
  pending: boolean;
  kinds: FileKind[];
  enabled: boolean;
}) {
  const glow = useId();
  const scene = useRef<SVGSVGElement>(null);
  const revealed = useRef(false);
  const visibleCount = pending ? 0 : Math.min(positions.length, kinds.length);
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
      viewBox="0 0 320 153"
      aria-hidden="true"
      data-motion-scene="discovery"
    >
      <defs>
        <radialGradient id={glow}>
          <stop stopColor="var(--art-glow)" stopOpacity=".36" />
          <stop offset="1" stopColor="var(--art-glow)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse
        cx="160"
        cy="96"
        rx="141"
        ry="57"
        fill={`url(#${glow})`}
        stroke="none"
      />
      {visibleCount > 0 && (
        <>
          <ellipse
            cx="160"
            cy="103"
            rx="102"
            ry="21"
            transform="rotate(-7 160 103)"
            className="discovery-orbit"
          />
          <path
            className="art-spark"
            d="M64 66l2 4 4 2-4 2-2 4-2-4-4-2 4-2Zm172-32 1.5 3.5 3.5 1.5-3.5 1.5-1.5 3.5-1.5-3.5-3.5-1.5 3.5-1.5Z"
          />
        </>
      )}
      {positions.slice(0, visibleCount).map(([x, y, tilt], index) => (
        <g
          key={index}
          transform={`translate(${x} ${y}) rotate(${tilt}) scale(1.07)`}
        >
          <g className="discovered-file">
            <FileGlyph kind={kinds[index]} />
          </g>
        </g>
      ))}
      <g transform="translate(160 101) scale(1.47) rotate(-4)">
        <FolderGlyph />
      </g>
      {pending &&
        [0, 1, 2].map((index) => (
          <circle
            key={index}
            className="discovery-indicator"
            cx={150 + index * 10}
            cy={141}
            r={2.4}
          />
        ))}
    </svg>
  );
}
