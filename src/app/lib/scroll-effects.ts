const surfaces =
  "main, nav, .log, .tray-list, .config-editor textarea, .tray-panel > .error, .connections-popover, .smart-dialog-body, .smart-list";

// Measure actual overflow so fades also reset when a list shrinks or a dialog
// opens. CSS scroll timelines can retain their last value after overflow ends.
export function initializeScrollEffects() {
  let frame = 0;
  let refresh = true;
  let elements: HTMLElement[] = [];
  const resize = new ResizeObserver(() => schedule());
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const update = () => {
    frame = 0;
    if (refresh) {
      refresh = false;
      resize.disconnect();
      elements = Array.from(document.querySelectorAll<HTMLElement>(surfaces));
      for (const element of elements) {
        resize.observe(element);
        for (const child of Array.from(element.children)) resize.observe(child);
      }
    }
    for (const element of elements) {
      const extent = Math.max(0, element.scrollHeight - element.clientHeight);
      const position = Math.max(0, Math.min(extent, element.scrollTop));
      const fades = {
        "--scroll-fade-top": Math.min(24, position),
        "--scroll-fade-bottom": Math.min(24, extent - position),
      };
      for (const [property, value] of Object.entries(fades)) {
        const next = `${value}px`;
        if (element.style.getPropertyValue(property) !== next)
          element.style.setProperty(property, next);
      }
    }
  };
  const mutations = new MutationObserver(() => {
    refresh = true;
    schedule();
  });
  mutations.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "open", "hidden"],
  });
  for (const event of ["scroll", "input", "load", "toggle"])
    document.addEventListener(event, schedule, true);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    mutations.disconnect();
    resize.disconnect();
    for (const event of ["scroll", "input", "load", "toggle"])
      document.removeEventListener(event, schedule, true);
  };
}
