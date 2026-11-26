import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { gsap, useGSAP } from "../../../components/motion/engine";

export function DiscoverPopover({
  label,
  icon,
  motion,
  above,
  disabled,
  triggerRef,
  children,
}: {
  label: string;
  icon: ReactNode;
  motion: boolean;
  above?: boolean;
  disabled?: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const fallback = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? fallback;

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useGSAP(
    () => {
      if (!motion || !root.current) return;
      if (open && panel.current) {
        gsap.from(panel.current, {
          opacity: 0,
          y: above ? 5 : -5,
          duration: 0.18,
          ease: "power2.out",
        });
      }
      const button = trigger.current;
      if (!button) return;
      const hover = gsap.to(button, {
        y: -1,
        duration: 0.15,
        paused: true,
        ease: "power2.out",
      });
      const enter = () => {
        if (!button.disabled) hover.play();
      };
      const leave = () => {
        hover.reverse();
      };
      button.addEventListener("pointerenter", enter);
      button.addEventListener("pointerleave", leave);
      return () => {
        button.removeEventListener("pointerenter", enter);
        button.removeEventListener("pointerleave", leave);
      };
    },
    {
      scope: root,
      dependencies: [open, motion, above, trigger],
      revertOnUpdate: true,
    },
  );

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div
      className="discover-popover-anchor"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          close();
        }
      }}
    >
      <button
        type="button"
        className="discover-icon"
        ref={trigger}
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {icon}
      </button>
      {open && (
        <div
          id={id}
          className={`discover-popover${above ? " above" : ""}`}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          ref={panel}
          onClickCapture={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("[data-dismiss-popover]")
            )
              close();
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
