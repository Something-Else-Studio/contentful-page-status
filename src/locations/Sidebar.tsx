import { useCallback, useEffect, useState } from "react";
import {
	Badge,
	Button,
	Checkbox,
	Flex,
	IconButton,
	List,
	ListItem,
	Note,
	Text,
	Stack,
	Box,
} from "@contentful/f36-components";
import { ArrowClockwiseIcon } from '@contentful/f36-icons';
import type { SidebarAppSDK } from "@contentful/app-sdk";
import { useSDK } from "@contentful/react-apps-toolkit";
import type { EntityMetaSysProps } from "contentful-management";
import type {
	IProgressStatus,
	IPublishStatus,
	IUpstreamRoot,
} from "../lib/types";
import {
	ROOT_CONTENT_TYPES as DEFAULT_ROOT_CONTENT_TYPES,
	getEntryLabel,
	getEntrySlug,
	getEditorEntry,
} from "../lib/utils";
import type { AppInstallationParameters } from "../lib/types";
import {
	fetchReferencesIteratively,
	buildReferenceInformation,
	fetchUpstreamRoots,
	clearReferenceCache,
} from "../lib/references";
import { doPublish, doReversePublish } from "../lib/publish";
import { logError } from "../lib/debug";

type Status = "Idle" | "Reading" | "Complete" | "Error" | "Publishing";

const UPSTREAM_ROOT_LIMIT = 50;

function formatRootsLabelFromCounts(
	countsByType: Record<string, number>,
): string {
	return (
		Object.entries(countsByType)
			.map(([ct, n]) => `${n} ${ct}${n !== 1 ? "s" : ""}`)
			.join(", ") || "root entries"
	);
}

function formatRootsLabel(roots: IUpstreamRoot[]): string {
	const rootsByType = roots.reduce(
		(acc, r) => {
			const ct = r.entry.sys.contentType.sys.id;
			acc[ct] = (acc[ct] ?? 0) + 1;
			return acc;
		},
		{} as Record<string, number>,
	);
	return formatRootsLabelFromCounts(rootsByType);
}

