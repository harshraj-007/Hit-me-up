import { AppNav } from "./app-nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface p-2 md:static md:border-t-0 md:border-r md:p-4">
        <p className="mb-4 hidden px-3 text-sm font-semibold md:block">Hit me up</p>
        <AppNav />
      </aside>
      <main id="main" className="px-4 pt-6 pb-24 md:px-8 md:pb-8">
        <div className="mx-auto max-w-3xl">{children}</div>
      </main>
    </div>
  );
}
