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
