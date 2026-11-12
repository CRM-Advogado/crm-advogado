import { describe, expect, it } from 'vitest';
import {
  readSignupEvent,
  readSignupInput,
  readSignupTermination,
} from './embedded-signup';

const event = {
  type: 'WA_EMBEDDED_SIGNUP',
  event: 'FINISH',
  data: { waba_id: '123', phone_number_id: '456' },
};
const input = {
  wabaId: '123',
  phoneNumberId: '456',
  code: 'secret-code',
  state: 'a'.repeat(64),
  pin: '012345',
};
describe('Embedded Signup browser boundary', () => {
  it.each([
    ['CANCEL', 'cancelled'],
    ['ERROR', 'error'],
    ['FINISH_ONLY_WABA', 'unsupported'],
    ['FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', 'unsupported'],
  ])(
    'recognizes terminal event %s without a login callback',
    (name, result) => {
      expect(
        readSignupTermination('https://www.facebook.com', {
          ...event,
          event: name,
        })
      ).toBe(result);
      expect(
        readSignupTermination('https://evil.test', { ...event, event: name })
      ).toBeNull();
    }
  );
  it('does not treat malformed or successful events as a failure', () => {
    expect(
      readSignupTermination('https://www.facebook.com', 'bad-json')
    ).toBeNull();
    expect(readSignupTermination('https://www.facebook.com', event)).toBeNull();
  });
  it.each(['https://www.facebook.com', 'https://web.facebook.com'])(
    'accepts complete events from %s',
    (origin) => {
      expect(readSignupEvent(origin, JSON.stringify(event))).toEqual({
        wabaId: '123',
        phoneNumberId: '456',
      });
    }
  );
  it.each([
    'https://facebook.com.evil.test',
    'http://www.facebook.com',
    'https://evil.test',
    'null',
  ])('rejects %s', (origin) => {
    expect(readSignupEvent(origin, event)).toBeNull();
  });
  it.each([
    'CANCEL',
    'ERROR',
    'FINISH_ONLY_WABA',
    'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
  ])('does not mistake %s for standard completion', (name) => {
    expect(
      readSignupEvent('https://www.facebook.com', { ...event, event: name })
    ).toBeNull();
  });
  it.each([
    null,
    'invalid',
    {},
    { ...event, data: { waba_id: '123', phone_number_id: '../me' } },
  ])('ignores malformed payload %j', (payload) => {
    expect(readSignupEvent('https://www.facebook.com', payload)).toBeNull();
  });
});
describe('Embedded Signup server input', () => {
  it('preserves leading zeroes in the PIN', () =>
    expect(readSignupInput(input)).toEqual(input));
  it.each([
    { pin: '12345' },
    { pin: 123456 },
    { code: '' },
    { code: 'a'.repeat(4097) },
    { state: 'bad' },
    { wabaId: '../me' },
    { phoneNumberId: 456 },
  ])('rejects %j', (patch) => {
    expect(readSignupInput({ ...input, ...patch })).toBeNull();
  });
});
