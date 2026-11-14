import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ComposerEnhanceButton } from './ComposerEnhanceButton';

const renderButton = async (state: 'disabled' | 'ready' | 'loading', disabledReason?: string) => {
  const win = new Window({ url: 'http://localhost' });
  const values = {
    window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement, SVGElement: win.SVGElement,
    Event: win.Event, MouseEvent: win.MouseEvent, MutationObserver: win.MutationObserver,
    ResizeObserver: win.ResizeObserver, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const container = document.createElement('div');
  const root = createRoot(container);
  let clicks = 0;
  try {
    await act(async () => root.render(
      <ThemeSystemProvider>
        <I18nProvider>
          <TooltipProvider>
            <ComposerEnhanceButton
              state={state}
              disabledReason={disabledReason}
              footerIconButtonClass="h-6 w-6"
              iconSizeClass="h-4 w-4"
              onClick={() => { clicks += 1; }}
            />
          </TooltipProvider>
        </I18nProvider>
      </ThemeSystemProvider>,
    ));
    const button = container.querySelector<HTMLButtonElement>('button');
    if (!button) throw new Error('The button did not mount');
    const result = {
      button,
      clicks: () => clicks,
      markup: button.outerHTML,
    };
    await act(async () => button.click());
    return result;
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
};

describe('ComposerEnhanceButton', () => {
  test('ready shows the magic icon and calls onClick', async () => {
    const { button, clicks, markup } = await renderButton('ready');

    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Enhance prompt');
    expect(markup).toContain('#oc-magic');
    expect(clicks()).toBe(1);
  });

  test('loading disables the button and spins the loader', async () => {
    const { button, clicks, markup } = await renderButton('loading');

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(markup).toContain('#oc-loader-4');
    expect(markup).toContain('animate-spin');
    expect(clicks()).toBe(0);
  });

  test('disabled does not call onClick', async () => {
    const { button, clicks } = await renderButton('disabled', 'Type a prompt first');

    expect(button.disabled).toBe(true);
    expect(clicks()).toBe(0);
  });
});
