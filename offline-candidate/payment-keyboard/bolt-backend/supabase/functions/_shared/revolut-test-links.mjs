/**
 * Server-only allowlist supplied by the operator for the controlled EUR 1 test.
 * These are allowed destinations, NOT active runtime settings or evidence that
 * Revolut has verified availability/reusability. No frontend imports this file.
 */
export const TEST_LINK_URLS = Object.freeze({
  seven_day: 'https://checkout.revolut.com/pay/ce8af738-e963-45c4-9c9b-805226d90e37',
  monthly: 'https://checkout.revolut.com/pay/b790ff16-b0cc-433f-b644-fe26472fbddb',
  yearly: 'https://checkout.revolut.com/pay/f58cb319-cfd2-41be-af14-911fc4e8df0a',
});