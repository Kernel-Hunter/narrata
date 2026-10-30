import { describe, expect, it } from 'vitest';
import { RELEASES_API, type UpdateStorage, availableUpdate, isNewer, parseRelease } from '../extension/src/update';

const DAY = 24 * 60 * 60 * 1000;

function memoryStorage(): UpdateStorage & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => void Object.assign(data, items),
  };
}

function github(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetcher = (async (url: URL | RequestInfo) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

const release = (tag: string) => ({ tag_name: tag, html_url: `https://github.com/Kernel-Hunter/narrata/releases/tag/${tag}`, draft: false, prerelease: false });

describe('extension update check', () => {
  it('compares versions number by number', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('v0.10.0', '0.9.2')).toBe(true);
    expect(isNewer('1.0', '0.99.99')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
  });

  it('reads only published releases of this repository', () => {
    expect(parseRelease(release('v0.2.0'))).toEqual({ version: '0.2.0', url: 'https://github.com/Kernel-Hunter/narrata/releases/tag/v0.2.0' });
    expect(parseRelease({ ...release('v0.2.0'), prerelease: true })).toBeNull();
    expect(parseRelease({ ...release('v0.2.0'), draft: true })).toBeNull();
    expect(parseRelease({ ...release('v0.2.0'), html_url: 'https://evil.example/narrata' })).toBeNull();
    expect(parseRelease(release('nightly'))).toBeNull();
    expect(parseRelease(null)).toBeNull();
  });

  it('offers a newer release and asks GitHub at most once a day', async () => {
    const storage = memoryStorage();
    const gh = github(release('v0.2.0'));
    const now = 1_000_000_000_000;
    expect(await availableUpdate('0.1.0', storage, now, gh.fetcher)).toEqual({ version: '0.2.0', url: release('v0.2.0').html_url });
    expect(gh.calls).toEqual([RELEASES_API]);
    expect(await availableUpdate('0.1.0', storage, now + DAY - 1, gh.fetcher)).not.toBeNull();
    expect(gh.calls).toHaveLength(1);
    // Updated in the meantime: the cached answer is not newer any more.
    expect(await availableUpdate('0.2.0', storage, now + 1000, gh.fetcher)).toBeNull();
    await availableUpdate('0.1.0', storage, now + DAY, gh.fetcher);
    expect(gh.calls).toHaveLength(2);
  });

  it('offers nothing when up to date, without a release, or offline', async () => {
    expect(await availableUpdate('0.2.0', memoryStorage(), Date.now(), github(release('v0.2.0')).fetcher)).toBeNull();
    expect(await availableUpdate('0.1.0', memoryStorage(), Date.now(), github({ message: 'Not Found' }, 404).fetcher)).toBeNull();
    const storage = memoryStorage();
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    expect(await availableUpdate('0.1.0', storage, Date.now(), offline)).toBeNull();
    expect(storage.data.update).toMatchObject({ latest: null });
  });
});
