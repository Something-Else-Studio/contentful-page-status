# Contentful Page Status App

**Stop manually publishing 50+ dependencies every time you update a page.** 

This Contentful app automatically tracks and publishes all your content dependencies with a single click.

## The Problem This Solves

Imagine you're publishing a landing page that contains:
- 20 content components (hero, testimonials, FAQ sections, etc.)
- 30 images and assets
- 5 author profiles
- Various other linked content

**Without this app**: You need to manually find and publish each of these 55+ items in the correct order before publishing your page. Miss one? Your live site has broken content.

**With this app**: See "55 items need publishing" → Click "Publish all" → Done. ✅

## How It Works

The app appears in your entry editor sidebar and:

```
1. Scans your content     →  2. Shows status         →  3. One-click publish
   ┌─────────────┐             ┌─────────────────┐        ┌──────────────┐
   │ Your Page   │             │ 12 drafts       │        │ Publishing:  │
   │ ├─ Hero     │             │ 8 updated       │        │ ✓ 15 assets  │
   │ ├─ Gallery  │ ──────────► │ 3 out of date   │ ────► │ ✓ 8 entries  │
   │ └─ Footer   │             │ 2 errors        │        │ ✓ Your page  │
   └─────────────┘             └─────────────────┘        └──────────────┘
```

## Key Features

### 🔍 Smart Dependency Detection
- Recursively finds ALL content referenced by your entry
- Identifies drafts, updated content, and out-of-date references
- Shows exactly what needs publishing before your content goes live

### 🚀 One-Click Publishing
- Publishes in the correct order: assets → entries → your main content
- No more hunting for unpublished dependencies
- Progress tracking shows what's being published in real-time

### 📅 Scheduled Publishing
- Schedule your content AND all its dependencies for future publication
- Perfect for coordinated content releases
- Set it and forget it

### ⚡ Performance Optimized
- Excludes circular references automatically
- Fast loading even for content with hundreds of dependencies
- Smart caching reduces API calls

## Who This Is For

- **Content Teams**: Managing pages with multiple components
- **Marketing Teams**: Launching campaigns with many assets
- **Developers**: Building modular content architectures
- **Anyone** tired of the "which component did I forget to publish?" game

## Installation

### Quick Start

1. **Clone and install:**
   ```bash
   git clone [your-repo-url]
   cd contentful-page-status
   npm install
   ```

2. **Set up in Contentful:**
   ```bash
   npm run create-app-definition
   npm run add-locations  # Choose "Entry Sidebar"
   ```

3. **Build and deploy:**
   ```bash
   npm run build
   npm run upload
   ```

That's it! The app now appears in your entry editor sidebar.

### Requirements

- Contentful space with Management API access
- Node.js 16+
- Proper publishing permissions in Contentful

## Using the App

### In the Entry Editor

When editing any entry, look for the Page Status widget in the sidebar:

- **Green checkmark**: All dependencies are published
- **Orange number**: Shows count of items needing publication
- **Red X**: Errors or missing references detected

### Publishing Options

1. **"Publish all" button**:
   - Instantly publishes all dependencies
   - Shows progress (e.g., "Publishing 12 of 25...")
   - Confirms when complete

2. **"Schedule publishing" button**:
   - Opens date/time picker
   - Schedules all content for the same time
   - Great for embargo dates

### Understanding the Status

The app categorizes content as:
- **Draft**: Never published (new content)
- **Updated**: Has unpublished changes
- **Out of date**: Published after the parent (may cause issues)
- **Errors**: Broken or inaccessible references (open the browser console to see which entry referenced a missing item)

## Development

### Technical Documentation

For detailed architectural information, code structure, and development rules, please refer to [CLAUDE.md](CLAUDE.md).

### Local Development

```bash
npm run dev  # Starts on http://localhost:5173
```

**Note**: You'll see a localhost warning - this is normal. The app only fully works within Contentful.

### Project Structure

```
src/locations/Sidebar.tsx  # ← 90% of the app logic is here
src/App.tsx               # Simple router
src/index.tsx            # SDK initialization
```

### Key Scripts

- `npm run dev` - Development server
- `npm test` - Run tests
- `npm run build` - Production build
- `npm run upload` - Deploy to Contentful

### Making Changes

Most modifications happen in `src/locations/Sidebar.tsx`. Refer to [CLAUDE.md](CLAUDE.md) for detailed function descriptions and logic flows.

## Advanced Configuration

### Root Content Types

By default, these content types are considered "Roots". They are checked for validity but not traversed, and must be published manually if referenced:
- `article`, `page`

Modify `ROOT_CONTENT_TYPES` in `Sidebar.tsx` to change this behavior.

### Environment Variables (CI/CD)

For automated deployments:
```bash
CONTENTFUL_ORG_ID=xxx
CONTENTFUL_APP_DEF_ID=xxx
CONTENTFUL_ACCESS_TOKEN=xxx
npm run upload-ci
```

## Troubleshooting

**"Blocking: X need publishing" or missing reference?**
- Open the browser DevTools Console; "Entry not found" and "Missing asset" messages include which entry (and content type) referenced the missing item so you can fix the broken link.

**Nothing showing in sidebar?**
- Save your entry first - the app needs an entry ID
- Check browser console for errors
- Verify app installation in space settings

**Publishing fails?**
- Check your publishing permissions
- Some content may have validation errors
- Review the error message in the UI

**Too slow with large pages?**
- Normal for pages with 100+ dependencies
- Consider breaking very large pages into smaller components

## Support & Contribution

- Report issues: [GitHub Issues]
- App built with: Contentful App Framework, React, TypeScript
- Uses Forma 36 design system for native Contentful look

---

*Stop the manual publishing madness. Let Page Status handle your content dependencies.*