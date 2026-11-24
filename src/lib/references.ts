import type { SidebarAppSDK } from "@contentful/app-sdk";
import {
	isDraft,
	isPublished,
	isUpdated,
} from "contentful-management";
import type {
	AssetProps,
	EntryProps,
	KeyValueMap,
} from "contentful-management";
import type {
	IAllReferences,
	IEditorLinkSys,
	IEntrySysLike,
	IReferenceInformation,
	IScanWarning,
	IUpstreamRootsResult,
} from "./types";
import {
	ROOT_CONTENT_TYPES as DEFAULT_ROOT_CONTENT_TYPES,
	getEntryLabel,
	getLinksFromEntry,
	getMissingIds,
	getRawSlug,
	isArchived,
} from "./utils";
import { debugLog, debugError } from "./debug";

const REF_CACHE_TTL_MS = 60_000;
const refInfoCache = new Map<string, { ts: number; refs: IAllReferences }>();

/**
 * Clears the 60s reference info cache for a specific entry (or all if no id given).
 * Called after publish (success or partial) and at the start of every manual Refresh
 * so that "Refresh to check status" after a publish always sees the true state
 * and avoids VersionMismatch (stale sys.version) on subsequent publish attempts.
 */
export function clearReferenceCache(entryId?: string): void {
	if (entryId) {
		refInfoCache.delete(entryId);
	} else {
		refInfoCache.clear();
	}
}

const BATCH_SIZE = 50;
const MAX_SLUG_QUERIES = 50;

type EntrySdkLike = Pick<SidebarAppSDK, "cma">;

function entrySysForLink(entry: EntryProps<KeyValueMap>): IEditorLinkSys {
	return {
		id: entry.sys.id,
		type: "Entry",
		space: entry.sys.space,
		environment: entry.sys.environment,
	};
}

/** Link-building sys for entities that could not be fetched (missing/inaccessible). */
function sysFromIds(sdk: SidebarAppSDK, id: string, type: string): IEditorLinkSys {
	return {
		id,
		type,
		space: { sys: { id: sdk.ids?.space } },
		environment: { sys: { id: sdk.ids?.environment } },
	} as IEditorLinkSys;
}

function describeRoot(entry: EntryProps<KeyValueMap>) {
	return {
		id: entry.sys.id,
		label: getEntryLabel(entry),
		slug: getRawSlug(entry),
		sys: entrySysForLink(entry),
	};
}

/**
 * For each root entry that has a slug, look for other non-archived entries of the same
 * content type with the same slug. Returns one non-blocking warning per entry that shares
 * a slug. Lean: one query per distinct (contentType, slug), capped at MAX_SLUG_QUERIES.
 */
export async function findDuplicateSlugWarnings(
	sdk: EntrySdkLike,
	entries: EntryProps<KeyValueMap>[],
): Promise<IScanWarning[]> {
	const warnings: IScanWarning[] = [];
	const seen = new Set<string>();
	const candidates: EntryProps<KeyValueMap>[] = [];
	for (const entry of entries) {
		if (!getRawSlug(entry) || isArchived(entry) || seen.has(entry.sys.id)) continue;
		seen.add(entry.sys.id);
		candidates.push(entry);
	}
	const queried = new Map<string, EntryProps<KeyValueMap>[]>();
	for (const entry of candidates.slice(0, MAX_SLUG_QUERIES)) {
		const ct = entry.sys.contentType.sys.id;
		const slug = getRawSlug(entry);
		const key = `${ct}|${slug}`;
		try {
			if (!queried.has(key)) {
				const res = await sdk.cma.entry.getMany({
					query: { content_type: ct, "fields.slug": slug, limit: 20 },
				});
				queried.set(
					key,
					res.items.filter((e) => !isArchived(e)),
				);
			}
			const others = (queried.get(key) ?? []).filter(
				(e) => e.sys.id !== entry.sys.id,
			);
			if (others.length > 0) {
				const me = describeRoot(entry);
				warnings.push({
					kind: "duplicate-slug",
					...me,
					reason: `Slug "${slug}" is also used by another ${ct}`,
					related: others.map(describeRoot),
				});
			}
		} catch (error) {
			debugError(`Duplicate slug lookup failed for ${slug}`, error);
		}
	}
	return warnings;
}

