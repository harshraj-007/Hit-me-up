import { LogOut } from "lucide-react";
import { signOutAction } from "@/server/auth/actions";
import { NotificationsControl } from "@/features/notifications/notifications-control";
import { AppNav } from "./app-nav";
import { TimezoneSync } from "./timezone-sync";

/**
 * Structural reorg across breakpoints (not just a stretched/shrunk single layout):
 *  - mobile (< md):  content stacked full-width; nav is a bottom tab bar.
 *  - tablet (md+):   a persistent left icon+label rail replaces the tab bar; content
 *                     stays single-column.
 *  - desktop (lg+):  content itself becomes multi-column (see DashboardView) and gets
 *                     more breathing room; the rail stays.
 */
export function AppShell({
  children,
  userEmail,
}: {
  children: React.ReactNode;
  userEmail: string | null;
}) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14rem_1fr]">
      <TimezoneSync />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-20 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-sm"
      >
        Skip to content
      </a>
      <aside className="safe-bottom fixed inset-x-0 bottom-0 z-10 flex flex-col border-t border-border bg-surface p-2 md:static md:h-dvh md:border-t-0 md:border-r md:p-4">
        <p className="mb-4 hidden px-3 text-sm font-semibold md:block">Hit me up</p>
        <AppNav />
        <div className="mt-auto hidden pt-4 md:block">
          <div className="mb-2">
            <NotificationsControl />
          </div>
          {userEmail ? <p className="truncate px-3 text-xs text-muted">{userEmail}</p> : null}
          <form action={signOutAction}>
            <button
              type="submit"
              className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <LogOut aria-hidden className="size-4" />
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main id="main" className="px-4 pt-6 pb-24 md:px-8 md:pb-10">
        <div className="mx-auto max-w-3xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl">{children}</div>
      </main>
    </div>
  );
}
