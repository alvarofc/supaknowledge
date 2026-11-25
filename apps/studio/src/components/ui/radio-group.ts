import type { KeyboardEvent } from "react";

/**
 * WAI-ARIA radio group keys: arrows move to the previous/next option (wrapping), Home/End to the first/last.
 * `current` is -1 when nothing is checked. Returns the index to check, or null for other keys.
 */
export function nextRadioIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Roving tabindex: only the checked option (or the first, when none is) is in the tab order. */
export function radioTabIndex(index: number, current: number): 0 | -1 {
  return index === (current < 0 ? 0 : current) ? 0 : -1;
}

/** onKeyDown for a role="radiogroup" element: checks and focuses the option the key moves to. */
export function handleRadioKeys<T>(e: KeyboardEvent<HTMLElement>, values: readonly T[], current: T | undefined, select: (v: T) => void): void {
  const i = nextRadioIndex(e.key, current === undefined ? -1 : values.indexOf(current), values.length);
  if (i === null) return;
  e.preventDefault();
  select(values[i]);
  e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[i]?.focus();
}