function blockingError(
	sdk: SidebarAppSDK,
	args: {
		id: string;
		type: "Entry" | "Asset";
		message: string;
		referrers?: unknown[];
	},
) {
	return {
		details: {
			errors: [{ message: args.message }],
			referrers: args.referrers ?? [],
			label: `${args.type} ${args.id}`,
			slug: "",
		},
		sys: sysFromIds(sdk, args.id, args.type),
	} as any;
}

export async function fetchReferencesIteratively(
	sdk: SidebarAppSDK,
	entryId: string,
	rootContentTypes: string[] = [],
	setProgress?: (progress: { processed: number; total: number }) => void,
): Promise<IAllReferences> {
	const cached = refInfoCache.get(entryId);
	if (cached && Date.now() - cached.ts < REF_CACHE_TTL_MS) {
		return cached.refs;
	}

	const allReferences: IAllReferences = {
		entries: [],
		assets: [],
		errors: [],
		warnings: [],
		processedEntryIds: new Set<string>(),
	};
	const slugEntries: EntryProps<KeyValueMap>[] = [];

	const rootContentTypesToUse =
		rootContentTypes.length > 0 ? rootContentTypes : DEFAULT_ROOT_CONTENT_TYPES;

	const entriesToProcess: string[] = [entryId];
	const entriesQueued = new Set<string>([entryId]);
	const trackedEntryIds = new Set<string>();
	const trackedAssetIds = new Set<string>();

	type Referrer = {
		referrerEntryId: string;
		referrerContentType: string;
		referrerLabel?: string;
	};
	const entryReferrers = new Map<string, Referrer[]>();
	const assetReferrers = new Map<string, Referrer[]>();

	let processed = 0;
	let total = 1;

	while (entriesToProcess.length > 0) {
		const batchIds = entriesToProcess.splice(0, BATCH_SIZE);

		try {
			const response = await sdk.cma.entry.getMany({
				query: {
					"sys.id[in]": batchIds.join(","),
					limit: BATCH_SIZE,
				},
			});

			processed += batchIds.length;
			if (setProgress) setProgress({ processed, total });

			const missingIds = getMissingIds(batchIds, response.items);
			missingIds.forEach((id) => {
				const referrers = entryReferrers.get(id) ?? [];
				const referrerText =
					referrers.length > 0
						? referrers
								.map(
									(r) =>
										`Entry ${r.referrerEntryId} [${r.referrerContentType}]`,
								)
								.join(", ")
						: "unknown";
				debugError(
					`Entry not found: ${id} (referenced from: ${referrerText})`,
				);
				allReferences.errors.push(
					blockingError(sdk, {
						id,
						type: "Entry",
						message: "Entry not found or inaccessible",
						referrers,
					}),
				);
			});

			const assetIdsToFetch = new Set<string>();

			for (const entry of response.items) {
				const currentEntryId = entry.sys.id;
				const contentType = entry.sys.contentType.sys.id;

				if (currentEntryId !== entryId) {
					debugLog(
						`Processing [${contentType}] ${entry.sys.id} ("${entry.sys.id}") - Draft: ${isDraft(entry)}, Published: ${isPublished(entry)}, Updated: ${isUpdated(entry)}`,
					);

					const isRootType = rootContentTypesToUse.includes(contentType);

					// Archived entries are ignored: never blockers, never "need publishing".
					if (isArchived(entry)) {
						if (isRootType) {
							allReferences.warnings.push({
								kind: "archived",
								...describeRoot(entry),
								reason: `Linked ${contentType} is archived`,
							});
						}
						continue;
					}

					if (isRootType) {
						debugLog(
							`Stopping search at Root: [${contentType}] ${entry.sys.id}`,
						);
						// An unpublished linked page/root is a warning, not a blocker.
						if (!isPublished(entry)) {
							allReferences.warnings.push({
								kind: "unpublished",
								...describeRoot(entry),
								reason: `Linked ${contentType} is not published`,
							});
						}
						slugEntries.push(entry);
						continue;
					}

					if (!trackedEntryIds.has(currentEntryId)) {
						allReferences.entries.push(entry);
						trackedEntryIds.add(currentEntryId);
					}

					if (allReferences.processedEntryIds.has(currentEntryId)) {
						continue;
					}
					allReferences.processedEntryIds.add(currentEntryId);
				} else {
					debugLog(
						`Processing ROOT ENTRY [${contentType}] ${entry.sys.id}`,
					);
					if (rootContentTypesToUse.includes(contentType)) {
						slugEntries.push(entry);
					}
				}

				const links = getLinksFromEntry(entry);
				const referrer: Referrer = {
					referrerEntryId: currentEntryId,
					referrerContentType: contentType,
					referrerLabel: getEntryLabel(entry),
				};

				for (const link of links) {
					if (link.type === "Asset") {
						const refs = assetReferrers.get(link.id) ?? [];
						refs.push(referrer);
						assetReferrers.set(link.id, refs);
						if (!trackedAssetIds.has(link.id)) {
							assetIdsToFetch.add(link.id);
							trackedAssetIds.add(link.id);
						}
					} else if (link.type === "Entry") {
						const refs = entryReferrers.get(link.id) ?? [];
						refs.push(referrer);
						entryReferrers.set(link.id, refs);
						if (!entriesQueued.has(link.id)) {
							entriesToProcess.push(link.id);
							entriesQueued.add(link.id);
							total++;
							if (setProgress) setProgress({ processed, total });
						}
					}
				}
			}

			if (assetIdsToFetch.size > 0) {
				const assetIds = Array.from(assetIdsToFetch);
				for (let i = 0; i < assetIds.length; i += BATCH_SIZE) {
					const assetBatch = assetIds.slice(i, i + BATCH_SIZE);
					try {
						const assetsResponse = await sdk.cma.asset.getMany({
							query: {
								"sys.id[in]": assetBatch.join(","),
								limit: assetBatch.length,
							},
						});
						allReferences.assets.push(
							...assetsResponse.items.filter((a) => !isArchived(a)),
						);

						getMissingIds(assetBatch, assetsResponse.items).forEach((id) => {
							const referrers = assetReferrers.get(id) ?? [];
							const referrerText =
								referrers.length > 0
									? referrers
											.map(
												(r) =>
													`Entry ${r.referrerEntryId} [${r.referrerContentType}]`,
											)
											.join(", ")
									: "unknown";
							debugError(
								`Missing asset ${id} (referenced from: ${referrerText})`,
							);
							allReferences.errors.push(
								blockingError(sdk, {
									id,
									type: "Asset",
									message: `Missing asset ${id}`,
									referrers,
								}),
							);
						});
					} catch (e) {
						debugError(`Error fetching asset batch`, e);
						assetBatch.forEach((id) => {
							const referrers = assetReferrers.get(id) ?? [];
							allReferences.errors.push(
								blockingError(sdk, {
									id,
									type: "Asset",
									message: `Error fetching asset ${id}`,
									referrers,
								}),
							);
						});
					}
				}
			}
		} catch (error) {
			debugError("Batch fetch error", error);
			batchIds.forEach((id) => {
				const referrers = entryReferrers.get(id) ?? [];
				allReferences.errors.push(
					blockingError(sdk, {
						id,
						type: "Entry",
						message: `Error fetching entry batch: ${error}`,
						referrers,
					}),
				);
			});
			processed += batchIds.length;
			if (setProgress) setProgress({ processed, total });
		}
	}

	if (slugEntries.length > 0) {
		allReferences.warnings.push(
			...(await findDuplicateSlugWarnings(sdk, slugEntries)),
		);
	}

	refInfoCache.set(entryId, { ts: Date.now(), refs: allReferences });
	return allReferences;
}

