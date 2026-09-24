import { Suspense } from 'react';
import { InviteGate } from '@/components/InviteGate';

export const metadata = { title: 'Invitation' };

/**
 * The gate reads `?next=` to send someone back where they were headed, and
 * `useSearchParams` cannot be prerendered — it needs a request. Wrapping it
 * lets the page render statically down to this boundary and fill the rest in
 * on the client, which is what the build asks for.
 */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <InviteGate />
    </Suspense>
  );
}
