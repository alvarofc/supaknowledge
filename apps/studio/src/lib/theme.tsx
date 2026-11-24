import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Inline script for <head>: applies the stored theme before the first paint, so there is no flash of the wrong
 * theme. Keep it tiny and dependency-free; it runs before React.
 */
export const themeScript = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}");var d=t==="dark"||(t!=="light"&&matchMedia("${DARK_QUERY}").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light"}catch(e){}})()`;

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function apply(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia(DARK_QUERY).matches);
  const root = document.documentElement;
  // disable transitions while switching, so every surface changes at once
  const style = document.createElement("style");
  style.appendChild(document.createTextNode("*,*::before,*::after{transition:none!important}"));
  document.head.appendChild(style);
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  window.getComputedStyle(document.body);
  setTimeout(() => style.remove(), 1);
}

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      apply(readTheme());
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

type ThemeApi = { theme: Theme | undefined; setTheme: (theme: Theme) => void };
const ThemeContext = createContext<ThemeApi>({ theme: undefined, setTheme: () => {} });

/** Light / dark / system theme stored in localStorage (`theme`), applied as the `dark` class on <html>. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  // undefined during SSR and hydration: the stored theme is only known in the browser
  const theme = useSyncExternalStore<Theme | undefined>(subscribe, readTheme, () => undefined);

  const setTheme = useCallback((next: Theme) => {
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage blocked: still switch for this page view
    }
    apply(next);
    listeners.forEach((l) => l());
  }, []);

  // follow the OS setting while on "system"
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