export function buildReferenceInformation(
	entrySys: IEntrySysLike,
	allReferences: IAllReferences,
): IReferenceInformation {
	const publishedDate = entrySys.publishedAt;

	// Inline isPublished / isUpdated to avoid casting entrySys to any
	const isEntryPublished = entrySys.publishedVersion != null;
	const isEntryUpdated =
		entrySys.version > (entrySys.publishedVersion ?? 0) + 1;

	const errors = allReferences.errors;
	const errorCount = errors?.length ?? 0;

	const entries = allReferences.entries?.filter((e) => !isArchived(e));
	const entryCount = entries?.length ?? 0;
	const draftEntries = entries?.filter(isDraft) ?? [];
	const updatedEntries = entries?.filter(isUpdated) ?? [];
	const draftEntryCount = draftEntries.length;
	const updatedEntryCount = updatedEntries.length;

	const assets = allReferences.assets?.filter((a) => !isArchived(a));
	const assetCount = assets?.length ?? 0;
	const draftAssets = assets?.filter(isDraft) ?? [];
	const draftAssetCount = draftAssets.length;
	const updatedAssets = assets?.filter(isUpdated) ?? [];
	const updatedAssetCount = updatedAssets.length;

	const assetsPublishedAfter = assets?.filter(
		(a: AssetProps) =>
			publishedDate && a.sys.publishedAt && a.sys.publishedAt > publishedDate,
	);
	const entriesPublishedAfter = entries?.filter(
		(e: EntryProps<KeyValueMap>) =>
			publishedDate && e.sys.publishedAt && e.sys.publishedAt > publishedDate,
	);
	const isOutOfDate =
		(assetsPublishedAfter?.length ?? 0) > 0 ||
		(entriesPublishedAfter?.length ?? 0) > 0;

	debugLog("Stats:", {
		entryCount,
		draftEntryCount,
		updatedEntryCount,
		assetCount,
		draftAssetCount,
		updatedAssetCount,
		errorCount,
	});

	debugLog({ isEntryPublished, isEntryUpdated, assetsPublishedAfter, entriesPublishedAfter });

	return {
		published: isEntryPublished && !isEntryUpdated && !isOutOfDate,
		warnings: allReferences.warnings ?? [],
		errors,
		errorCount,
		entryCount,
		draftEntries,
		updatedEntries,
		draftEntryCount,
		updatedEntryCount,
		assetCount,
		draftAssets,
		draftAssetCount,
		updatedAssets,
		updatedAssetCount,
	};
}

