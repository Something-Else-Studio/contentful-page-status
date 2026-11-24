import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchReferencesIteratively,
  fetchUpstreamRoots,
  buildReferenceInformation,
  clearReferenceCache,
} from './references';

const space = { sys: { id: 'sp' } };
const environment = { sys: { id: 'env' } };

function entry(
  id: string,
  contentType: string,
  opts: {
    fields?: Record<string, unknown>;
    published?: boolean;
    archived?: boolean;
    version?: number;
  } = {},
) {
  const published = opts.published ?? true;
  return {
    sys: {
      id,
      type: 'Entry',
      contentType: { sys: { id: contentType } },
      space,
      environment,
      version: opts.version ?? (published ? 2 : 1),
      publishedVersion: published ? 1 : undefined,
      archivedVersion: opts.archived ? 5 : undefined,
    },
    fields: opts.fields ?? {},
  };
}

const link = (id: string) => ({ sys: { type: 'Link', linkType: 'Entry', id } });

function makeSdk(entries: any[]) {
  const getMany = vi.fn(async ({ query }: any) => {
    if (query['sys.id[in]']) {
      const ids = query['sys.id[in]'].split(',');
      return { items: entries.filter((e) => ids.includes(e.sys.id)) };
    }
    if (query['fields.slug']) {
      return {
        items: entries.filter(
          (e) =>
            e.sys.contentType.sys.id === query.content_type &&
            e.fields.slug?.['en-US'] === query['fields.slug'],
        ),
      };
    }
    if (query.links_to_entry) {
      return {
        items: entries.filter((e) =>
          JSON.stringify(e.fields).includes(`"id":"${query.links_to_entry}"`),
        ),
      };
    }
    return { items: [] };
  });
  return {
    sdk: {
      ids: { space: 'sp', environment: 'env' },
      cma: { entry: { getMany }, asset: { getMany: vi.fn(async () => ({ items: [] })) } },
    } as any,
    getMany,
  };
}

beforeEach(() => clearReferenceCache());

