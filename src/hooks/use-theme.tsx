"use client";

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  MODE_STORAGE_KEY,
  STORAGE_KEY,
  isMode,
  isThemeId,
  type Mode,
  type ThemeId,
} from "@/lib/themes";

const THEME_CHANGE = "cerebro-crm:appearance";

function readTheme(): ThemeId {
  const value = document.documentElement.dataset.theme;
  return isThemeId(value) ? value : DEFAULT_THEME;
}

function readMode(): Mode {
  const value = document.documentElement.dataset.mode;
  return isMode(value) ? value : DEFAULT_MODE;
}

function updatePreference(field: "theme" | "mode", key: string, value: string) {
  document.documentElement.dataset[field] = value;
  try {
    localStorage.setItem(key, value);
  } catch {
    // The document still retains the preference for this tab.
  }
  window.dispatchEvent(new Event(THEME_CHANGE));
}

function setTheme(next: ThemeId) {
  updatePreference("theme", STORAGE_KEY, next);
}

function setMode(next: Mode) {
  updatePreference("mode", MODE_STORAGE_KEY, next);
}

function toggleMode() {
  setMode(readMode() === "dark" ? "light" : "dark");
}

function subscribe(onChange: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY) {
      document.documentElement.dataset.theme = isThemeId(event.newValue) ? event.newValue : DEFAULT_THEME;
    } else if (event.key === MODE_STORAGE_KEY) {
      document.documentElement.dataset.mode = isMode(event.newValue) ? event.newValue : DEFAULT_MODE;
    } else {
      return;
    }
    onChange();
  }
  window.addEventListener(THEME_CHANGE, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(THEME_CHANGE, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

const ThemeContext = createContext({
  theme: DEFAULT_THEME,
  mode: DEFAULT_MODE,
  setTheme,
  setMode,
  toggleMode,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  // React hydrates with the server defaults. The boot script has already
  // painted the saved CSS attributes before the first client snapshot.
  const theme = useSyncExternalStore(subscribe, readTheme, () => DEFAULT_THEME);
  const mode = useSyncExternalStore(subscribe, readMode, () => DEFAULT_MODE);
  return (
    <ThemeContext.Provider value={{ theme, mode, setTheme, setMode, toggleMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
