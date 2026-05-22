# Project Context: Contentful Page Status App

## Rules
- **Always update documentation (CLAUDE.md and README.md) when making code changes.**
- Ensure that technical details in the documentation match the implementation.

This is a Contentful app that provides intelligent publishing capabilities for content with complex dependency structures. The app helps content editors ensure all referenced content is published before publishing the main entry, and can also propagate changes made to a shared component upward to all pages/articles that use it.

## Core Functionality

The app's main purpose is to:
1. Recursively analyze all content references within an entry
2. Identify unpublished or out-of-date dependencies
3. Enable batch publishing of all dependencies with one click
4. Allow scheduling of content publication for future dates
5. For non-root entries (components): find all root nodes that use this component and publish them after the component is published ("reverse publish")

## Tech Stack

- **React 18.3** with TypeScript 6
- **Vite 8** for building and development
- **Node.js 24** (pinned via `.nvmrc` and `engines`)
- **pnpm 11** for package management
- **Contentful App SDK 4** for integration
- **Forma 36 v6** (Contentful's design system)
- **Contentful Management API client 12** for content operations
- **Vitest 4** for testing

## Code Structure

```
/
├── src/
│ ├── index.tsx               # App entry point and SDK initialization
│ ├── App.tsx                # Location router component
│ ├── lib/
│ │ ├── types.ts           # All shared interfaces and types
│ │ ├── debug.ts           # debugLog/debugError gated by DEBUG_ENABLED; logError always on for operational failures
│ │ ├── utils.ts           # Pure helpers: ROOT_CONTENT_TYPES, getEntryLabel, getEditorEntry, etc.
│ │ ├── references.ts      # Fetch logic: fetchReferencesIteratively, fetchUpstreamRoots, buildReferenceInformation, cache
│ │ └── publish.ts         # Publish orchestration: doPublish, doReversePublish
│ ├── locations/
│ │ ├── Sidebar.tsx        # React component only (~300 lines)
│ │ └── ConfigScreen.tsx   # App configuration screen (boilerplate)
│ └── components/
│ └── LocalhostWarning.tsx # Dev environment warning
├── test/
│ └── mocks/               # Test mocks for SDK and CMA
├── package.json             # Dependencies and scripts
├── .nvmrc                   # Node 24 pin
├── pnpm-workspace.yaml      # pnpm config (React 18 overrides)
├── vite.config.mts         # Vite + Vitest + PNA dev-server config
└── tsconfig.json           # TypeScript configuration
```

## Key Files

### `src/lib/types.ts`
All shared interfaces. Includes `IEntrySysLike` (minimal sys shape accepted by `buildReferenceInformation` — satisfies both `EntrySys` from app-sdk and `EntryProps.sys` from contentful-management without casting), `IEditorLinkSys` (minimal shape for `getEditorEntry`), and `EntryReferenceError` (derived from `EntryReferenceProps["errors"]` since contentful-management v12 no longer exports it from the package root).

### `src/lib/references.ts`
Core fetch logic:
- `fetchReferencesIteratively()`: Downward BFS — recursively fetches all outgoing dependencies. Results cached for 60 s by entry ID.
- `buildReferenceInformation()`: Builds `IReferenceInformation` from raw references. Parameter typed as `IEntrySysLike` (no unsafe casts needed).
- `fetchUpstreamRoots()`: Upward BFS via `links_to_entry` CMA query. Returns all root-type ancestors plus a `failedLookups` count. Caps: Sidebar processes at most `UPSTREAM_ROOT_LIMIT` (50) roots for full dependency analysis; the "Used on" header reflects the total discovered count.

### `src/lib/publish.ts`
- `doPublish()`: Immediate or scheduled publishing of a dependency set. Optional `overrideEntry` publishes a different entry than the current sidebar entry.
- `doReversePublish()`: Publishes the component first (unless `skipComponentPublish`), then each selected safe upstream root in sequence.

### `src/lib/utils.ts`
Pure, SDK-free helpers: `ROOT_CONTENT_TYPES`, `getEntryLabel`, `getEntrySlug`, `getLinksFromEntry`, `getMissingIds`, `getEditorEntry` (typed with `IEditorLinkSys` — no `EntityMetaSysProps` cast).

### `src/locations/Sidebar.tsx`
React component only. Uses two loading phases ("Scanning dependencies…" / "Finding pages that use this…") with distinct progress labels and detail text (including per-page progress during upstream analysis). Shows upstream roots left-aligned with slug labels, per-page checkboxes (plus select-all), safe/blocked badges, truncated-count note (when more than 50 roots exist), and failed-lookup warning. Up-to-date status reads "This entry is up to date" (not dependency count, which is 0 for leaf components).

## Two Operating Modes

The sidebar detects whether the current entry is a root node (`ROOT_CONTENT_TYPES.includes(contentTypeId)`):

**Root mode** (article / page): Existing behaviour — traverse all dependencies downward, publish them, then publish the root.

**Component mode** (any other content type): After fetching the component's own dependencies, `fetchUpstreamRoots()` is called to find all pages/articles that (directly or indirectly) reference this component. Each root is checked with `fetchReferencesIteratively` + `buildReferenceInformation`. The UI shows a left-aligned "Used on N pages" section with slug labels, checkboxes (all safe roots selected by default), and safe/blocked status for each root. The publish button label reflects the selected count (`Publish + N pages` or `Publish N pages` when the component is up to date). Only selected safe roots are passed to `doReversePublish`. When the component and its dependencies are already published, selecting pages still enables publish for those roots only (`skipComponentPublish`).

## Development Commands

```bash
# Install dependencies
pnpm install

# Start development server (runs on http://localhost:3000)
pnpm run dev

# Run tests
pnpm test

# Build for production
pnpm run build

# Create app definition in Contentful
pnpm run create-app-definition

# Upload to Contentful
pnpm run upload
```

## Common Development Tasks

### Adding a New Feature

1. Most features will be added to `src/locations/Sidebar.tsx`
2. Use Forma 36 components from `@contentful/f36-components`
3. Follow existing patterns for state management with React hooks

### Modifying the Publishing Logic

The publishing logic in `doPublish()` follows this order:
1. Publish (or schedule) all draft/updated assets first
2. Then publish (or schedule) all draft/updated entries
3. Finally publish (or schedule) the main entry
4. Handle errors and show appropriate messages

### Updating Root Content Types

In `fetchReferencesIteratively()`, certain content types are marked as "Roots". If encountered during traversal:
1. They are checked for publication status.
2. If unpublished, they block the entire publication process (Error).
3. They are NOT traversed further (recursion stops).

```typescript
const ROOT_CONTENT_TYPES = ['article', 'page'];
```

### Working with the Contentful SDK

Key SDK objects available:
- `sdk.entry`: Current entry being edited
- `sdk.space`: Current space information
- `sdk.user`: Current user
- `sdk.cma`: Contentful Management API client

### API Patterns

Fetching entries:
```typescript
const response = await sdk.cma.entry.getMany({
 query: {
 'sys.id[in]': ids.join(','),
 include: 2
 }
});
```

Publishing content:
```typescript
await sdk.cma.entry.publish({ entryId }, entry);
```

Creating scheduled actions:
```typescript
await sdk.cma.scheduledAction.create({
 entity: { sys: { id: entryId, type: 'Link', linkType: 'Entry' } },
 environment: { sys: { id: environment.sys.id, type: 'Link', linkType: 'Environment' } },
 scheduledFor: { datetime: scheduledDate },
 action: 'publish'
});
```

## Testing Strategy

- Unit tests use Vitest with React Testing Library
- Mocks are provided for Contentful SDK and CMA
- Test files should be colocated with components
- Run tests before committing changes

## Error Handling

The app handles several error scenarios:
- Missing references (shows as errors in UI)
- Publishing failures (caught and displayed to user)
- API rate limits (should implement retry logic if needed)

When an entry or asset is reported as missing or inaccessible, the app tracks which entry (and content type) referenced it. "Entry not found" and "Missing asset" console messages include this referrer info (e.g. `Entry not found: <id> (referenced from: Entry <refId> [contentType])`) so you can locate the broken reference. The same referrer data is attached to the error object as `details.referrers` for potential UI use.

## Performance Considerations

- Excludes certain content types to avoid infinite recursion
- Uses `include` parameter to reduce API calls
- Shows progress indicators for long operations
- Fetches in batches when possible

## Deployment

1. Build the app: `pnpm run build`
2. Upload to Contentful: `pnpm run upload`
3. For CI/CD, use: `pnpm run upload-ci` with environment variables:
 - `CONTENTFUL_ORG_ID`
 - `CONTENTFUL_APP_DEF_ID`
 - `CONTENTFUL_ACCESS_TOKEN`

## Important Notes

- The app only works within Contentful's web app (not standalone)
- Requires proper permissions to publish content
- Different behavior in master vs other environments
- Some content types are intentionally excluded from processing

## Debugging Tips

1. Use browser DevTools to inspect API calls
2. Verbose console output (reference traversal, stats, missing-entry diagnostics) is **off by default**. Enable via `VITE_DEBUG=true` when running dev (`pnpm run dev`), or set `DEBUG_FROM_SOURCE = true` in [`src/lib/debug.ts`](src/lib/debug.ts). Publish and sidebar fetch errors always use `logError` (not gated).
3. The localhost warning component helps identify dev environment
4. Chrome 142+ Local Network Access: the Vite dev server must respond to PNA preflights from `app.contentful.com` with `Access-Control-Allow-Private-Network: true` (see `vite.config.mts`)
5. Most errors are caught and displayed in the UI

## Future Improvements to Consider

- Add configuration options for excluded content types
- Implement retry logic for failed publishes
- Add more granular progress tracking
- Support for bulk operations across multiple entries
- Caching to improve performance for large content trees