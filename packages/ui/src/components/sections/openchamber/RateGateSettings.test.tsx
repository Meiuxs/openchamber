import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import type { ProviderWithModelList } from '@/stores/config/types';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { RateGateSettings } from './RateGateSettings';

const provider = (id: string, name: string, baseURL?: string): ProviderWithModelList => ({
  id,
  name,
  activation: 'enabled',
  package: id,
  models: [],
  settings: baseURL ? { baseURL } : {},
});

const anchors = () => Array.from(document.querySelectorAll('[data-settings-item]'))
  .map((element) => element.getAttribute('data-settings-item'));

describe('RateGateSettings', () => {
  let windowInstance: Window;
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    windowInstance = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      Node: windowInstance.Node,
      Element: windowInstance.Element,
      HTMLElement: windowInstance.HTMLElement,
      HTMLTextAreaElement: windowInstance.HTMLTextAreaElement,
      Event: windowInstance.Event,
      MouseEvent: windowInstance.MouseEvent,
      MutationObserver: windowInstance.MutationObserver,
      getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
      requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
      cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    useUIStore.setState({
      modelRateLimitRequests: 100,
      modelRateLimitWindowMinutes: 10,
      modelRateLimitGateways: '',
    });
    useConfigStore.setState({ providers: [] });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useConfigStore.setState({ providers: [] });
    windowInstance.close();
  });

  const render = async () => {
    await act(async () => {
      root.render(<I18nProvider><RateGateSettings /></I18nProvider>);
    });
  };

  test('shows a row and a control for each request throttle setting', async () => {
    await render();

    expect(anchors()).toEqual([
      'sessions.rate-gate-requests',
      'sessions.rate-gate-window',
      'sessions.rate-gate-gateways',
    ]);
    expect(host.textContent).toContain('Request throttle');
    expect(host.querySelectorAll('input').length).toBe(2);
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(host.querySelector('[aria-label="Add from a provider"]')).toBeNull();
  });

  test('offers the addresses of configured providers as gateways', async () => {
    useConfigStore.setState({
      providers: [
        provider('campus-llm', 'Campus LLM', 'https://llm.example.edu/v1'),
        provider('no-url', 'No URL'),
      ],
    });

    await render();

    expect(host.querySelector('[aria-label="Add from a provider"]')).not.toBeNull();
  });
});
