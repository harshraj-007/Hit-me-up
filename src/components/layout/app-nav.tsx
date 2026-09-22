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
              "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm md:flex-none md:justify-start",
              "transition-colors hover:bg-border",
              active ? "bg-border font-medium" : "text-muted",
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
