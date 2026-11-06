"use client";

import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/use-theme";

export function ThemeToggle() {
  const t = useTranslations("Appearance");
  const { mode, setMode } = useTheme();

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="size-11 border-input text-foreground motion-reduce:transition-none"
      aria-label={t("darkMode")}
      aria-pressed={mode === "dark"}
      title={t("darkMode")}
      onClick={() => setMode(mode === "dark" ? "light" : "dark")}
    >
      <Moon className="dark:hidden" aria-hidden="true" />
      <Sun className="hidden dark:block" aria-hidden="true" />
    </Button>
  );
}
