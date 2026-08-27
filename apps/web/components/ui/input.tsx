import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-full border border-[var(--border)] bg-[var(--panel)] px-4 text-sm text-[var(--text)] shadow-none outline-none placeholder:text-[var(--text-muted)] transition-colors hover:border-[var(--text-muted)] focus:border-[var(--focus)] focus:bg-[var(--panel)] focus:ring-2 focus:ring-[var(--focus-soft)] disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full resize-none rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-sm leading-6 text-[var(--text)] shadow-none outline-none placeholder:text-[var(--text-muted)] transition-colors hover:border-[var(--text-muted)] focus:border-[var(--focus)] focus:bg-[var(--panel)] focus:ring-2 focus:ring-[var(--focus-soft)] disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
