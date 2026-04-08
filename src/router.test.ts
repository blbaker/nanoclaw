import { describe, expect, it } from 'vitest';
import { isNoReplySentinel } from './router.js';

describe('isNoReplySentinel', () => {
  // Variants that MUST suppress
  const shouldSuppress = [
    'NO_REPLY',
    'no_reply',
    'No_Reply',
    'NO REPLY',
    'no reply',
    'No Reply',
    'NO-REPLY',
    'no-reply',
    'NOREPLY',
    'noreply',
    '(NO_REPLY)',
    ' NO_REPLY ',
    '  NO_REPLY  ',
    'NO_REPLY\n',
    '\nNO_REPLY',
    '\n NO_REPLY \n',
    'NO_REPLY.',
    'no_reply.',
    '  ( no reply )  ',
    'NO_REPLY  ',
  ];

  for (const variant of shouldSuppress) {
    it(`suppresses: ${JSON.stringify(variant)}`, () => {
      expect(isNoReplySentinel(variant)).toBe(true);
    });
  }

  // Variants that MUST pass through (legitimate replies)
  const shouldPassThrough = [
    '',
    'Hi Baker',
    'Result: NO_REPLY',
    'NO_REPLY because the market is closed',
    'I would say NO_REPLY but actually here are the trades',
    'Today the market said no reply to our orders',
    'no_reply_field is set to true in the schema',
    'NO_REPLY: detected an issue',
    'PAPER  NVDA  long 35 @ $138.20',
    '0',
    '?',
  ];

  for (const text of shouldPassThrough) {
    it(`does NOT suppress: ${JSON.stringify(text)}`, () => {
      expect(isNoReplySentinel(text)).toBe(false);
    });
  }
});
