import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { loadTls } from './tls.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tls-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('loadTls', () => {
  it('returns null when the files are missing', () => {
    expect(loadTls({ cert: path.join(dir, 'nope.pem'), key: path.join(dir, 'nope.key') })).toBeNull();
  });

  it('returns null when the files are not a valid cert/key pair', async () => {
    const cert = path.join(dir, 'c.pem');
    const key = path.join(dir, 'k.key');
    await fs.writeFile(cert, 'not a certificate');
    await fs.writeFile(key, 'not a key');
    expect(loadTls({ cert, key })).toBeNull();
  });
});
