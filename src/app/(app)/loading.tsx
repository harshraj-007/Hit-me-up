import { Skeleton } from "@/components/ui/skeleton";

/** Shaped like the Today dashboard so nothing jumps into place once data arrives. */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading today's plan">
      <div className="mb-6">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-2 h-7 w-56" />
        <Skeleton className="mt-3 h-4 w-72" />
      </div>

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[1fr_20rem] xl:grid-cols-[1fr_22rem] xl:gap-8">
        <div className="order-last lg:order-1">
          <Skeleton className="mb-3 h-5 w-32" />
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </div>
        <div className="order-first lg:order-2">
          <Skeleton className="h-52 w-full" />
        </div>
      </div>

      <span className="sr-only">Loading today&rsquo;s plan…</span>
    </div>
  );
}
