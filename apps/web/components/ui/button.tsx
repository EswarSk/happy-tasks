import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-[var(--brand)] px-3.5 text-white shadow-sm hover:bg-[var(--brand-hover)]",
        secondary: "border border-[var(--border)] bg-[var(--panel)] px-3 text-[var(--text)] hover:bg-[var(--hover)]",
        ghost: "px-2.5 text-[var(--text-secondary)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
        danger: "bg-red-600 px-3.5 text-white hover:bg-red-700",
      },
      size: { sm: "min-h-8 text-xs", default: "min-h-9", icon: "size-9 p-0" },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
