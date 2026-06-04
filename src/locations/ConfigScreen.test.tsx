import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { useSDK } from '@contentful/react-apps-toolkit';
import { vi, beforeEach, describe, it, expect } from 'vitest';
import ConfigScreen from './ConfigScreen';
import type { ConfigAppSDK } from '@contentful/app-sdk';

vi.mock('@contentful/react-apps-toolkit', () => ({
  useSDK: vi.fn(),
}));

const mockSdk = {
  app: {
    onConfigure: vi.fn(),
    getParameters: vi.fn(),
    setReady: vi.fn(),
    getCurrentState: vi.fn(),
  },
};

beforeEach(() => {
  (useSDK as any).mockReturnValue(mockSdk as unknown as ConfigAppSDK);
  vi.clearAllMocks();
});

describe('ConfigScreen', () => {
  it('renders the root content types input with help text', () => {
    render(<ConfigScreen />);
    expect(screen.getByText('Root Content Types')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/page, article, pageVariant/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Comma-separated list of content type IDs/i)
    ).toBeInTheDocument();
  });

  it('loads existing rootContentTypes from parameters', async () => {
    (mockSdk.app.getParameters as any).mockResolvedValueOnce({
      rootContentTypes: ['page', 'article', 'customType'],
    });

    render(<ConfigScreen />);

    // Wait for async load
    await screen.findByDisplayValue('page, article, customType');
  });

  it('updates parameters when user types in the input', async () => {
    (mockSdk.app.getParameters as any).mockResolvedValueOnce(null);

    render(<ConfigScreen />);

    const input = screen.getByPlaceholderText(/page, article, pageVariant/i);
    fireEvent.change(input, { target: { value: 'page, pageVariant, customType' } });

    // Badges should appear
    expect(screen.getByText('page')).toBeInTheDocument();
    expect(screen.getByText('pageVariant')).toBeInTheDocument();
    expect(screen.getByText('customType')).toBeInTheDocument();
  });

  it('includes rootContentTypes in onConfigure result', async () => {
    const onConfigureMock = vi.fn();
    (mockSdk.app.onConfigure as any).mockImplementation((cb: any) => {
      onConfigureMock.mockImplementation(cb);
    });
    (mockSdk.app.getParameters as any).mockResolvedValueOnce(null);
    (mockSdk.app.getCurrentState as any).mockResolvedValueOnce({});

    render(<ConfigScreen />);

    const input = screen.getByPlaceholderText(/page, article, pageVariant/i);
    fireEvent.change(input, { target: { value: 'article, page' } });

    // Simulate save
    const result = await onConfigureMock();

    expect(result.parameters.rootContentTypes).toEqual(['article', 'page']);
    expect(mockSdk.app.getCurrentState).toHaveBeenCalled();
  });

  it('omits rootContentTypes (sets undefined) when input is cleared', async () => {
    const onConfigureMock = vi.fn();
    (mockSdk.app.onConfigure as any).mockImplementation((cb: any) => {
      onConfigureMock.mockImplementation(cb);
    });
    (mockSdk.app.getParameters as any).mockResolvedValueOnce({
      rootContentTypes: ['page'],
    });
    (mockSdk.app.getCurrentState as any).mockResolvedValueOnce({});

    render(<ConfigScreen />);

    const input = await screen.findByDisplayValue('page');
    fireEvent.change(input, { target: { value: '' } });

    const result = await onConfigureMock();

    expect(result.parameters.rootContentTypes).toBeUndefined();
  });
});
