import { describe, it, expect } from 'vitest';
import { isArchived, getRawSlug } from './utils';

describe('isArchived', () => {
  it('is true with archivedVersion', () => {
    expect(isArchived({ sys: { archivedVersion: 3 } })).toBe(true);
  });
  it('is true with archivedAt', () => {
    expect(isArchived({ sys: { archivedAt: '2024-01-01T00:00:00Z' } })).toBe(true);
  });
  it('is false when neither is set', () => {
    expect(isArchived({ sys: {} })).toBe(false);
    expect(isArchived({ sys: { archivedVersion: null, archivedAt: null } })).toBe(false);
  });
});

describe('getRawSlug', () => {
  it('returns the slug, or empty string when there is no slug field', () => {
    expect(getRawSlug({ fields: { slug: { 'en-US': 'a' } } } as any)).toBe('a');
    expect(getRawSlug({ fields: { title: { 'en-US': 'T' } } } as any)).toBe('');
  });
});
