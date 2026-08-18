import '@testing-library/jest-dom/vitest';

/**
 * `crypto.randomUUID` is used for idempotency keys. jsdom provides `crypto` but not
 * always this method, so it is polyfilled rather than mocked in each test — a component
 * that generates a key should not know it is under test.
 */
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => `test-${Math.random().toString(36).slice(2)}`,
  });
}
