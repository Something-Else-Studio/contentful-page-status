import React, { useCallback, useEffect, useState } from "react";
import {
	Button,
	Flex,
	List,
	ListItem,
	Note,
	Paragraph,
	Text,
	Stack,
	Box,
} from "@contentful/f36-components";
import { EntrySys, SidebarAppSDK } from "@contentful/app-sdk";
import { useSDK } from "@contentful/react-apps-toolkit";
import { EntryReferenceError } from "contentful-management/dist/typings/entities/entry";
import {
	AssetProps,
	EntityMetaSysProps,
	EntryProps,
	KeyValueMap,
	isDraft,
	isPublished,
	isUpdated,
} from "contentful-management";

type Status = "Idle" | "Reading" | "Complete" | "Error" | "Publishing";

// Root content types that stop traversal and must be published
const ROOT_CONTENT_TYPES = ["article", "page"];

interface IReferenceInformation {
	published: boolean;
	errors: EntryReferenceError[] | undefined;
	errorCount: number;
	entryCount: number;
	draftEntries: EntryProps<KeyValueMap>[];
	updatedEntries: EntryProps<KeyValueMap>[];
	draftEntryCount: number;
	updatedEntryCount: number;
	assetCount: number;
	draftAssets: AssetProps[];
	updatedAssets: AssetProps[];
	draftAssetCount: number;
	updatedAssetCount: number;
}

interface IProgressStatus {
	processed: number;
	total: number;
	isComplete: boolean;
}

interface IAllReferences {
	entries: EntryProps<KeyValueMap>[];
	assets: AssetProps[];
	errors: EntryReferenceError[];
	processedEntryIds: Set<string>;
}

//const debug = console.log;
const debug = (...args: any[]) => {};

// Helper to get a safe label for the entry
function getEntryLabel(entry: EntryProps<KeyValueMap>): string {
	if (!entry.fields) return "Untitled";

	// Try standard fields first
	const titleField =
		entry.fields["title"] ||
		entry.fields["name"] ||
		entry.fields["label"] ||
		entry.fields["headline"];
	if (titleField) {
		return titleField["en-US"] || Object.values(titleField)[0] || "Untitled";
	}

	// Fallback to the first field
	const firstField = Object.values(entry.fields)[0];
	if (firstField) {
		return firstField["en-US"] || Object.values(firstField)[0] || "Untitled";
	}

	return "Untitled";
}

// Helper to find all links in an entry's fields
function getLinksFromEntry(entry: EntryProps<KeyValueMap>) {
	const links: { type: "Entry" | "Asset"; id: string }[] = [];

	if (!entry.fields) return links;

	Object.values(entry.fields).forEach((fieldValue) => {
		const value = fieldValue["en-US"] || Object.values(fieldValue)[0]; // Fallback if not en-US, though simplified

		if (Array.isArray(value)) {
			value.forEach((item) => {
				if (item?.sys?.type === "Link") {
					links.push({ type: item.sys.linkType, id: item.sys.id });
				}
			});
		} else if (value?.sys?.type === "Link") {
			links.push({ type: value.sys.linkType, id: value.sys.id });
		}
	});

	return links;
}

// Helper to diff arrays and find missing items
function getMissingIds(
	requestedIds: string[],
	foundItems: { sys: { id: string } }[],
) {
	const foundIds = new Set(foundItems.map((item) => item.sys.id));
	return requestedIds.filter((id) => !foundIds.has(id));
}

