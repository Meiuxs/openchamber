import * as React from 'react';

import { useShowTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { parseRoute } from '@/lib/router';
import { ROUTE_PARAMS } from '@/lib/router/types';
import { useTrackerAuthStore } from '@/stores/useTrackerAuthStore';

/**
 * Drops `?reference=` without leaving a history entry: the item it named is
 * open, and going back should not open it again.
 */
const dropReferenceParam = (): void => {
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete(ROUTE_PARAMS.REFERENCE);
        // Keep the entry's own state (scroll restoration and the rest).
        window.history.replaceState(window.history.state, '', url.toString());
    } catch {
        // A URL this app cannot read is not one it should rewrite.
    }
};

/**
 * Opens the tracker item a `?reference=` link names, where the app can show
 * it: a Tracker tab of the panel on desktop and web, the board on a phone.
 *
 * A tracker whose items are only reachable inside this app (the local one,
 * whose links carry a synthetic host) has no page to send anyone to, so its
 * copied links land here instead — see `lib/router/referenceLink.ts`.
 *
 * The parameter is read during the first render on purpose: `useRouter`
 * rewrites the URL from app state as soon as it mounts, and app state does
 * not carry it. Nothing is kept once it is honoured.
 */
export const TrackerItemRouteOpener: React.FC = () => {
    const [pending, setPending] = React.useState<string | null>(() => parseRoute().reference);
    const showTrackerItem = useShowTrackerItem();
    // A served tracker answers its status after this mounts, and
    // `showTrackerItem` refuses until then: the entries are what asks again.
    const signedIn = useTrackerAuthStore((state) => state.entries);

    React.useEffect(() => {
        if (!pending) return;
        if (!showTrackerItem(pending, null)) return;
        setPending(null);
        dropReferenceParam();
    }, [pending, showTrackerItem, signedIn]);

    return null;
};
