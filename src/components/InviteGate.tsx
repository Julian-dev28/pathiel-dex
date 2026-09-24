'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, Empty, PageHead, Chip } from './ui';
import { KEY_RISKS } from '@/lib/legal';

/**
 * The door, and the last place a stranger is told what is behind it.
 *
 * A closed beta could ask for a code and nothing else. This asks for the code
 * and shows the three things that decide whether someone should be here at
 * all: the software is unfinished, the key is derived in a browser, and the
 * losses are real and unrecoverable. Someone who turns back at this screen has
 * been served better than someone who finds out later.
 */
export function InviteGate() {
  const router = useRouter();
  const params = useSearchParams();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const redeem = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'that code is not valid');
      }
      // Back to wherever the gate interrupted, or the trade page.
      router.replace(params.get('next') || '/');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'that code is not valid');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead
        title="Invitation only"
        lede="Pathiel is in closed beta. Enter the code you were sent."
      />

      <Card title="Your invite code" step={1}>
        <div className="c-field">
          <input
            className="c-amount"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && code.trim() && !busy) void redeem();
            }}
            placeholder="pathiel-…"
            aria-label="Invite code"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <button
          className="c-go"
          type="button"
          onClick={() => void redeem()}
          disabled={busy || code.trim().length === 0}
          style={{ marginTop: 14 }}
        >
          {busy ? 'Checking…' : 'Enter'}
        </button>
        {error && (
          <p className="c-empty" style={{ marginTop: 10 }}>
            {error}
          </p>
        )}
      </Card>

      <Card title="Before you use the code" step={2} tone="warn">
        <p>
          <Chip tone="warn">Beta</Chip> This is unfinished software that signs real transactions
          with real money. Three things are worth knowing before you go further, and all of them
          are in the{' '}
          <a href="/risk">risk disclosure</a>.
        </p>
        <ul className="c-list-plain">
          {KEY_RISKS.slice(0, 3).map((risk) => (
            <li key={risk.title}>
              <strong>{risk.title}.</strong> {risk.body}
            </li>
          ))}
        </ul>
        <p>
          Using the software means accepting the <a href="/terms">terms of service</a>, and the{' '}
          <a href="/privacy">privacy policy</a> describes what is collected — which is less than
          you might expect, because the parts that touch your money never reach a server.
        </p>
      </Card>

      <Card title="No code?">
        <Empty>
          Access is granted one invitation at a time while the beta is small. There is no waiting
          list to join from here.
        </Empty>
      </Card>
    </>
  );
}
