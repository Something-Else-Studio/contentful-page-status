import { useCallback, useEffect, useState } from "react";
import {
	Badge,
	Button,
	Checkbox,
	Flex,
	List,
	ListItem,
	Note,
	Text,
	Stack,
	Box,
} from "@contentful/f36-components";
import type { SidebarAppSDK } from "@contentful/app-sdk";
import { useSDK } from "@contentful/react-apps-toolkit";
import type { EntityMetaSysProps } from "contentful-management";
import type {
	IProgressStatus,
	IPublishStatus,
	IUpstreamRoot,
} from "../lib/types";
import {
	ROOT_CONTENT_TYPES,
	getEntrySlug,
	getEditorEntry,
} from "../lib/utils";
import {
	fetchReferencesIteratively,
	buildReferenceInformation,
	fetchUpstreamRoots,
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

	// sdk is stable for the entire sidebar lifecycle; this value never changes
	const isRootEntry = ROOT_CONTENT_TYPES.includes(sdk.entry.getSys().contentType.sys.id);

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
		setLoadingDetail(undefined);
		setUpstreamRoots([]);
		setUpstreamRootsByType({});
		setUpstreamFailedLookups(0);
		setUpstreamTruncated(0);

		try {
			const entrySys = sdk.entry.getSys();

			setLoadingPhase("Scanning dependencies...");
			setLoadingDetail("Checking this entry and its references…");
			const allReferences = await fetchReferencesIteratively(
				sdk,
				entrySys.id,
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

				const rootsToAnalyze = allRoots.slice(0, UPSTREAM_ROOT_LIMIT);
				const rootInfos: IUpstreamRoot[] = [];

				if (rootsToAnalyze.length > 0) {
					setLoadingDetail(
						`Found ${formatRootsLabelFromCounts(rootsByType)}. Checking each page's dependencies…`,
					);
					setProgress({
						processed: 0,
						total: rootsToAnalyze.length,
						isComplete: false,
					});

					for (let i = 0; i < rootsToAnalyze.length; i++) {
						const root = rootsToAnalyze[i];
						setLoadingPhase(
							`Analysing pages (${i + 1} of ${rootsToAnalyze.length})…`,
						);
						const refs = await fetchReferencesIteratively(sdk, root.sys.id);
						const rootInfo = buildReferenceInformation(root.sys, refs);
						rootInfos.push({
							entry: root,
							information: rootInfo,
							safe: rootInfo.errorCount === 0,
						});
						setProgress({
							processed: i + 1,
							total: rootsToAnalyze.length,
							isComplete: i + 1 === rootsToAnalyze.length,
						});
					}
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
		retrieveInformation();
	}, [retrieveInformation]);

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
				if (ok) retrieveInformation();
			})
			.catch((err) => logError("Error publishing", err));
	}, [
		information,
		retrieveInformation,
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
				if (ok) retrieveInformation();
			})
			.catch((err) => logError("Error scheduling publish", err));
	}, [
		information,
		retrieveInformation,
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

	// ── Loading ──────────────────────────────────────────────────────────────
	if (status === "Idle" || status === "Reading") {
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
				<Note variant="negative">Error processing: {error}</Note>
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
								{publishNeedCount > 0 && information.errorCount === 0 && (
									<Text>
										{publishNeedCount} item
										{publishNeedCount === 1 ? "" : "s"} need
										{publishNeedCount === 1 ? "s" : ""} publishing
									</Text>
								)}
								{information.errorCount > 0 && (
									<Note variant="negative">
										Blocking: {summaryText || "Items"} need publishing.
									</Note>
								)}
								{information.errorCount === 0 && (
									<Stack spacing="spacingS">
										<Button variant="primary" onClick={handlePublish}>
											{publishButtonLabel}
										</Button>
										<Button variant="secondary" onClick={toggleScheduleOptions}>
											Schedule...
										</Button>
									</Stack>
								)}
								<Button onClick={handleRefresh} variant="secondary" size="small">
									Refresh
								</Button>
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
											<Badge
												variant={root.safe ? "positive" : "warning"}
												style={{ flexShrink: 0 }}
											>
												{root.safe ? "safe" : "blocked"}
											</Badge>
										</Flex>
									);
								})}
							</Stack>
							{upstreamTruncated > 0 && (
								<Text fontSize="fontSizeS" fontColor="gray600">
									+ {upstreamTruncated} more not fully analysed
								</Text>
							)}
							{upstreamFailedLookups > 0 && (
								<Note variant="warning">
									{upstreamFailedLookups} upstream{" "}
									{upstreamFailedLookups === 1 ? "lookup" : "lookups"} failed —
									some pages using this component may not be shown.
								</Note>
							)}
							{upstreamRoots.some((r) => !r.safe) && (
								<Note variant="warning">
									Some root entries have unresolved dependencies and will not be
									auto-published.
								</Note>
							)}
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
