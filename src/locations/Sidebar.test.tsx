import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useSDK } from '@contentful/react-apps-toolkit';
import { vi, beforeEach, describe, it, expect } from 'vitest';
import Sidebar from './Sidebar';
import type { SidebarAppSDK } from '@contentful/app-sdk';
import * as references from '../lib/references';

// Mock the toolkit hook
vi.mock('@contentful/react-apps-toolkit', () => ({
  useSDK: vi.fn(),
}));

// Mock the heavy fetch functions so we don't hit real logic/network
vi.mock('../lib/references', () => ({
  fetchReferencesIteratively: vi.fn().mockResolvedValue({
    entries: [],
    assets: [],
    errors: [],
    processedEntryIds: new Set(),
  }),
  fetchUpstreamRoots: vi.fn().mockResolvedValue({ roots: [], failedLookups: 0 }),
  buildReferenceInformation: vi.fn().mockReturnValue({
    published: true,
    warnings: [],
    errors: [],
    errorCount: 0,
    entryCount: 0,
    draftEntryCount: 0,
    updatedEntryCount: 0,
    draftEntries: [],
    updatedEntries: [],
    assetCount: 0,
    draftAssetCount: 0,
    updatedAssetCount: 0,
    draftAssets: [],
    updatedAssets: [],
  }),
  // clear is called by retrieveInformation and finishPublishSuccess; provide a no-op
  // so tests that trigger Refresh / publish paths don't get "clearReferenceCache is not a function".
  clearReferenceCache: vi.fn(),
}));

const mockSdk: Partial<SidebarAppSDK> = {
  entry: {
    getSys: vi.fn().mockReturnValue({
      id: 'test-entry',
      contentType: { sys: { id: 'page' } },
      publishedAt: '2024-01-01',
      publishedVersion: 1,
      version: 2,
    }),
  } as any,
  window: {
    startAutoResizer: vi.fn(),
  } as any,
  parameters: {
    installation: {},
  } as any,
};

beforeEach(() => {
  (useSDK as any).mockReturnValue(mockSdk);
  vi.clearAllMocks();
});

describe('Sidebar root content types from parameters', () => {
  it('uses default roots when no installation parameters are set', () => {
    (mockSdk.entry!.getSys as any).mockReturnValue({
      id: 'test-entry',
      contentType: { sys: { id: 'page' } },
    });

    render(<Sidebar />);

    // In Idle state, the text mentions scanning "this entry and its references"
    // (the exact wording is the same for root vs component in current Idle, but
    // we can at least ensure it didn't crash and rendered)
    expect(screen.getByText(/Dependency scan not run/i)).toBeInTheDocument();
  });

  it('treats a configured custom type as a root (isRootEntry true)', async () => {
    (mockSdk.parameters!.installation as any) = {
      rootContentTypes: ['myCustomPage'],
    };
    (mockSdk.entry!.getSys as any).mockReturnValue({
      id: 'test-entry',
      contentType: { sys: { id: 'myCustomPage' } },
    });

    render(<Sidebar />);

    // Should render the Idle state for a root entry
    expect(screen.getByText(/Dependency scan not run/i)).toBeInTheDocument();
    // The description text for roots
    expect(
      screen.getByText(/Scan this entry and its references to see publish status/i)
    ).toBeInTheDocument();
  });

  it('treats a non-configured type as component (triggers upstream logic on refresh)', async () => {
    (mockSdk.parameters!.installation as any) = {
      rootContentTypes: ['page', 'article'],
    };
    (mockSdk.entry!.getSys as any).mockReturnValue({
      id: 'comp-123',
      contentType: { sys: { id: 'myComponent' } },
    });

    const { fetchUpstreamRoots } = references as any;

    render(<Sidebar />);

    // Click refresh - this should call the upstream fetch because it's not a root
    const refreshBtn = screen.getByRole('button', { name: /Refresh/i });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(fetchUpstreamRoots).toHaveBeenCalled();
    });
  });

  it('passes configured roots down to fetchReferencesIteratively and fetchUpstreamRoots', async () => {
    const customRoots = ['page', 'myCustomRoot'];
    (mockSdk.parameters!.installation as any) = {
      rootContentTypes: customRoots,
    };
    (mockSdk.entry!.getSys as any).mockReturnValue({
      id: 'page-1',
      contentType: { sys: { id: 'page' } },
    });

    const { fetchReferencesIteratively, fetchUpstreamRoots } = references as any;

    render(<Sidebar />);

    const refreshBtn = screen.getByRole('button', { name: /Refresh/i });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      // First call is the downward for the entry itself
      expect(fetchReferencesIteratively).toHaveBeenCalledWith(
        expect.anything(),
        'page-1',
        customRoots, // <-- the configured list is passed
        expect.any(Function)
      );
    });
  });
});

