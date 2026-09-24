/**
 * The facts every legal page states, in one place.
 *
 * A version and a date that appear on three documents must be the same on all
 * three, and an operator name that appears in a contract must match the entity
 * that actually signs things. Scattering them invites the drift where the
 * terms name one company and the privacy policy another — which is the sort of
 * detail that turns an enforceable document into an argument.
 *
 * `LEGAL_VERSION` is what a user accepted. Acceptance is recorded against it,
 * so raising it is what asks everyone to read the terms again; changing a
 * document without raising it leaves people bound to something they never saw.
 */

export const LEGAL_VERSION = '0.1.0-beta';
export const LEGAL_UPDATED = '24 September 2026';

export const OPERATOR = {
  product: 'Pathiel',
  /** Replace with the registered entity before launch; a contract needs a party. */
  legalName: 'Pathiel Pte. Ltd.',
  jurisdiction: 'a company incorporated in Singapore',
  governingLaw: 'Singapore',
  contact: 'legal@pathiel.xyz',
} as const;

/**
 * Who must not use the service.
 *
 * The United States is excluded because tokenised equities and perpetual
 * futures reach securities and commodities regulation there in ways no
 * interface disclaimer survives, and because the venues this software points
 * at exclude US persons themselves. The rest follow sanctions law, which binds
 * regardless of what any user agrees to.
 */
export const RESTRICTED_PERSONS = [
  'A United States person, or physically located in the United States or its territories.',
  'Located in, or ordinarily resident in, a jurisdiction subject to comprehensive sanctions, including Cuba, Iran, North Korea, Syria, and the Crimea, Donetsk and Luhansk regions of Ukraine.',
  'Named on any sanctions list maintained by the United Nations, Singapore, the United States, the United Kingdom or the European Union, or owned or controlled by a person who is.',
  'Prohibited from using services of this kind under the laws that apply to you.',
  'Under 18 years of age, or below the age of majority where you live.',
] as const;

/** The risks a user must be shown before they can trade, not after. */
export const KEY_RISKS = [
  {
    title: 'You can lose everything in the account',
    body: 'Digital assets are volatile and leveraged positions can be liquidated in full. Only commit what you are prepared to lose entirely.',
  },
  {
    title: 'The signature is the only key, and it cannot be rotated',
    body: 'Anyone who obtains the signature that derives your account controls it permanently. Lose access to the signing wallet and the account is unrecoverable — there is no reset, and nobody can restore it for you.',
  },
  {
    title: 'The key lives in your browser',
    body: 'Malware, a malicious extension, or a compromise of your device could expose it. Keep in the account what you intend to trade, not your savings.',
  },
  {
    title: 'Liquidation is sudden and total',
    body: 'A perpetual position can be closed against you at any hour with no warning, taking the entire margin. Funding accrues continuously and can outweigh any gain.',
  },
  {
    title: 'The venues are not ours',
    body: 'Trades execute against third-party protocols, bridges and derivatives venues. A bridge failure, an oracle error or a venue halting is a loss nobody here can compensate.',
  },
  {
    title: 'Beta software fails',
    body: 'This is incomplete software under active development. Defects may cause failed transactions, wrong figures on screen, or loss of funds.',
  },
  {
    title: 'Transactions are irreversible',
    body: 'A transaction sent to the wrong address, or a trade made in error, cannot be undone by us or by anyone.',
  },
  {
    title: 'Tax is yours to handle',
    body: 'Trading may create tax obligations where you live. We do not report on your behalf and do not provide tax advice.',
  },
] as const;
