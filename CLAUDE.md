# Project Context: Contentful Page Status App

This is a Contentful app that provides intelligent publishing capabilities for content with complex dependency structures. The app helps content editors ensure all referenced content is published before publishing the main entry.

## Core Functionality

The app's main purpose is to:
1. Recursively analyze all content references within an entry
2. Identify unpublished or out-of-date dependencies
3. Enable batch publishing of all dependencies with one click
4. Allow scheduling of content publication for future dates

## Tech Stack

- **React 18** with TypeScript
- **Vite** for building and development
- **Contentful App SDK** for integration
- **Forma 36** (Contentful's design system)
- **Contentful Management API** for content operations
- **Vitest** for testing

## Code Structure

```
/
├── src/
│   ├── index.tsx           # App entry point and SDK initialization
│   ├── App.tsx            # Location router component
│   ├── locations/
│   │   ├── Sidebar.tsx    # Main app logic and UI (MOST IMPORTANT FILE)
│   │   └── ConfigScreen.tsx # App configuration screen
│   └── components/
│       └── LocalhostWarning.tsx # Dev environment warning
├── test/
│   └── mocks/            # Test mocks for SDK and CMA
├── package.json          # Dependencies and scripts
├── vite.config.mts      # Vite configuration
└── tsconfig.json        # TypeScript configuration
```

## Key File: Sidebar.tsx

This is where 90% of the app logic lives. Key functions:
- `fetchAllReferences()`: Recursively fetches all content dependencies
- `publishAll()`: Publishes all unpublished content in the correct order
- `schedulePublishing()`: Creates scheduled actions for future publication

## Development Commands

```bash
# Install dependencies
npm install

# Start development server (runs on http://localhost:5173)
npm run dev

# Run tests
npm test

# Build for production
npm run build

# Create app definition in Contentful
npm run create-app-definition

# Upload to Contentful
npm run upload
```

## Common Development Tasks

### Adding a New Feature

1. Most features will be added to `src/locations/Sidebar.tsx`
2. Use Forma 36 components from `@contentful/f36-components`
3. Follow existing patterns for state management with React hooks

### Modifying the Publishing Logic

The publishing logic in `publishAll()` follows this order:
1. Publish all draft/updated assets first
2. Then publish all draft/updated entries
3. Finally publish the main entry
4. Handle errors and show appropriate messages

### Updating Excluded Content Types

In `fetchAllReferences()`, certain content types are excluded to prevent circular references:
```typescript
const excludedContentTypes = ['article', 'page', 'navigation', 'siteSettings', 'redirects'];
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

## Performance Considerations

- Excludes certain content types to avoid infinite recursion
- Uses `include` parameter to reduce API calls
- Shows progress indicators for long operations
- Fetches in batches when possible

## Deployment

1. Build the app: `npm run build`
2. Upload to Contentful: `npm run upload`
3. For CI/CD, use: `npm run upload-ci` with environment variables:
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
2. Check the Console for SDK debug messages
3. The localhost warning component helps identify dev environment
4. Most errors are caught and displayed in the UI

## Future Improvements to Consider

- Add configuration options for excluded content types
- Implement retry logic for failed publishes
- Add more granular progress tracking
- Support for bulk operations across multiple entries
- Caching to improve performance for large content trees