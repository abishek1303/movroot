import { useRef } from "react";
import { gsap, useGSAP } from "../../../components/motion/engine";
import type { ReactNode, RefObject } from "react";
import type { Discovery } from "../../discovery/application/contracts";

export type BrowserFile = Discovery["files"][number];
export const rowPageSize = 80;

const glyphs: Record<string, string> = {
  image: "M3 4h18v16H3zM5 17l5-5 4 4 3-3 3 3M8 9h.01",
  pdf: "M5 3h10l4 4v14H5zM8 16c3-2 5-7 4-7-2 0-1 6 4 6",
  text: "M5 3h10l4 4v14H5zM8 11h8m-8 4h8m-8 3h5",
  data: "M3 4h18v16H3zM3 10h18M3 15h18M10 4v16",
  video: "M3 4h18v16H3zM10 8l6 4-6 4z",
  audio: "M4 12v-2a8 8 0 0 1 16 0v2m-16 0h4v7H4zm12 0h4v7h-4z",
  archive: "M3 4h18v5H3zM5 9v11h14V9m-9 4h4",
};
export function FileTypeIcon({ tone = "other" }: { tone?: string }) {
  return (
    <svg
      className="file-type-icon"
      data-tone={tone}
      aria-hidden="true"
      viewBox="0 0 24 24"
    >
      <path d={glyphs[tone] ?? "M5 3h10l4 4v14H5zM14 3v6h5"} />
    </svg>
  );
}
export function fileSize(bytes?: number) {
  if (bytes === undefined) return "Size unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit =
    bytes > 0 ? Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024))) : 0;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit)} ${units[unit]}`;
}

export function FilesystemBrowser({
  title,
  query,
  onSearch,
  controls,
  children,
  scrollRef,
  footer,
}: {
  title: string;
  query: string;
  onSearch: (value: string) => void;
  controls?: ReactNode;
  children: ReactNode;
  scrollRef?: RefObject<HTMLDivElement | null>;
  footer?: ReactNode;
}) {
  return (
    <section className="filesystem-browser" aria-label={title}>
      <div className="browser-toolbar">
        <strong>{title}</strong>
        <input
          type="search"
          aria-label="Search files"
          placeholder="Search files…"
          value={query}
          onChange={(event) => onSearch(event.target.value)}
        />
        {controls}
      </div>
      <div
        className="review-scroll"
        ref={scrollRef}
        role="region"
        aria-label={title + " list"}
        tabIndex={0}
      >
        {children}
      </div>
      {footer && <div className="browser-footer">{footer}</div>}
    </section>
  );
}

export function DistributionBreakdown({
  label,
  groups,
  active,
  onFilter,
  motion,
}: {
  label: string;
  groups: { name: string; count: number; tone?: string }[];
  active?: string;
  onFilter: (name?: string) => void;
  motion: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const version = groups.map(({ name, count }) => `${name}:${count}`).join("|");
  useGSAP(
    () => {
      if (motion && version)
        gsap.from(".distribution-bar", {
          scaleX: 0.92,
          opacity: 0.7,
          transformOrigin: "left",
          duration: 0.22,
          ease: "power2.out",
        });
    },
    { scope: root, dependencies: [version, motion], revertOnUpdate: true },
  );
  if (!groups.length) return null;
  const total = groups.reduce((sum, item) => sum + item.count, 0);
  const ordered = [...groups].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
  return (
    <section className="distribution" aria-label={label} ref={root}>
      <div className="distribution-bar" aria-hidden="true">
        {ordered.slice(0, 6).map(({ name, count, tone }, index) => (
          <progress
            key={name}
            data-tone={tone ?? index}
            value={1}
            max={1}
            style={{ flexGrow: count }}
          />
        ))}
        {ordered.length > 6 && (
          <progress
            data-tone="other"
            value={1}
            max={1}
            style={{
              flexGrow: ordered
                .slice(6)
                .reduce((sum, item) => sum + item.count, 0),
            }}
          />
        )}
      </div>
      <div className="distribution-groups">
        {ordered.slice(0, 6).map(({ name, count, tone }, index) => (
          <button
            key={name}
            data-tone={tone ?? index}
            aria-pressed={name === active}
            onClick={() => onFilter(name === active ? undefined : name)}
          >
            <FileTypeIcon tone={tone} />
            <span>
              <strong>{name}</strong>
              <small>
                {count.toLocaleString()} · {Math.round((count / total) * 100)}%
              </small>
            </span>
          </button>
        ))}
      </div>
      {ordered.length > 6 && (
        <label>
          More groups{" "}
          <select
            value={
              ordered.slice(6).some(({ name }) => name === active) ? active : ""
            }
            onChange={(event) => onFilter(event.target.value || undefined)}
          >
            <option value="">All groups</option>
            {ordered.slice(6).map(({ name, count }) => (
              <option key={name} value={name}>
                {name} · {count}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}
