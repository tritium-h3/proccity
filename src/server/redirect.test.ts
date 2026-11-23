import { describe, it, expect } from 'vitest';
import { redirectLocation } from './redirect.js';

describe('redirectLocation', () => {
  it('swaps in the HTTPS port and keeps path and query', () => {
    expect(redirectLocation('samarkand.hopto.org:5280', '/x?y=1', 5281)).toBe('https://samarkand.hopto.org:5281/x?y=1');
  });

  it('defaults the host to samarkand when the header is missing', () => {
    expect(redirectLocation(undefined, '/', 5281)).toBe('https://samarkand.hopto.org:5281/');
  });

  it('defaults the path to / when the url is missing', () => {
    expect(redirectLocation('torment-nexus.local', undefined, 5281)).toBe('https://torment-nexus.local:5281/');
  });
});
