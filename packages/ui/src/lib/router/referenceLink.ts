import { ROUTE_PARAMS } from './types';

/** This page's own address; empty where there is none (a bare render, a test). */
const currentPageHref = (): string => {
  try {
    return window.location.href;
  } catch {
    return '';
  }
};

/**
 * A link that opens an item in this app instead of naming a page somewhere
 * else: the page on screen, with the item's own link as `?reference=`.
 *
 * A tracker item's `url` is an identity, not an address. For a served tracker
 * (Linear) it is the provider's own page; for the local tracker it is a
 * synthetic `openchamber.local` link its `matchUrl` recognises when pasted
 * back, and no browser can reach. Handing that synthetic link to
 * "copy link" left whoever opened it on a DNS error, so a provider that says
 * its items are not externally navigable
 * (`capabilities.externalUrl`) copies this instead.
 *
 * Kept relative to the page that produced it — same origin, port, tunnel host
 * and any auth parameter the instance needs — so the link works for whoever
 * can already reach this app, and for nobody else.
 *
 * `null` when there is nothing to open, when the item's link is not http(s),
 * or when this page is not served over http(s) at all (the packaged desktop
 * UI's `openchamber-ui://`, a VS Code webview): a pasted link could not reach
 * the app there.
 */
export function referenceLinkHref(itemUrl: string, page?: string): string | null {
  const target = itemUrl.trim();
  if (!target) return null;

  const current = page ?? currentPageHref();
  if (!current) return null;

  try {
    const href = new URL(current);
    if (href.protocol !== 'http:' && href.protocol !== 'https:') return null;

    const item = new URL(target);
    if (item.protocol !== 'http:' && item.protocol !== 'https:') return null;

    href.searchParams.set(ROUTE_PARAMS.REFERENCE, item.toString());
    return href.toString();
  } catch {
    return null;
  }
}