describe('fetchReferencesIteratively', () => {
  it('ignores archived referenced roots: no error, no need-publishing', async () => {
    const root = entry('p1', 'page', { fields: { contents: { 'en-US': [link('arch')] } } });
    const arch = entry('arch', 'page', { archived: true, published: false });
    const { sdk } = makeSdk([root, arch]);
    const refs = await fetchReferencesIteratively(sdk, 'p1', ['page']);
    expect(refs.errors).toHaveLength(0);
    expect(refs.entries).toHaveLength(0);
    expect(refs.warnings.map((w) => w.kind)).toEqual(['archived']);
    const info = buildReferenceInformation(root.sys as any, refs);
    expect(info.errorCount).toBe(0);
    expect(info.draftEntryCount).toBe(0);
  });

  it('ignores archived components', async () => {
    const root = entry('p1', 'page', { fields: { contents: { 'en-US': [link('c1')] } } });
    const comp = entry('c1', 'hero', { archived: true, published: false });
    const { sdk } = makeSdk([root, comp]);
    const refs = await fetchReferencesIteratively(sdk, 'p1', ['page']);
    expect(refs.entries).toHaveLength(0);
    expect(refs.errors).toHaveLength(0);
  });

  it('turns an unpublished linked root into a warning, not an error', async () => {
    const root = entry('p1', 'page', { fields: { contents: { 'en-US': [link('p2')] } } });
    const draftPage = entry('p2', 'page', {
      published: false,
      fields: { title: { 'en-US': 'Other' }, slug: { 'en-US': 'other' } },
    });
    const { sdk } = makeSdk([root, draftPage]);
    const refs = await fetchReferencesIteratively(sdk, 'p1', ['page']);
    expect(refs.errors).toHaveLength(0);
    expect(refs.warnings).toHaveLength(1);
    expect(refs.warnings[0]).toMatchObject({ kind: 'unpublished', label: 'Other', slug: 'other' });
  });

  it('still lists draft components in the need-publishing set', async () => {
    const root = entry('p1', 'page', { fields: { contents: { 'en-US': [link('c1')] } } });
    const comp = entry('c1', 'hero', { published: false });
    const { sdk } = makeSdk([root, comp]);
    const refs = await fetchReferencesIteratively(sdk, 'p1', ['page']);
    const info = buildReferenceInformation(root.sys as any, refs);
    expect(info.draftEntryCount).toBe(1);
    expect(info.errorCount).toBe(0);
  });

  it('keeps missing references as blocking errors carrying label and id', async () => {
    const root = entry('p1', 'page', {
      fields: { title: { 'en-US': 'Home' }, contents: { 'en-US': [link('gone')] } },
    });
    const { sdk } = makeSdk([root]);
    const refs = await fetchReferencesIteratively(sdk, 'p1', ['page']);
    expect(refs.errors).toHaveLength(1);
    const err: any = refs.errors[0];
    expect(err.sys.id).toBe('gone');
    expect(err.sys.space.sys.id).toBe('sp');
    expect(err.details.referrers[0].referrerLabel).toBe('Home');
  });

  it('warns (not errors) when two pages share a slug', async () => {
    const mine = entry('p1', 'page', { fields: { slug: { 'en-US': 'same' }, title: { 'en-US': 'Mine' } } });
    const dupe = entry('p9', 'page', { fields: { slug: { 'en-US': 'same' }, title: { 'en-US': 'Dupe' } } });
    const { sdk } = makeSdk([mine, dupe]);
    const refs = await fetchReferencesIteratively(sdk, 'p1', ['page']);
    expect(refs.errors).toHaveLength(0);
    const w = refs.warnings.find((x) => x.kind === 'duplicate-slug');
    expect(w).toMatchObject({ id: 'p1', slug: 'same' });
    expect(w?.related?.[0]).toMatchObject({ id: 'p9', label: 'Dupe' });
    expect(buildReferenceInformation(mine.sys as any, refs).errorCount).toBe(0);
  });

  it('does not warn when the only slug match is archived', async () => {
    const mine = entry('p1', 'page', { fields: { slug: { 'en-US': 'same' } } });
    const old = entry('p9', 'page', { archived: true, fields: { slug: { 'en-US': 'same' } } });
    const { sdk } = makeSdk([mine, old]);
    const refs = await fetchReferencesIteratively(sdk, 'p1', ['page']);
    expect(refs.warnings).toHaveLength(0);
  });
});

describe('fetchUpstreamRoots', () => {
  it('omits archived roots and does not traverse archived referrers', async () => {
    const comp = entry('c1', 'hero');
    const livePage = entry('p1', 'page', { fields: { contents: { 'en-US': [link('c1')] } } });
    const archPage = entry('p2', 'page', { archived: true, fields: { contents: { 'en-US': [link('c1')] } } });
    const archWrapper = entry('w1', 'wrapper', { archived: true, fields: { items: { 'en-US': [link('c1')] } } });
    const viaArchived = entry('p3', 'page', { fields: { contents: { 'en-US': [link('w1')] } } });
    const { sdk } = makeSdk([comp, livePage, archPage, archWrapper, viaArchived]);
    const { roots } = await fetchUpstreamRoots(sdk, 'c1', ['page']);
    expect(roots.map((r) => r.sys.id)).toEqual(['p1']);
  });

  it('returns duplicate-slug warnings for discovered roots', async () => {
    const comp = entry('c1', 'hero');
    const a = entry('p1', 'page', { fields: { slug: { 'en-US': 's' }, contents: { 'en-US': [link('c1')] } } });
    const b = entry('p2', 'page', { fields: { slug: { 'en-US': 's' } } });
    const { sdk } = makeSdk([comp, a, b]);
    const { roots, warnings } = await fetchUpstreamRoots(sdk, 'c1', ['page']);
    expect(roots).toHaveLength(1);
    expect(warnings?.[0]).toMatchObject({ kind: 'duplicate-slug', id: 'p1' });
  });
});
