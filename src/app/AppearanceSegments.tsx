import { useRef } from "react";
import { gsap, useGSAP } from "../components/motion/engine";

const artwork = {
  system: "M3 4h18v12H3zM12 16v4m-4 0h8",
  light:
    "M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  dark: "M19.5 15A8 8 0 0 1 9 4.5 8 8 0 1 0 19.5 15Z",
  motion: "M3 10h9m-9 5h6m6-9 5 6-5 6",
  reduced: "M3 10h9m-9 5h6m6-9 5 6-5 6M3 21 21 3",
} as const;

export function AppearanceSegments<T extends string>({
  label,
  options,
  value,
  onChange,
  motion,
}: {
  label: string;
  options: { value: T; label: string; icon: keyof typeof artwork }[];
  value: T;
  onChange: (value: T) => void;
  motion: boolean;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const index = options.findIndex((option) => option.value === value);
  const last = useRef(index);
  useGSAP(
    () => {
      const previous = last.current;
      last.current = index;
      if (marker.current && motion && previous !== index) {
        gsap.fromTo(
          marker.current,
          { xPercent: (previous - index) * 100 },
          {
            xPercent: 0,
            ease: "power2.out",
            duration: 0.22,
            clearProps: "transform",
          },
        );
      }
    },
    { dependencies: [index, motion], revertOnUpdate: true },
  );
  return (
    <div
      className="segmented polished-segments"
      data-count={options.length}
      data-index={index}
      role="group"
      aria-label={label}
    >
      <span className="segment-selection" ref={marker} aria-hidden="true" />
      {options.map((item) => (
        <button
          type="button"
          key={item.value}
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d={artwork[item.icon]} />
          </svg>
          {item.label}
        </button>
      ))}
    </div>
  );
}
