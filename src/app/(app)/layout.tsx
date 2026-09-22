import { AppShell } from "@/components/layout/app-shell";
import { requireUser } from "@/server/auth/session";

// Every route in this group requires a verified user; the check runs server-side per request.
export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return <AppShell>{children}</AppShell>;
}
