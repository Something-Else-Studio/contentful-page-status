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
	IEntrySysLike,
	IReferenceInformation,
	IUpstreamRootsResult,
} from "./types";
import { ROOT_CONTENT_TYPES, getLinksFromEntry, getMissingIds } from "./utils";

const debug = (..._args: unknown[]) => {};

const REF_CACHE_TTL_MS = 60_000;
const refInfoCache = new Map<string, { ts: number; refs: IAllReferences }>();

const BATCH_SIZE = 50;

export async function fetchReferencesIteratively(
	sdk: SidebarAppSDK,
	entryId: string,
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
		processedEntryIds: new Set<string>(),
	};

	const entriesToProcess: string[] = [entryId];
	const entriesQueued = new Set<string>([entryId]);
	const trackedEntryIds = new Set<string>();
	const trackedAssetIds = new Set<string>();

	const entryReferrers = new Map<
		string,
		{ referrerEntryId: string; referrerContentType: string }[]
	>();
	const assetReferrers = new Map<
		string,
		{ referrerEntryId: string; referrerContentType: string }[]
	>();

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
				console.error(
					`Entry not found: ${id} (referenced from: ${referrerText})`,
				);
				allReferences.errors.push({
					details: {
						errors: [{ message: `Entry not found or inaccessible` }],
						referrers,
					},
					sys: { id: id, type: "Entry" },
				} as any);
			});

			const assetIdsToFetch = new Set<string>();

			for (const entry of response.items) {
				const currentEntryId = entry.sys.id;
				const contentType = entry.sys.contentType.sys.id;

				if (currentEntryId !== entryId) {
					console.log(
						`Processing [${contentType}] ${entry.sys.id} ("${entry.sys.id}") - Draft: ${isDraft(entry)}, Published: ${isPublished(entry)}, Updated: ${isUpdated(entry)}`,
					);

					if (ROOT_CONTENT_TYPES.includes(contentType)) {
						console.log(
							`Stopping search at Root: [${contentType}] ${entry.sys.id}`,
						);
						if (!isPublished(entry)) {
							allReferences.errors.push({
								details: {
									errors: [
										{ message: `Referenced ${contentType} is not published` },
									],
									contentType: contentType,
								},
								sys: { id: currentEntryId, type: "Entry" },
							} as any);
						}
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
					console.log(
						`Processing ROOT ENTRY [${contentType}] ${entry.sys.id}`,
					);
				}

				const links = getLinksFromEntry(entry);
				const referrer = {
					referrerEntryId: currentEntryId,
					referrerContentType: contentType,
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
						allReferences.assets.push(...assetsResponse.items);

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
							console.error(
								`Missing asset ${id} (referenced from: ${referrerText})`,
							);
							allReferences.errors.push({
								details: { errors: [{ message: `Missing asset ${id}` }], referrers },
								sys: { id: id, type: "Asset" },
							} as any);
						});
					} catch (e) {
						console.error(`Error fetching asset batch`, e);
						assetBatch.forEach((id) => {
							const referrers = assetReferrers.get(id) ?? [];
							allReferences.errors.push({
								details: {
									errors: [{ message: `Error fetching asset ${id}` }],
									referrers,
								},
								sys: { id: id, type: "Asset" },
							} as any);
						});
					}
				}
			}
		} catch (error) {
			console.error("Batch fetch error", error);
			batchIds.forEach((id) => {
				const referrers = entryReferrers.get(id) ?? [];
				allReferences.errors.push({
					details: {
						errors: [{ message: `Error fetching entry batch: ${error}` }],
						referrers,
					},
					sys: { id: id, type: "Entry" },
				} as any);
			});
			processed += batchIds.length;
			if (setProgress) setProgress({ processed, total });
		}
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

	const entries = allReferences.entries;
	const entryCount = entries?.length ?? 0;
	const draftEntries = entries?.filter(isDraft) ?? [];
	const updatedEntries = entries?.filter(isUpdated) ?? [];
	const draftEntryCount = draftEntries.length;
	const updatedEntryCount = updatedEntries.length;

	const assets = allReferences.assets;
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

	console.log("Stats:", {
		entryCount,
		draftEntryCount,
		updatedEntryCount,
		assetCount,
		draftAssetCount,
		updatedAssetCount,
		errorCount,
	});

	debug({ isEntryPublished, isEntryUpdated, assetsPublishedAfter, entriesPublishedAfter });

	return {
		published: isEntryPublished && !isEntryUpdated && !isOutOfDate,
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
	setProgress?: (p: { processed: number; total: number }) => void,
): Promise<IUpstreamRootsResult> {
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
				const ctId = entry.sys.contentType.sys.id;
				if (ROOT_CONTENT_TYPES.includes(ctId)) {
					rootEntries.set(entry.sys.id, entry);
				} else if (!queued.has(entry.sys.id)) {
					queue.push(entry.sys.id);
					queued.add(entry.sys.id);
				}
			}
		} catch (error) {
			console.error(`Error fetching referrers for ${id}:`, error);
			failedLookups++;
		}

		processed++;
		if (setProgress) {
			setProgress({ processed, total: visited.size + queue.length });
		}
	}

	return { roots: Array.from(rootEntries.values()), failedLookups };
}
