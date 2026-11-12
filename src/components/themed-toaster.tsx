"use client";

import { Toaster } from "sonner";

import { useTheme } from "@/hooks/use-theme";

/**
 * Toaster wrapper that follows the app's selected mode.
 *
 * Colors are driven off the same CSS tokens as the rest of the app, so
 * a toast looks at home without a second palette to maintain.
 */
export function ThemedToaster() {
  const { mode } = useTheme();
  return (
    <Toaster
      theme={mode}
      position="top-right"
      toastOptions={{
        style: {
          background: "var(--popover)",
          border: "1px solid var(--border)",
          color: "var(--popover-foreground)",
        },
      }}
    />
  );
}
