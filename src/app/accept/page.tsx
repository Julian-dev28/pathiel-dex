import { Suspense } from 'react';
import { TermsGate } from '@/components/TermsGate';

export const metadata = { title: 'Accept the terms' };

/**
 * The gate reads `?next=` to send someone back where they were headed, and
 * `useSearchParams` cannot be prerendered — it needs a request. Wrapping it
 * lets the page render statically down to this boundary and fill the rest in
 * on the client, which is what the build asks for.
 */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <TermsGate />
    </Suspense>
  );
}