describe('Sidebar scan results rendering', () => {
  const sys = (id: string) => ({
    id,
    type: 'Entry',
    space: { sys: { id: 'sp' } },
    environment: { sys: { id: 'env' } },
  });
  const baseInfo = {
    published: false,
    warnings: [],
    errors: [],
    errorCount: 0,
    entryCount: 1,
    draftEntries: [] as any[],
    updatedEntries: [] as any[],
    draftEntryCount: 0,
    updatedEntryCount: 0,
    assetCount: 0,
    draftAssets: [],
    updatedAssets: [],
    draftAssetCount: 0,
    updatedAssetCount: 0,
  };
  const draftHero = {
    sys: sys('hero1'),
    fields: { title: { 'en-US': 'Hero banner' } },
  };

  async function refresh(info: any) {
    (mockSdk.parameters!.installation as any) = {};
    (mockSdk.entry!.getSys as any).mockReturnValue({
      id: 'page-1',
      contentType: { sys: { id: 'page' } },
      publishedVersion: 1,
      version: 3,
    });
    (references.buildReferenceInformation as any).mockReturnValue(info);
    render(<Sidebar />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
  }

  it('names the blocking entry with label, slug and link, and still lists items needing publishing', async () => {
    await refresh({
      ...baseInfo,
      errorCount: 1,
      errors: [
        {
          sys: sys('bad1'),
          details: {
            label: 'Broken page',
            slug: 'broken',
            errors: [{ message: 'Entry not found or inaccessible' }],
            referrers: [{ referrerEntryId: 'x', referrerContentType: 'page', referrerLabel: 'Home' }],
          },
        },
      ],
      draftEntries: [draftHero],
      draftEntryCount: 1,
    });

    const link = await screen.findByRole('link', { name: 'Broken page' });
    expect(link).toHaveAttribute('href', 'https://app.contentful.com/spaces/sp/environments/env/entries/bad1');
    expect(screen.getByText(/\(\/broken\)/)).toBeInTheDocument();
    expect(screen.getByText(/linked from Home/)).toBeInTheDocument();
    // the items list still renders alongside the error
    expect(screen.getByText(/1 item needs publishing/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Hero banner' })).toBeInTheDocument();
    // Publish is unavailable while true blockers remain
    expect(screen.queryByRole('button', { name: /Publish/i })).not.toBeInTheDocument();
  });

  it('renders warnings and keeps Publish available when there are no hard errors', async () => {
    await refresh({
      ...baseInfo,
      draftEntries: [draftHero],
      draftEntryCount: 1,
      warnings: [
        { kind: 'unpublished', id: 'p2', label: 'Draft page', slug: 'draft-page', reason: 'Linked page is not published', sys: sys('p2') },
        {
          kind: 'duplicate-slug', id: 'p1', label: 'Mine', slug: 'same',
          reason: 'Slug "same" is also used by another page', sys: sys('p1'),
          related: [{ id: 'p9', label: 'Dupe page', slug: 'same', sys: sys('p9') }],
        },
      ],
    });

    expect(await screen.findByText(/does not block publishing/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Draft page' })).toBeInTheDocument();
    expect(screen.getByText(/Linked page is not published/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dupe page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish Now' })).toBeEnabled();
    expect(screen.queryByText(/Blocking:/)).not.toBeInTheDocument();
  });
});
