"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { primaryNav } from "@/config/navigation";

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex gap-1 md:flex-col">
      {primaryNav.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "flex flex-1 flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-xs transition-colors",
              "md:flex-none md:flex-row md:justify-start md:gap-2 md:py-2 md:text-sm",
              active
                ? "bg-accent-soft font-medium text-accent"
                : "text-muted hover:bg-surface-hover hover:text-foreground",
            )}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