const Sidebar = () => {
	const sdk = useSDK<SidebarAppSDK>();
	const [status, setStatus] = useState<Status>("Idle");
	const [error, setError] = useState<string>();
	const [information, setInformation] = useState<
		ReturnType<typeof buildReferenceInformation>
	>();
	const [publishStatus, setPublishStatus] = useState<IPublishStatus>();
	const [progress, setProgress] = useState<IProgressStatus>({
		processed: 0,
		total: 0,
		isComplete: false,
	});
	const [loadingPhase, setLoadingPhase] = useState("Scanning dependencies...");
	const [loadingDetail, setLoadingDetail] = useState<string>();
	const [scheduledDate, setScheduledDate] = useState<string>("");
	const [showScheduleOptions, setShowScheduleOptions] = useState(false);
	const [upstreamRoots, setUpstreamRoots] = useState<IUpstreamRoot[]>([]);
	const [upstreamRootsByType, setUpstreamRootsByType] = useState<
		Record<string, number>
	>({});
	const [upstreamFailedLookups, setUpstreamFailedLookups] = useState(0);
	const [upstreamTruncated, setUpstreamTruncated] = useState(0);
	const [selectedRootIds, setSelectedRootIds] = useState<Set<string>>(
		new Set(),
	);
	const [publishJustCompleted, setPublishJustCompleted] = useState(false);

	const entryId = sdk.entry.getSys().id;

	// sdk is stable for the entire sidebar lifecycle; this value never changes.
	// Read custom root content types from installation parameters (set via the ConfigScreen).
	// Falls back to the built-in default list if not configured or empty.
	const configuredRootContentTypes =
		(sdk.parameters?.installation as AppInstallationParameters | undefined)
			?.rootContentTypes ?? [];
	const effectiveRootContentTypes =
		configuredRootContentTypes.length > 0
			? configuredRootContentTypes
			: DEFAULT_ROOT_CONTENT_TYPES;

	const isRootEntry = effectiveRootContentTypes.includes(
		sdk.entry.getSys().contentType.sys.id,
	);

	const resetScanState = useCallback(() => {
		setInformation(undefined);
		setUpstreamRoots([]);
		setUpstreamRootsByType({});
		setUpstreamFailedLookups(0);
		setUpstreamTruncated(0);
		setSelectedRootIds(new Set());
		setError(undefined);
		setProgress({ processed: 0, total: 0, isComplete: false });
		setPublishStatus(undefined);
		setShowScheduleOptions(false);
	}, []);

	const finishPublishSuccess = useCallback(() => {
		// Bust the references cache (for this sidebar entry) so that the post-publish
		// "Refresh to check status" (or any subsequent manual Refresh) gets fresh data.
		// This prevents the scenario where a quick Refresh hits the 60s TTL, still sees
		// "needs publishing", and a second Publish attempt gets VersionMismatch (409)
		// because the entity objects carried stale sys.version values.
		clearReferenceCache(entryId);
		resetScanState();
		setPublishJustCompleted(true);
		setStatus("Idle");
	}, [resetScanState, entryId]);

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
		setError(undefined);
		setPublishJustCompleted(false);
		setProgress({ processed: 0, total: 1, isComplete: false });
		setLoadingDetail(undefined);
		setUpstreamRoots([]);
		setUpstreamRootsByType({});
		setUpstreamFailedLookups(0);
		setUpstreamTruncated(0);

		try {
			const entrySys = sdk.entry.getSys();

			// Ensure a manual Refresh (including the "Refresh to check status" the user is
			// told to do after publish) always gets a fresh dependency scan. Combined with
			// the clear inside finishPublishSuccess this defeats the 60s refInfoCache that
			// was causing post-publish scans to report stale "N items need publishing" and
			// subsequent Publish attempts to hit VersionMismatch with old entity versions.
			clearReferenceCache(entrySys.id);

			setLoadingPhase("Scanning dependencies...");
			setLoadingDetail("Checking this entry and its references…");
			const allReferences = await fetchReferencesIteratively(
				sdk,
				entrySys.id,
				effectiveRootContentTypes,
				updateProgress,
			);

			const info = buildReferenceInformation(entrySys, allReferences);
			setInformation(info);

			if (!isRootEntry) {
				setLoadingPhase("Finding pages that use this…");
				setLoadingDetail(
					"Tracing referrers — widely used components can take a minute.",
				);
				setProgress({ processed: 0, total: 1, isComplete: false });

				const { roots: allRoots, failedLookups } = await fetchUpstreamRoots(
					sdk,
					entrySys.id,
					effectiveRootContentTypes,
					updateProgress,
				);

				setUpstreamFailedLookups(failedLookups);
				const rootsByType = allRoots.reduce(
					(acc, root) => {
						const ct = root.sys.contentType.sys.id;
						acc[ct] = (acc[ct] ?? 0) + 1;
						return acc;
					},
					{} as Record<string, number>,
				);
				setUpstreamRootsByType(rootsByType);
				const truncated = Math.max(0, allRoots.length - UPSTREAM_ROOT_LIMIT);
				setUpstreamTruncated(truncated);

				const rootsToShow = allRoots.slice(0, UPSTREAM_ROOT_LIMIT);
				// Simplified: no per-root deep dependency scans / "safe" analysis.
				// We do a lightweight upward discovery only, then shallow-republish
				// selected roots after the component itself is published. This avoids
				// side-publishing unrelated drafts on those pages and removes the
				// expensive/brittle N x full-tree scans.
				const rootInfos: IUpstreamRoot[] = rootsToShow.map((entry) => ({
					entry,
					safe: true,
				}));

				if (rootsToShow.length > 0) {
					setLoadingDetail(
						`Found ${formatRootsLabelFromCounts(rootsByType)}. Will republish selected pages after the component.`,
					);
				} else {
					setLoadingDetail("No pages or articles reference this entry.");
				}

				setUpstreamRoots(rootInfos);
			}

			setStatus("Complete");
		} catch (err) {
			logError("Error retrieving information:", err);
			setStatus("Error");
			setError(`Error: ${err}`);
		}
	}, [sdk, updateProgress, isRootEntry]);

	// no cleanup needed — SDK manages the resize listener
	useEffect(() => {
		sdk.window.startAutoResizer();
	}, [sdk]);

	useEffect(() => {
		resetScanState();
		setStatus("Idle");
		setPublishJustCompleted(false);
	}, [entryId, resetScanState]);

	useEffect(() => {
		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		setScheduledDate(tomorrow.toISOString().substring(0, 16));
	}, []);

	useEffect(() => {
		const safeIds = upstreamRoots
			.filter((r) => r.safe)
			.map((r) => r.entry.sys.id);
		setSelectedRootIds(new Set(safeIds));
	}, [upstreamRoots]);

	const handlePublish = useCallback(() => {
		if (!information) return;
		setStatus("Publishing");

		const selectedSafeRoots = upstreamRoots.filter(
			(r) => r.safe && selectedRootIds.has(r.entry.sys.id),
		);
		const skipComponentPublish =
			information.draftEntryCount +
				information.updatedEntryCount +
				information.draftAssetCount +
				information.updatedAssetCount ===
				0 &&
			information.errorCount === 0 &&
			information.published;

		const publish =
			!isRootEntry && selectedSafeRoots.length > 0
				? doReversePublish(
						information,
						selectedSafeRoots,
						sdk,
						setPublishStatus,
						undefined,
						{ skipComponentPublish },
					)
				: doPublish(information, sdk, setPublishStatus);
		publish
			.then((ok) => {
				// Always finish (reset + clear cache + Idle note) so we never get stuck
				// in the Publishing UI (even when per-item publish failed with e.g. VersionMismatch).
				// The Publishing note (with errored list + recovery Refresh button) will have
				// already informed the user; on settle we return to Idle so they can Refresh
				// immediately with fresh data.
				finishPublishSuccess();
			})
			.catch((err) => {
				logError("Error publishing", err);
				finishPublishSuccess();
			});
	}, [
		information,
		finishPublishSuccess,
		sdk,
		isRootEntry,
		upstreamRoots,
		selectedRootIds,
	]);

	const handleScheduledPublish = useCallback(() => {
		if (!information || !scheduledDate) return;
		setStatus("Publishing");

		const selectedSafeRoots = upstreamRoots.filter(
			(r) => r.safe && selectedRootIds.has(r.entry.sys.id),
		);
		const skipComponentPublish =
			information.draftEntryCount +
				information.updatedEntryCount +
				information.draftAssetCount +
				information.updatedAssetCount ===
				0 &&
			information.errorCount === 0 &&
			information.published;

		const publish =
			!isRootEntry && selectedSafeRoots.length > 0
				? doReversePublish(
						information,
						selectedSafeRoots,
						sdk,
						setPublishStatus,
						scheduledDate,
						{ skipComponentPublish },
					)
				: doPublish(information, sdk, setPublishStatus, scheduledDate);
		publish
			.then((ok) => {
				// Always finish (reset + clear cache + Idle note) so we never get stuck
				// in the Publishing UI (even when per-item publish failed with e.g. VersionMismatch).
				// The Publishing note (with errored list + recovery Refresh button) will have
				// already informed the user; on settle we return to Idle so they can Refresh
				// immediately with fresh data.
				finishPublishSuccess();
			})
			.catch((err) => {
				logError("Error scheduling publish", err);
				finishPublishSuccess();
			});
	}, [
		information,
		finishPublishSuccess,
		sdk,
		scheduledDate,
		isRootEntry,
		upstreamRoots,
		selectedRootIds,
	]);

	const toggleScheduleOptions = useCallback(() => {
		setShowScheduleOptions((prev) => !prev);
	}, []);

	const handleRefresh = useCallback(() => {
		retrieveInformation();
	}, [retrieveInformation]);

	// ── Idle ─────────────────────────────────────────────────────────────────
	if (status === "Idle") {
		return (
			<Box padding="spacingM">
				<Stack spacing="spacingS" flexDirection="column" alignItems="flex-start">
					{publishJustCompleted && (
						<Note variant="positive">
							Publish complete. Refresh to check status.
						</Note>
					)}
					<Text fontWeight="fontWeightMedium">Dependency scan not run</Text>
					<Text fontSize="fontSizeS" fontColor="gray600">
						{isRootEntry
							? "Scan this entry and its references to see publish status."
							: "Scan this entry and its references to see publish status. For components, finding upstream pages may take a minute."}
					</Text>
					<Button variant="primary" onClick={handleRefresh}>
						Refresh
					</Button>
				</Stack>
			</Box>
		);
	}

	// ── Loading ──────────────────────────────────────────────────────────────
	if (status === "Reading") {
		const progressLabel =
			progress.total > 1
				? `${progress.processed} of ${progress.total}`
				: progress.total === 1 && progress.processed > 0
					? `${progress.processed} processed`
					: null;

		return (
			<Box padding="spacingM">
				<Stack spacing="spacingS" flexDirection="column" alignItems="flex-start">
					<Text fontWeight="fontWeightMedium">{loadingPhase}</Text>
					{loadingDetail && (
						<Text fontSize="fontSizeS" fontColor="gray600">
							{loadingDetail}
						</Text>
					)}
					{progress.total > 0 && (
						<Stack spacing="spacingS" style={{ width: "100%" }}>
							{progressLabel && (
								<Text fontSize="fontSizeS">{progressLabel}</Text>
							)}
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
											progress.total > 0
												? Math.max(
														(progress.processed / progress.total) * 100,
														progress.processed === 0 ? 8 : 0,
													)
												: 0
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

	// ── Publishing ───────────────────────────────────────────────────────────
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
									{publishStatus.errored.map((s: EntityMetaSysProps) => (
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
								{/* Recovery button so the user is never stuck in the Publishing
								    note (as happened with VersionMismatch). finish* paths now
								    also guarantee we leave "Publishing" state. */}
								<Button onClick={handleRefresh} variant="secondary">
									Refresh
								</Button>
							</>
						)}
					</Stack>
				</Note>
			</Box>
		);
	}

	// ── Error ────────────────────────────────────────────────────────────────
	if (error) {
		return (
			<Box padding="spacingM">
				<Stack spacing="spacingS" flexDirection="column" alignItems="flex-start">
					<Note variant="negative">Error processing: {error}</Note>
					<Button onClick={handleRefresh} variant="secondary">
						Refresh
					</Button>
				</Stack>
			</Box>
		);
	}

	// ── Complete ─────────────────────────────────────────────────────────────
	if (information) {
		const publishNeedCount =
			information.draftEntryCount +
			information.updatedEntryCount +
			information.draftAssetCount +
			information.updatedAssetCount;

		const selectedSafeRoots = upstreamRoots.filter(
			(r) => r.safe && selectedRootIds.has(r.entry.sys.id),
		);
		const safeRootIds = upstreamRoots
			.filter((r) => r.safe)
			.map((r) => r.entry.sys.id);
		const allSafeSelected =
			safeRootIds.length > 0 &&
			safeRootIds.every((id) => selectedRootIds.has(id));
		const someSafeSelected = safeRootIds.some((id) =>
			selectedRootIds.has(id),
		);

		const componentPublishNeeded =
			information.errorCount > 0 ||
			!information.published ||
			(information.errorCount === 0 && publishNeedCount > 0);

		const publishNeeded =
			componentPublishNeeded ||
			(!isRootEntry && selectedSafeRoots.length > 0);

		const rootsLabel = formatRootsLabelFromCounts(upstreamRootsByType);
		const selectedRootsLabel = formatRootsLabel(selectedSafeRoots);
		const selectionOnlyPublish =
			!isRootEntry &&
			selectedSafeRoots.length > 0 &&
			!componentPublishNeeded;
		const publishButtonLabel =
			!isRootEntry && selectedSafeRoots.length > 0
				? selectionOnlyPublish
					? `Publish ${selectedRootsLabel}`
					: `Publish + ${selectedRootsLabel}`
				: "Publish Now";

		const handleSelectAll = () => {
			if (allSafeSelected) {
				setSelectedRootIds(new Set());
			} else {
				setSelectedRootIds(new Set(safeRootIds));
			}
		};

		const handleToggleRoot = (id: string, safe: boolean) => {
			if (!safe) return;
			setSelectedRootIds((prev) => {
				const next = new Set(prev);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				return next;
			});
		};

		const errorGroups = information.errors?.reduce(
			(acc, err) => {
				const type =
					(err.details as Record<string, unknown>)?.contentType || "other";
				acc[String(type)] = (acc[String(type)] || 0) + 1;
				return acc;
			},
			{} as Record<string, number>,
		);
		const summaryText = errorGroups
			? Object.entries(errorGroups)
					.map(([type, count]) => `${count} ${type}${count !== 1 ? "s" : ""}`)
					.join(" and ")
			: "";

		return (
			<Box>
				{publishNeeded ? (
					<Box padding={selectionOnlyPublish ? "spacingM" : undefined}>
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
								{selectionOnlyPublish && (
									<Note variant="positive">This entry is up to date</Note>
								)}
								{information.errorCount > 0 && (
									<Note variant="negative">
										Blocking: {summaryText || "Items"} need publishing.
									</Note>
								)}
								{information.errorCount === 0 && (
									<Flex alignItems="flex-start" gap="spacingS" style={{ width: "100%" }}>
										<Stack spacing="spacingS" style={{ flexGrow: 1 }}>
											<Button variant="primary" onClick={handlePublish}>
												{publishButtonLabel}
											</Button>
											<Button variant="secondary" onClick={toggleScheduleOptions}>
												Schedule...
											</Button>
										</Stack>
										<IconButton
											variant="secondary"
											icon={<ArrowClockwiseIcon />}
											aria-label="Refresh"
											onClick={handleRefresh}
										/>
									</Flex>
								)}
								{publishNeedCount > 0 && information.errorCount === 0 && (
									<Box style={{ width: "100%", fontSize: "0.8em", marginTop: "4px" }}>
										<Text fontSize="fontSizeS" style={{ width: "100%", display: "block", whiteSpace: "nowrap" }}>
											{publishNeedCount} item{publishNeedCount === 1 ? "" : "s"} need{publishNeedCount === 1 ? "s" : ""} publishing:
										</Text>
										<Stack spacing="spacingXs" style={{ width: "100%", marginTop: "2px" }}>
											{information.draftEntries.map((entry) => (
												<Flex key={entry.sys.id} justifyContent="space-between" alignItems="center" style={{ width: "100%" }}>
													<a
														href={getEditorEntry(entry.sys)}
														target="_blank"
														rel="noreferrer"
														style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
													>
														{getEntryLabel(entry)}
													</a>
													<Badge variant="warning">draft</Badge>
												</Flex>
											))}
											{information.updatedEntries.map((entry) => (
												<Flex key={entry.sys.id} justifyContent="space-between" alignItems="center" style={{ width: "100%" }}>
													<a
														href={getEditorEntry(entry.sys)}
														target="_blank"
														rel="noreferrer"
														style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
													>
														{getEntryLabel(entry)}
													</a>
													<Badge variant="primary">changed</Badge>
												</Flex>
											))}
											{information.draftAssets.map((asset) => (
												<Flex key={asset.sys.id} justifyContent="space-between" alignItems="center" style={{ width: "100%" }}>
													<a
														href={getEditorEntry(asset.sys)}
														target="_blank"
														rel="noreferrer"
														style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
													>
														{getEntryLabel(asset as any)}
													</a>
													<Badge variant="warning">draft</Badge>
												</Flex>
											))}
											{information.updatedAssets.map((asset) => (
												<Flex key={asset.sys.id} justifyContent="space-between" alignItems="center" style={{ width: "100%" }}>
													<a
														href={getEditorEntry(asset.sys)}
														target="_blank"
														rel="noreferrer"
														style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
													>
														{getEntryLabel(asset as any)}
													</a>
													<Badge variant="primary">changed</Badge>
												</Flex>
											))}
										</Stack>
									</Box>
								)}
							</>
						)}
					</Stack>
					</Box>
				) : (
					<Box padding="spacingM">
						<Stack
							spacing="spacingS"
							flexDirection="column"
							alignItems="flex-start"
						>
							<Note variant="positive">This entry is up to date</Note>
							<Button onClick={handleRefresh} variant="secondary" size="small">
								Refresh
							</Button>
						</Stack>
					</Box>
				)}

				{!isRootEntry && upstreamRoots.length > 0 && (
					<Box
						padding="spacingS"
						style={{ borderTop: "1px solid #DCDEE4", marginTop: "8px" }}
					>
						<Stack
							spacing="spacingS"
							flexDirection="column"
							alignItems="flex-start"
							style={{ width: "100%" }}
						>
							<Flex alignItems="center" gap="spacingXs">
								<Checkbox
									id="select-all-upstream-roots"
									isChecked={allSafeSelected}
									isIndeterminate={someSafeSelected && !allSafeSelected}
									isDisabled={safeRootIds.length === 0}
									onChange={handleSelectAll}
								/>
								<Text
									as="label"
									htmlFor="select-all-upstream-roots"
									fontWeight="fontWeightMedium"
									fontSize="fontSizeS"
								>
									Used on {rootsLabel}
								</Text>
							</Flex>
							<Stack
								spacing="spacingXs"
								flexDirection="column"
								alignItems="stretch"
								style={{ width: "100%" }}
							>
								{upstreamRoots.map((root) => {
									const rootId = root.entry.sys.id;
									return (
										<Flex
											key={rootId}
											justifyContent="space-between"
											alignItems="center"
											gap="spacingXs"
											style={{ width: "100%" }}
										>
											<Flex alignItems="center" gap="spacingXs" style={{ minWidth: 0 }}>
												<Checkbox
													id={`upstream-root-${rootId}`}
													isChecked={selectedRootIds.has(rootId)}
													isDisabled={!root.safe}
													onChange={() =>
														handleToggleRoot(rootId, root.safe)
													}
												/>
												<a
													href={getEditorEntry(root.entry.sys)}
													target="_blank"
													rel="noreferrer"
													style={{
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
													}}
												>
													{getEntrySlug(root.entry)}
												</a>
											</Flex>
											{/* Simplified reverse: no per-page deep "safe/blocked" analysis.
											    All discovered roots are selectable for shallow republish. */}
										</Flex>
									);
								})}
							</Stack>
							{upstreamTruncated > 0 && (
								<Text fontSize="fontSizeS" fontColor="gray600">
									+ {upstreamTruncated} more (not shown in list)
								</Text>
							)}
							{upstreamFailedLookups > 0 && (
								<Note variant="warning">
									{upstreamFailedLookups} upstream{" "}
									{upstreamFailedLookups === 1 ? "lookup" : "lookups"} failed —
									some pages using this component may not be shown.
								</Note>
							)}
							{/* Note about unresolved deps removed — with simplified reverse we do
							    lightweight discovery + shallow root republish only (no deep tree
							    "safe" checks on the pages). Other draft changes on a page stay draft. */}
						</Stack>
					</Box>
				)}
			</Box>
		);
	}

	// ── Fallback ─────────────────────────────────────────────────────────────
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
