import { flushSync } from "react-dom";
let active: ViewTransition | null = null;
let capturing = false;
let applying = false;
let updates: Array<() => void> = [];
const apply = () => {
  const batch = updates;
  updates = [];
  flushSync(() => {
    applying = true;
    try {
      for (const update of batch) update();
    } finally {
      applying = false;
    }
  });
};
/** Batch same-tick updates into one snapshot; never leave stale updates behind on interruption. */
export function animate(
  update: () => void,
  kind: "default" | "language" = "default",
) {
  if (applying) {
    update();
    return;
  }
  updates.push(update);
  if (
    document.hidden ||
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    !document.startViewTransition
  ) {
    active?.skipTransition();
    apply();
    return;
  }
  if (capturing) return;
  active?.skipTransition();
  capturing = true;
  document.documentElement.classList.toggle(
    "language-transition",
    kind === "language",
  );
  document.documentElement.classList.add("view-transitioning");
  const transition = document.startViewTransition(() => {
    try {
      apply();
    } finally {
      capturing = false;
    }
  });
  active = transition;
  void transition.ready.catch(() => {});
  void transition.finished
    .catch(() => {})
    .finally(() => {
      if (active === transition) {
        active = null;
        capturing = false;
        document.documentElement.classList.remove(
          "view-transitioning",
          "language-transition",
        );
      }
    });
}
