import { useId } from "react";

const filePaint = {
  image: ["#49c9ff", "#2156f2"],
  pdf: ["#ff91a7", "#cf2269"],
  text: ["#d2b4ff", "#7950ee"],
  data: ["#57edc4", "#078f71"],
  other: ["#ffca77", "#dc7a24"],
} as const;
export type FileKind = keyof typeof filePaint;

export function fileVisualKind(extension?: string): FileKind {
  const value = extension?.toLowerCase() ?? "";
  if (/^(png|jpe?g|heic|webp|gif|svg|tiff?)$/.test(value)) return "image";
  if (value === "pdf") return "pdf";
  if (/^(txt|md|rtf|docx?|pages)$/.test(value)) return "text";
  if (/^(csv|tsv|json|xlsx?|numbers)$/.test(value)) return "data";
  return "other";
}

export function FolderGlyph({
  tone = "accent",
}: {
  tone?: "accent" | FileKind;
}) {
  const id = useId();
  const [light, dark] =
    tone === "accent"
      ? ["var(--art-light)", "var(--art-deep)"]
      : filePaint[tone];
  return (
    <g strokeLinejoin="round">
      <defs>
        <linearGradient id={id} x2=".8" y2="1">
          <stop stopColor={light} />
          <stop offset="1" stopColor={dark} />
        </linearGradient>
      </defs>
      <path
        d="M-30 15v-30q0-5 5-5h16l7 6h26q5 0 5 5v24q0 5-5 5h-49q-5 0-5-5Z"
        fill={`url(#${id})`}
        stroke="#ffffff"
        strokeOpacity=".52"
      />
      <path
        d="M-24 8v-14q0-3 4-3h43v21Z"
        fill={light}
        opacity=".7"
        stroke="none"
      />
      <path
        className="motion-folder-front"
        d="M-30 15l5-17q1-4 5-4h48q5 0 4 5l-5 17q-1 4-5 4h-47q-6 0-5-5Z"
        fill={`url(#${id})`}
        stroke="#f0eaff"
        strokeOpacity=".82"
        strokeWidth="1.5"
      />
      <path d="M-21-3h46" stroke="white" opacity=".46" fill="none" />
    </g>
  );
}

export function FileGlyph({ kind = "text" }: { kind?: FileKind }) {
  const id = useId();
  const [light, dark] = filePaint[kind];
  return (
    <g className="file-glyph" data-file-kind={kind} strokeLinejoin="round">
      <defs>
        <linearGradient id={id} x2=".65" y2="1">
          <stop stopColor={light} />
          <stop offset="1" stopColor={dark} />
        </linearGradient>
      </defs>
      <path
        d="M-10-16H4l7 7v22q0 3-3 3H-8q-3 0-3-3v-26q0-3 1-3Z"
        fill={`url(#${id})`}
        stroke="#ffffff"
        strokeOpacity=".72"
        strokeWidth=".9"
      />
      <path d="M4-16v7h7Z" fill="#fff" fillOpacity=".78" stroke="none" />
      <g
        fill="none"
        stroke="#fff"
        strokeWidth="1.35"
        strokeLinecap="round"
        opacity=".88"
      >
        {kind === "image" ? (
          <>
            <circle cx="-3.5" cy="-3" r="1.8" fill="#fff" stroke="none" />
            <path d="M-8 9l5-6 3 2 3-5 5 9Z" fill="#fff" stroke="none" />
          </>
        ) : kind === "pdf" ? (
          <path d="M-7 8C-3 6 3-7 1-8c-3-1-4 9 5 13 4 2 3-3-1-3C-1 1-11 6-7 8Z" />
        ) : kind === "data" ? (
          <path d="M-6-3H6V9H-6ZM-6 1H6M-6 5H6M0-3V9" />
        ) : (
          <path d="M-6-3H6M-6 2H6M-6 7H3" />
        )}
      </g>
    </g>
  );
}