// Function to iteratively fetch references with improved deduplication
async function fetchReferencesIteratively(
	sdk: SidebarAppSDK,
	entryId: string,
	setProgress?: (progress: { processed: number; total: number }) => void,
): Promise<IAllReferences> {
	// Initialize the collection of all references
	const allReferences: IAllReferences = {
		entries: [],
		assets: [],
		errors: [],
		processedEntryIds: new Set<string>(),
	};

	// Queue of entries to process
	// Start with the initial entry but don't add it to results yet (it's the parent)
	const entriesToProcess: string[] = [entryId];

	// Set to track entries that have been added to the queue
	const entriesQueued = new Set<string>([entryId]);

	// Sets to track unique entry and asset IDs already added to our collections
	const trackedEntryIds = new Set<string>();
	const trackedAssetIds = new Set<string>();

	// Referrer tracking: which entry (id + contentType) referenced each entry/asset ID
	const entryReferrers = new Map<
		string,
		{ referrerEntryId: string; referrerContentType: string }[]
	>();
	const assetReferrers = new Map<
		string,
		{ referrerEntryId: string; referrerContentType: string }[]
	>();

	// Counters for progress
	let processed = 0;
	let total = 1; // Start with 1 for the initial entry

	// Use a batch size (Contentful API allows up to 1000, but 50-100 is usually safe/fast)
	const BATCH_SIZE = 50;

	// Process the queue until it's empty
	while (entriesToProcess.length > 0) {
		// 1. Get the next batch of IDs
		const batchIds = entriesToProcess.splice(0, BATCH_SIZE);

		try {
			// 2. Fetch Entries in Batch
			const response = await sdk.cma.entry.getMany({
				query: {
					"sys.id[in]": batchIds.join(","),
					limit: BATCH_SIZE,
				},
			});

			// Update progress
			processed += batchIds.length;
			if (setProgress) setProgress({ processed, total });

			// 3. Handle missing entries (ids requested but not returned)
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

			// 4. Collect Assets to fetch for this batch
			const assetIdsToFetch = new Set<string>();

			// 5. Process the fetched entries
			for (const entry of response.items) {
				const currentEntryId = entry.sys.id;
				const contentType = entry.sys.contentType.sys.id;
				const label = getEntryLabel(entry);

				// Log entry details
				if (currentEntryId !== entryId) {
					console.log(
						`Processing [${contentType}] ${entry.sys.id} ("${label}") - Draft: ${isDraft(entry)}, Published: ${isPublished(entry)}, Updated: ${isUpdated(entry)}`,
					);

					// Check if it's a Root type
					if (ROOT_CONTENT_TYPES.includes(contentType)) {
						console.log(
							`Stopping search at Root: [${contentType}] ${entry.sys.id} ("${label}")`,
						);

						// It's a root type (like Page/Article) referenced by something else.
						// We check if it is published.
						if (!isPublished(entry)) {
							allReferences.errors.push({
								details: {
									errors: [
										{ message: `Referenced ${contentType} is not published` },
									],
									contentType: contentType, // Pass content type explicitly
								},
								sys: { id: currentEntryId, type: "Entry" },
							} as any);
						}
						// STOP recursion here. Do not look at its children.
						continue;
					}

					// It's a normal dependency
					if (!trackedEntryIds.has(currentEntryId)) {
						allReferences.entries.push(entry);
						trackedEntryIds.add(currentEntryId);
					}

					// Mark as processed for deduplication of fetching
					if (allReferences.processedEntryIds.has(currentEntryId)) {
						continue;
					}
					allReferences.processedEntryIds.add(currentEntryId);
				} else {
					console.log(
						`Processing ROOT ENTRY [${contentType}] ${entry.sys.id} ("${label}")`,
					);
				}

				// Find children (Assets and Entries)
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
							assetIdsToFetch.add(link.id); // Queue asset for batch fetch
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

			// 6. Fetch Assets in Batch
			if (assetIdsToFetch.size > 0) {
				const assetIds = Array.from(assetIdsToFetch);
				// We process assets in chunks if there are many, though usually it's smaller than entry count
				// Reusing BATCH_SIZE for simplicity, or could be larger
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

						// Handle missing assets
						const missingAssets = getMissingIds(
							assetBatch,
							assetsResponse.items,
						);
						missingAssets.forEach((id) => {
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
								details: {
									errors: [{ message: `Missing asset ${id}` }],
									referrers,
								},
								sys: { id: id, type: "Asset" },
							} as any);
						});
					} catch (e) {
						console.error(`Error fetching asset batch`, e);
						// If batch fails, mark all as missing/error
						assetBatch.forEach((id) => {
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
								`Error fetching asset ${id} (referenced from: ${referrerText})`,
							);
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
			// Add generic errors for the whole batch of entries
			batchIds.forEach((id) => {
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
					`Error fetching entry batch (id ${id}) (referenced from: ${referrerText})`,
				);
				allReferences.errors.push({
					details: {
						errors: [{ message: `Error fetching entry batch: ${error}` }],
						referrers,
					},
					sys: { id: id, type: "Entry" },
				} as any);
			});

			// Update progress even on failure
			processed += batchIds.length;
			if (setProgress) {
				setProgress({ processed, total });
			}
		}
	}

	return allReferences;
}

