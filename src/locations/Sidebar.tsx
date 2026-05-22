import { useCallback, useEffect, useState } from "react";
import {
	Badge,
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
	getEntryLabel,
	getEditorEntry,
} from "../lib/utils";
import {
	fetchReferencesIteratively,
	buildReferenceInformation,
	fetchUpstreamRoots,
} from "../lib/references";
import { doPublish, doReversePublish } from "../lib/publish";

type Status = "Idle" | "Reading" | "Complete" | "Error" | "Publishing";

const UPSTREAM_ROOT_LIMIT = 10;

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
	const [scheduledDate, setScheduledDate] = useState<string>("");
	const [showScheduleOptions, setShowScheduleOptions] = useState(false);
	const [upstreamRoots, setUpstreamRoots] = useState<IUpstreamRoot[]>([]);
	const [upstreamFailedLookups, setUpstreamFailedLookups] = useState(0);
	const [upstreamTruncated, setUpstreamTruncated] = useState(0);

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
		setUpstreamRoots([]);
		setUpstreamFailedLookups(0);
		setUpstreamTruncated(0);

		try {
			const entrySys = sdk.entry.getSys();

			setLoadingPhase("Scanning dependencies...");
			const allReferences = await fetchReferencesIteratively(
				sdk,
				entrySys.id,
				updateProgress,
			);

			const info = buildReferenceInformation(entrySys, allReferences);
			setInformation(info);

			if (!isRootEntry) {
				setLoadingPhase("Finding pages that use this...");
				setProgress({ processed: 0, total: 1, isComplete: false });

				const { roots: allRoots, failedLookups } = await fetchUpstreamRoots(
					sdk,
					entrySys.id,
					updateProgress,
				);

				setUpstreamFailedLookups(failedLookups);
				const truncated = Math.max(0, allRoots.length - UPSTREAM_ROOT_LIMIT);
				setUpstreamTruncated(truncated);

				setLoadingPhase("Analysing pages...");
				const rootInfos = await Promise.all(
					allRoots.slice(0, UPSTREAM_ROOT_LIMIT).map(async (root) => {
						const refs = await fetchReferencesIteratively(sdk, root.sys.id);
						const rootInfo = buildReferenceInformation(root.sys, refs);
						return {
							entry: root,
							information: rootInfo,
							safe: rootInfo.errorCount === 0,
						};
					}),
				);
				setUpstreamRoots(rootInfos);
			}

			setStatus("Complete");
		} catch (err) {
			console.error("Error retrieving information:", err);
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

	const handlePublish = useCallback(() => {
		if (!information) return;
		setStatus("Publishing");
		const publish =
			!isRootEntry && upstreamRoots.length > 0
				? doReversePublish(information, upstreamRoots, sdk, setPublishStatus)
				: doPublish(information, sdk, setPublishStatus);
		publish
			.then((ok) => {
				if (ok) retrieveInformation();
			})
			.catch((err) => console.error("Error publishing", err));
	}, [information, retrieveInformation, sdk, isRootEntry, upstreamRoots]);

	const handleScheduledPublish = useCallback(() => {
		if (!information || !scheduledDate) return;
		setStatus("Publishing");
		const publish =
			!isRootEntry && upstreamRoots.length > 0
				? doReversePublish(
						information,
						upstreamRoots,
						sdk,
						setPublishStatus,
						scheduledDate,
					)
				: doPublish(information, sdk, setPublishStatus, scheduledDate);
		publish
			.then((ok) => {
				if (ok) retrieveInformation();
			})
			.catch((err) => console.error("Error scheduling publish", err));
	}, [information, retrieveInformation, sdk, scheduledDate, isRootEntry, upstreamRoots]);

	const toggleScheduleOptions = useCallback(() => {
		setShowScheduleOptions((prev) => !prev);
	}, []);

	const handleRefresh = useCallback(() => {
		retrieveInformation();
	}, [retrieveInformation]);

	// ── Loading ──────────────────────────────────────────────────────────────
	if (status === "Idle" || status === "Reading") {
		return (
			<Box padding="spacingM">
				<Stack spacing="spacingS">
					<Paragraph>{loadingPhase}</Paragraph>
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

		const publishNeeded =
			information.errorCount > 0 ||
			!information.published ||
			(information.errorCount === 0 && publishNeedCount > 0);

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

		// Dynamic label derived from actual content types of upstream roots
		const rootsByType = upstreamRoots.reduce(
			(acc, r) => {
				const ct = r.entry.sys.contentType.sys.id;
				acc[ct] = (acc[ct] ?? 0) + 1;
				return acc;
			},
			{} as Record<string, number>,
		);
		const rootsLabel =
			Object.entries(rootsByType)
				.map(([ct, n]) => `${n} ${ct}${n !== 1 ? "s" : ""}`)
				.join(", ") || "root entries";

		const safeRootCount = upstreamRoots.filter((r) => r.safe).length;
		const publishButtonLabel =
			!isRootEntry && safeRootCount > 0
				? `Publish + ${rootsLabel}`
				: "Publish Now";

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

				{!isRootEntry && upstreamRoots.length > 0 && (
					<Box
						padding="spacingS"
						style={{ borderTop: "1px solid #DCDEE4", marginTop: "8px" }}
					>
						<Stack spacing="spacingS" flexDirection="column">
							<Text fontWeight="fontWeightMedium" fontSize="fontSizeS">
								Used on {rootsLabel}
							</Text>
							<List>
								{upstreamRoots.map((root) => (
									<ListItem key={root.entry.sys.id}>
										<Flex justifyContent="space-between" alignItems="center">
											<a
												href={getEditorEntry(root.entry.sys)}
												target="_blank"
												rel="noreferrer"
											>
												{getEntryLabel(root.entry)}
											</a>
											<Badge variant={root.safe ? "positive" : "warning"}>
												{root.safe ? "safe" : "blocked"}
											</Badge>
										</Flex>
									</ListItem>
								))}
							</List>
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