export async function fetchUpstreamRoots(
	sdk: SidebarAppSDK,
	entryId: string,
	rootContentTypes: string[] = [],
	setProgress?: (p: { processed: number; total: number }) => void,
): Promise<IUpstreamRootsResult> {
	const rootContentTypesToUse =
		rootContentTypes.length > 0 ? rootContentTypes : DEFAULT_ROOT_CONTENT_TYPES;

	const rootEntries = new Map<string, EntryProps<KeyValueMap>>();
	const visited = new Set<string>();
	const queued = new Set<string>([entryId]);
	const queue: string[] = [entryId];
	let processed = 0;
	let failedLookups = 0;

	while (queue.length > 0) {
		const id = queue.shift();
		if (!id || visited.has(id)) continue;
		visited.add(id);

		try {
			const response = await sdk.cma.entry.getMany({
				query: { links_to_entry: id },
			});

			for (const entry of response.items) {
				// Archived referrers are ignored ("Used on" and reverse-publish).
				if (isArchived(entry)) continue;
				const ctId = entry.sys.contentType.sys.id;
				if (rootContentTypesToUse.includes(ctId)) {
					rootEntries.set(entry.sys.id, entry);
				} else if (!queued.has(entry.sys.id)) {
					queue.push(entry.sys.id);
					queued.add(entry.sys.id);
				}
			}
		} catch (error) {
			debugError(`Error fetching referrers for ${id}:`, error);
			failedLookups++;
		}

		processed++;
		if (setProgress) {
			setProgress({ processed, total: visited.size + queue.length });
		}
	}

	const roots = Array.from(rootEntries.values());
	const warnings = await findDuplicateSlugWarnings(sdk, roots);
	return { roots, failedLookups, warnings };
}
