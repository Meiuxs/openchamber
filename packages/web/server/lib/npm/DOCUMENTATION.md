# npm registry

## Ownership

This module owns reads of npm package metadata: the registry and credentials a request goes to, and the cached package lookups built on that.

## Invariants

- Registry selection reads inherited npm environment variables and the user's `.npmrc`. Scoped registries take precedence over general registries. Credentials are sent in headers and removed from request URLs.
- Registry JSON remains unchecked until use. Dist tags accept string values only; versions accept the keys of a non-array object. Missing or invalid metadata fields produce empty collections.
- Successful lookups and 404 responses are cached for 1 hour. Other failures remain retryable. Forced refresh bypasses both the cache and in-flight deduplication.
- The user agent reads the checkout's root package version. A missing or unreadable checkout manifest, including JSON null, uses `dev`; a readable non-null value without a string version uses `0.0.0`.

## Decisions

### Why metadata keeps input guards

Registry responses and the checkout manifest are external JSON, so their types describe JSON values until the existing object and string checks narrow them. Thrown failures may carry a non-string message; error formatting retains that value through the existing nullish fallback and string conversion.

### Why the policy registry sits between scoped and generic registries

For an unscoped package, registry resolution goes: scoped registries first (scope-specific environment variable, then `.npmrc` scoped key), then the policy registry (`readNpmRegistry()` — the fork's intranet npm mirror), then the generic environment variable, then the generic `.npmrc` value, then the public default. The fork's mirror applies to every unscoped package, so it sits behind the scoped registries (a scope opts into a specific server) and ahead of the generic ones: an explicit generic npm config left on the machine is a personal choice that the app's policy answer overrides.
