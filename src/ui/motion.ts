/** The page's decorative motion: running only while it can be seen, and never
 * for a visitor who has asked for less of it.
 *
 * The motion itself is all CSS; this only flips the classes that start and
 * stop it, from IntersectionObservers rather than scroll handlers, so nothing
 * runs while nothing crosses the edge of the screen. */

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Keep `className` on each matching element while it is on screen
 * (`when: "visible"`) or while it is off it (`when: "hidden"`). */
export function toggleOnScreen(
  selector: string,
  className: string,
  when: "visible" | "hidden",
  threshold = 0.2,
): void {
  const elements = [...document.querySelectorAll(selector)];
  if (elements.length === 0 || typeof IntersectionObserver === "undefined") {
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const visible = entry.isIntersecting;
        entry.target.classList.toggle(className, when === "visible" ? visible : !visible);
      }
    },
    { threshold },
  );
  for (const element of elements) {
    observer.observe(element);
  }
}

/** Add `className` the first time each matching element comes into view, and
 * leave it there: a reveal happens once, not every time it is scrolled past. */
export function revealOnce(selector: string, className = "is-visible", threshold = 0.3): void {
  const elements = [...document.querySelectorAll(selector)];
  if (elements.length === 0) {
    return;
  }
  if (typeof IntersectionObserver === "undefined") {
    for (const element of elements) {
      element.classList.add(className);
    }
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add(className);
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold },
  );
  for (const element of elements) {
    observer.observe(element);
  }
}

/** Start the demo page's motion: the three "How it works" pictures play while
 * they are on screen, and the accuracy squares fill in the first time they are
 * seen. Under reduced motion neither happens, and every picture keeps its key
 * moment. (The road itself is the control room's: it stops off screen too.) */
export function startPageMotion(): void {
  if (prefersReducedMotion()) {
    return;
  }
  toggleOnScreen(".step__art", "is-playing", "visible", 0.35);
  const tally = document.querySelector(".tally");
  if (tally !== null) {
    tally.classList.add("will-reveal");
    revealOnce(".tally", "is-visible", 0.35);
  }
}
