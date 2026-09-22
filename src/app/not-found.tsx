import { StatusPanel } from "@/components/ui/status-panel";

export default function NotFound() {
  return (
    <main className="px-4">
      <StatusPanel
        title="Page not found"
        description="That page doesn't exist or has moved."
        action={{ label: "Back to Today", href: "/today" }}
      />
    </main>
  );
}
