'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, PageHead, Chip } from './ui';
import { KEY_RISKS, LEGAL_VERSION } from '@/lib/legal';
import { acceptTerms } from '@/lib/terms';

/**
 * The door, and the last place a stranger is told what is behind it.
 *
 * Accepting the terms is the only prerequisite. The screen shows the three
 * things that decide whether someone should be here at all: the software is
 * unfinished, the key is derived in a browser, and the losses are real and
 * unrecoverable. Someone who turns back at this screen has been served better
 * than someone who finds out later.
 */
export function TermsGate() {
  const router = useRouter();
  const params = useSearchParams();
  const [checked, setChecked] = useState(false);

  const enter = () => {
    acceptTerms();
    // Back to wherever the gate interrupted, or the trade page. Only a local
    // path, so the parameter cannot bounce someone to another site.
    const next = params.get('next');
    router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    router.refresh();
  };

  return (
    <>
      <PageHead
        title="Before you start"
        lede="Pathiel is beta software that signs real transactions. Accept the terms to continue."
      />

      <Card title="What you are agreeing to" step={1} tone="warn">
        <p>
          <Chip tone="warn">Beta</Chip> Three things are worth knowing before you go further, and
          all of them are in the <a href="/risk">risk disclosure</a>.
        </p>
        <ul className="c-list-plain">
          {KEY_RISKS.slice(0, 3).map((risk) => (
            <li key={risk.title}>
              <strong>{risk.title}.</strong> {risk.body}
            </li>
          ))}
        </ul>
        <label className="c-ack">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>
            I have read the <a href="/risk">risk disclosure</a> and accept the{' '}
            <a href="/terms">terms of service</a> and <a href="/privacy">privacy policy</a> (version{' '}
            {LEGAL_VERSION}).
          </span>
        </label>
        <button
          className="c-go"
          type="button"
          onClick={enter}
          disabled={!checked}
          style={{ marginTop: 14 }}
        >
          Continue
        </button>
      </Card>
    </>
  );
}
