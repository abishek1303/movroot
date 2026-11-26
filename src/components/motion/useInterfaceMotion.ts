import type { RefObject } from "react";
import { gsap, useGSAP } from "./engine";

export function useInterfaceMotion(
  shell: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  useGSAP(
    () => {
      const root = shell.current;
      if (!root || !enabled) return;
      const animations = new Map<Element, gsap.Context>();

      function animate(target: Element, tween: (finished: () => void) => void) {
        animations.get(target)?.revert();
        const context = gsap.context(() =>
          tween(() => {
            animations.get(target)?.revert();
            animations.delete(target);
          }),
        );
        animations.set(target, context);
      }

      function release(event: PointerEvent) {
        const button =
          event.target instanceof Element
            ? event.target.closest("button:not(:disabled)")
            : null;
        if (!button || event.button !== 0) return;
        animate(button, (finished) =>
          gsap.fromTo(
            button,
            { scale: 0.975 },
            {
              scale: 1,
              duration: 0.14,
              ease: "power2.out",
              onComplete: finished,
            },
          ),
        );
      }

      function toggle(event: Event) {
        const detail = event.target;
        if (
          !(detail instanceof HTMLDetailsElement) ||
          !detail.open ||
          !detail.getClientRects().length
        )
          return;
        const body = [...detail.children].filter(
          (child) => child.tagName !== "SUMMARY",
        );
        if (body.length === 0) return;
        animate(detail, (finished) =>
          gsap.from(body, {
            opacity: 0.68,
            y: -3,
            duration: 0.16,
            ease: "power2.out",
            onComplete: finished,
          }),
        );
      }

      root.addEventListener("pointerup", release);
      root.addEventListener("toggle", toggle, true);
      return () => {
        root.removeEventListener("pointerup", release);
        root.removeEventListener("toggle", toggle, true);
        for (const context of animations.values()) context.revert();
        animations.clear();
      };
    },
    { scope: shell, dependencies: [enabled], revertOnUpdate: true },
  );
}