function buildReferenceInformation(
	entrySys: EntrySys,
	allReferences: IAllReferences,
): IReferenceInformation {
	const parent = { sys: entrySys } as any;
	const publishedDate = entrySys.publishedAt;
	const published = isPublished(parent) && !isUpdated(parent);
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
		(a) =>
			publishedDate && a.sys.publishedAt && a.sys.publishedAt > publishedDate,
	);
	const entriesPublishedAfter = entries?.filter(
		(e) =>
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

	debug({ published, assetsPublishedAfter, entriesPublishedAfter });
	return {
		published: published && !isOutOfDate,
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

interface IPublishStatus {
	total: number;
	published: number;
	errors: number;
	errored: EntityMetaSysProps[];
	isScheduled?: boolean;
	scheduledTime?: string;
	scheduledActionIds?: string[]; // Track created scheduled action IDs
}

function getEditorEntry(sys: EntityMetaSysProps) {
	debug("get editor entry", sys);
	try {
		const result = `https://app.contentful.com/spaces/${sys.space.sys.id}/environments/${sys.environment.sys.id}/${
			sys.type === "Asset" ? "assets" : "entries"
		}/${sys.id}`;
		return result;
	} catch (error) {
		console.error("error", error);
		return "/";
	}
}

async function doPublish(
	information: IReferenceInformation,
	sdk: SidebarAppSDK,
	setStatus: (status: IPublishStatus) => void,
	scheduledTime?: string,
) {
	const { draftAssets, updatedAssets, draftEntries, updatedEntries } =
		information;
	const total =
		draftAssets.length +
		updatedAssets.length +
		draftEntries.length +
		updatedEntries.length;

	let published = 0;
	let errors = 0;
	let errored: EntityMetaSysProps[] = [];
	const scheduledActionIds: string[] = [];

	const isScheduled = !!scheduledTime;

	// Update status with initial information
	setStatus({
		total,
		published: 0,
		errors: 0,
		errored: [],
		isScheduled,
		scheduledTime,
		scheduledActionIds,
	});

	// Helper function to schedule publish using scheduledActions
	const schedulePublish = async (
		entityType: "asset" | "entry",
		id: string,
		spaceId: string,
		environmentId: string,
	) => {
		if (!scheduledTime) return false;

		const scheduleDate = new Date(scheduledTime);

		try {
			// Create a scheduled action for publishing with the correct environment structure
			const scheduledAction = await sdk.cma.scheduledActions.create(
				{ spaceId },
				{
					environment: {
						sys: {
							type: "Link",
							linkType: "Environment",
							id: environmentId,
						},
					},
					entity: {
						sys: {
							type: "Link",
							linkType: entityType === "entry" ? "Entry" : "Asset",
							id,
						},
					},
					action: "publish",
					scheduledFor: {
						datetime: scheduleDate.toISOString(),
					},
				},
			);

			// Track the created scheduled action ID
			if (scheduledAction && scheduledAction.sys && scheduledAction.sys.id) {
				scheduledActionIds.push(scheduledAction.sys.id);
			}

			return true;
		} catch (error) {
			console.error(`Error scheduling ${entityType}:`, error);
			throw error;
		}
	};

	// Helper function to publish immediately
	const publishImmediately = async (
		entityType: "asset" | "entry",
		id: string,
		entity: any,
	) => {
		try {
			if (entityType === "asset") {
				await sdk.cma.asset.publish({ assetId: id }, entity);
			} else {
				await sdk.cma.entry.publish({ entryId: id }, entity);
			}
			return true;
		} catch (error) {
			console.error(`Error publishing ${entityType}:`, error);
			throw error;
		}
	};

	// Process assets
	for (const asset of [...draftAssets, ...updatedAssets]) {
		try {
			if (isScheduled) {
				await schedulePublish(
					"asset",
					asset.sys.id,
					asset.sys.space.sys.id,
					asset.sys.environment.sys.id,
				);
			} else {
				await publishImmediately("asset", asset.sys.id, asset);
			}
			published++;
		} catch (error) {
			console.error("Error", error);
			errors++;
			errored.push(asset.sys);
		}
		setStatus({
			total,
			published,
			errors,
			errored,
			isScheduled,
			scheduledTime,
			scheduledActionIds,
		});
	}

	// Process entries
	for (const entry of [...draftEntries, ...updatedEntries]) {
		try {
			if (isScheduled) {
				await schedulePublish(
					"entry",
					entry.sys.id,
					entry.sys.space.sys.id,
					entry.sys.environment.sys.id,
				);
			} else {
				await publishImmediately("entry", entry.sys.id, entry);
			}
			published++;
		} catch (error) {
			console.error("Entry error", error);
			errors++;
			errored.push(entry.sys);
		}
		setStatus({
			total,
			published,
			errors,
			errored,
			isScheduled,

			scheduledTime,
			scheduledActionIds,
		});
	}

	// Publish or schedule the main entry if no errors
	if (errors === 0) {
		try {
			const entrySys = sdk.entry.getSys();

			if (isScheduled && scheduledTime) {
				// Schedule the main entry using scheduledActions
				await schedulePublish(
					"entry",
					entrySys.id,
					entrySys.space.sys.id,
					entrySys.environment.sys.id,
				);
			} else {
				// Immediate publish for the main entry
				await sdk.entry.publish();
			}
		} catch (error) {
			console.error("Error with main entry:", error);
			errors++;
		}
	}

	return errors === 0;
}

const Sidebar = () => {
	const sdk = useSDK<SidebarAppSDK>();
	const [status, setStatus] = useState<Status>("Idle");
	const [error, setError] = useState<string>();
	const [information, setInformation] = useState<IReferenceInformation>();
	const [publishStatus, setPublishStatus] = useState<IPublishStatus>();
	const [progress, setProgress] = useState<IProgressStatus>({
		processed: 0,
		total: 0,
		isComplete: false,
	});
	const [scheduledDate, setScheduledDate] = useState<string>("");
	const [showScheduleOptions, setShowScheduleOptions] =
		useState<boolean>(false);

	const updateProgress = useCallback(
		(progressData: { processed: number; total: number }) => {
			setProgress({
				processed: progressData.processed,
				total: progressData.total,
				isComplete: progressData.processed === progressData.total,
			});
		},
		[],
	);

	const retrieveInformation = useCallback(async () => {
		setStatus("Reading");
		setProgress({ processed: 0, total: 1, isComplete: false });

		try {
			const entrySys = sdk.entry.getSys();

			// Iteratively fetch all references with progress updates
			const allReferences = await fetchReferencesIteratively(
				sdk,
				entrySys.id,
				updateProgress,
			);

			setStatus("Complete");
			const information = buildReferenceInformation(entrySys, allReferences);
			debug("information", information);
			setInformation(information);
		} catch (error) {
			console.error("Error retrieving information:", error);
			setStatus("Error");
			setError(`Error: ${error}`);
		}
	}, [sdk, updateProgress]);

	useEffect(() => {
		retrieveInformation();
	}, [retrieveInformation]);

	// Set default scheduled time to tomorrow at current time
	useEffect(() => {
		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		// Format as YYYY-MM-DDThh:mm
		const formattedDate = tomorrow.toISOString().substring(0, 16);
		setScheduledDate(formattedDate);
	}, []);

	const handlePublish = useCallback(() => {
		if (!information) return;
		setStatus("Publishing");
		doPublish(information, sdk, setPublishStatus)
			.then((status) => {
				debug("Done publishing");
				if (status) {
					retrieveInformation();
				}
			})
			.catch((error) => {
				console.error("Error publishing", error);
			});
	}, [information, retrieveInformation, sdk]);

	const handleScheduledPublish = useCallback(() => {
		if (!information || !scheduledDate) return;
		setStatus("Publishing");
		doPublish(information, sdk, setPublishStatus, scheduledDate)
			.then((status) => {
				debug("Done scheduling publish");
				if (status) {
					retrieveInformation();
				}
			})
			.catch((error) => {
				console.error("Error scheduling publish", error);
			});
	}, [information, retrieveInformation, sdk, scheduledDate]);

	const toggleScheduleOptions = useCallback(() => {
		setShowScheduleOptions((prev) => !prev);
	}, []);

	const handleRefresh = useCallback(() => {
		retrieveInformation();
	}, [retrieveInformation]);

	if (status === "Idle" || status === "Reading") {
		return (
			<Box padding="spacingM">
				<Stack spacing="spacingS">
					<Paragraph>Loading references...</Paragraph>
					{progress.total > 0 && (
						<Stack spacing="spacingS">
							<Text>
								Processing {progress.processed} of {progress.total} entries
							</Text>
							<div
								style={{
									width: "100%",
									height: "8px",
									backgroundColor: "#f0f0f0",
									borderRadius: "4px",
									overflow: "hidden",
								}}
							>
								<div
									style={{
										width: `${
											(progress.processed / Math.max(progress.total, 1)) * 100
										}%`,
										height: "100%",
										backgroundColor: "#0047CC",
										transition: "width 0.3s ease",
									}}
								/>
							</div>
						</Stack>
					)}
				</Stack>
			</Box>
		);
	}

	if (status === "Publishing" && publishStatus) {
		return (
			<Box padding="spacingM">
				<Note variant="primary">
					<Stack spacing="spacingS">
						<Text fontWeight="fontWeightMedium">
							{publishStatus.isScheduled
								? `Scheduled for ${new Date(
										publishStatus.scheduledTime || "",
									).toLocaleString()}`
								: "Publishing"}
						</Text>
						<Text>
							{publishStatus.isScheduled ? "Scheduled" : "Published"}:{" "}
							{publishStatus.published}/{publishStatus.total}
						</Text>
						{publishStatus.errors > 0 && (
							<>
								<Text fontColor="red900">Errors: {publishStatus.errors}</Text>
								<List>
									{publishStatus.errored.map((s) => (
										<ListItem key={s.id}>
											<a
												href={getEditorEntry(s)}
												target="_blank"
												rel="noreferrer"
											>
												{s.type} {s.id}
											</a>
										</ListItem>
									))}
								</List>
							</>
						)}
					</Stack>
				</Note>
			</Box>
		);
	}

	if (error) {
		return (
			<Box padding="spacingM">
				<Note variant="negative">Error processing: {error}</Note>
			</Box>
		);
	}
	if (information) {
		const publishNeedCount =
			information.draftEntryCount +
			information.updatedEntryCount +
			information.draftAssetCount +
			information.updatedAssetCount;

		// Modified Logic: Show the UI block if there are errors OR items to publish
		// Previously, errorCount > 0 forced it to the "All up to date" screen
		const publishNeeded =
			information.errorCount > 0 || // Always show UI if there are blocking errors
			!information.published ||
			(information.errorCount === 0 && publishNeedCount > 0);

		// Group errors by content type
		const errorGroups = information.errors?.reduce(
			(acc, error: any) => {
				const type = error.details?.contentType || "other";
				acc[type] = (acc[type] || 0) + 1;
				return acc;
			},
			{} as Record<string, number>,
		);

		// Construct summary text for compact display
		const summaryText = errorGroups
			? Object.entries(errorGroups)
					.map(([type, count]) => `${count} ${type}${count !== 1 ? "s" : ""}`)
					.join(" and ")
			: "";

		return (
			<Box>
				{publishNeeded ? (
					<Stack
						spacing="spacingM"
						flexDirection="column"
						alignItems="flex-start"
					>
						{showScheduleOptions ? (
							<Stack
								spacing="spacingS"
								flexDirection="column"
								alignItems="flex-start"
								style={{ width: "100%" }}
							>
								<Text fontWeight="fontWeightMedium">Schedule Publication</Text>
								<Flex
									flexDirection="column"
									gap="spacingS"
									style={{ width: "100%" }}
								>
									<input
										type="datetime-local"
										value={scheduledDate}
										onChange={(e) => setScheduledDate(e.target.value)}
										style={{
											padding: "8px",
											borderRadius: "4px",
											border: "1px solid #DCDEE4",
											width: "100%",
										}}
									/>
									<Stack spacing="spacingS">
										<Button
											variant="positive"
											onClick={handleScheduledPublish}
											isDisabled={!scheduledDate}
										>
											Schedule Publish
										</Button>
										<Button variant="secondary" onClick={toggleScheduleOptions}>
											Cancel
										</Button>
									</Stack>
								</Flex>
							</Stack>
						) : (
							<>
								{publishNeedCount > 0 && information.errorCount === 0 && (
									<Text>
										{publishNeedCount} item
										{`${publishNeedCount === 1 ? "" : "s"}`} need
										{`${publishNeedCount === 1 ? "s" : ""}`} publishing
									</Text>
								)}
								{/* Show blocking errors if any, otherwise allow publish */}
								{information.errorCount > 0 && (
									<Note variant="negative">
										Blocking: {summaryText || "Items"} need publishing.
									</Note>
								)}

								{/* Only show publish buttons if NO errors */}
								{information.errorCount === 0 && (
									<Stack spacing="spacingS">
										<Button variant="primary" onClick={handlePublish}>
											Publish Now
										</Button>
										<Button variant="secondary" onClick={toggleScheduleOptions}>
											Schedule...
										</Button>
									</Stack>
								)}

								{/* Show refresh button even if errors exist so user can retry after fixing */}
								<Button
									onClick={handleRefresh}
									variant="secondary"
									size="small"
								>
									Refresh
								</Button>
							</>
						)}
					</Stack>
				) : (
					<Box padding="spacingM">
						<Stack
							spacing="spacingS"
							flexDirection="column"
							alignItems="flex-start"
						>
							<Note variant="positive">
								All {information.entryCount + information.assetCount} items up
								to date
							</Note>
							<Button onClick={handleRefresh} variant="secondary" size="small">
								Refresh
							</Button>
						</Stack>
					</Box>
				)}
			</Box>
		);
	}
	return (
		<Box padding="spacingM">
			<Stack spacing="spacingS" flexDirection="column" alignItems="flex-start">
				<Note variant="warning">Hmm - something didn't work</Note>
				<Button onClick={handleRefresh} variant="secondary">
					Refresh
				</Button>
			</Stack>
		</Box>
	);
};

export default Sidebar;
