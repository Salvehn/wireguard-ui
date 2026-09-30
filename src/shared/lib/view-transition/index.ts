import { addTransitionType, startTransition } from "react";

/** React coordinates snapshots, interrupted transitions and same-tick updates. */
export function animate(
  update: () => void,
  kind: "default" | "language" | "theme" = "default",
) {
  if (
    document.hidden ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  startTransition(() => {
    addTransitionType(kind);
    update();
  });
}
