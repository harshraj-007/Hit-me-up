import clsx from "clsx";
import type { LucideIcon } from "lucide-react";

interface BadgeProps {
  label: string;
  icon?: LucideIcon;
  /** Text/background color classes — pass tokens from src/lib/design/tokens.ts. */
  toneText: string;
  toneSoft: string;
  className?: string;
}

/** Small status/priority chip. Always pairs color with an icon and/or label — never color alone. */
export function Badge({ label, icon: Icon, toneText, toneSoft, className }: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium",
        toneText,
        toneSoft,
        className,
      )}
    >
      {Icon ? <Icon aria-hidden className="size-3" /> : null}
      {label}
    </span>
  );
}
