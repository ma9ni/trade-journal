import { Suspense } from "react";
import Loading from "@/app/loading";
import { OpportunityLog } from "@/components/opportunity-log";

export default function OpportunitiesPage() {
  return (
    <Suspense fallback={<Loading />}>
      <OpportunityLog />
    </Suspense>
  );
}
