"use client";

import { Moon, Sun } from "lucide-react";
import { useLayoutEffect } from "react";
import { Button } from "@/components/ui/button";

const storedTheme = () => localStorage.getItem("theme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

export function ThemeToggle() {
  useLayoutEffect(() => document.documentElement.setAttribute("data-theme", storedTheme()), []);

  const toggle = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("theme", next);
    document.documentElement.setAttribute("data-theme", next);
  };

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle color theme" title="Toggle color theme">
      <Moon className="theme-icon-moon size-4" />
      <Sun className="theme-icon-sun size-4" />
    </Button>
  );
}
