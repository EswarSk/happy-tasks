"use client";

import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn, initials } from "@/lib/utils";

interface AvatarProps {
  name: string;
  color?: string;
  className?: string;
}

export function Avatar({ name, color = "#665cf6", className }: AvatarProps) {
  return (
    <AvatarPrimitive.Root className={cn("inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-[var(--panel)]", className)}>
      <AvatarPrimitive.Fallback
        className="flex size-full items-center justify-center text-[10px] font-semibold text-white"
        style={{ backgroundColor: color }}
        delayMs={0}
      >
        {initials(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
