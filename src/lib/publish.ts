import type { SidebarAppSDK } from "@contentful/app-sdk";
import type { EntityMetaSysProps, EntryProps, KeyValueMap } from "contentful-management";
import type { IReferenceInformation, IPublishStatus, IUpstreamRoot } from "./types";
import { logError } from "./debug";

export async function doPublish(
	information: IReferenceInformation,
	sdk: SidebarAppSDK,
	setStatus: (status: IPublishStatus) => void,
	scheduledTime?: string,
	overrideEntry?: { id: string; entry: EntryProps<KeyValueMap> },
): Promise<boolean> {
	const { draftAssets, updatedAssets, draftEntries, updatedEntries } =
		information;
	const total =
		draftAssets.length +
		updatedAssets.length +
		draftEntries.length +
		updatedEntries.length;

	let published = 0;
	let errors = 0;
	const errored: EntityMetaSysProps[] = [];
	const scheduledActionIds: string[] = [];

	const isScheduled = !!scheduledTime;

	setStatus({
		total,
		published: 0,
		errors: 0,
		errored: [],
		isScheduled,
		scheduledTime,
		scheduledActionIds,
	});

	const schedulePublish = async (
		entityType: "asset" | "entry",
		id: string,
		spaceId: string,
		environmentId: string,
	) => {
		if (!scheduledTime) return false;
		const scheduleDate = new Date(scheduledTime);
		try {
			const scheduledAction = await sdk.cma.scheduledActions.create(
				{ spaceId },
				{
					environment: {
						sys: { type: "Link", linkType: "Environment", id: environmentId },
					},
					entity: {
						sys: {
							type: "Link",
							linkType: entityType === "entry" ? "Entry" : "Asset",
							id,
						},
					},
					action: "publish",
					scheduledFor: { datetime: scheduleDate.toISOString() },
				},
			);
			if (scheduledAction?.sys?.id) {
				scheduledActionIds.push(scheduledAction.sys.id);
			}
			return true;
		} catch (error) {
			logError(`Error scheduling ${entityType}:`, error);
			throw error;
		}
	};

	const publishImmediately = async (
		entityType: "asset" | "entry",
		id: string,
		entity: EntryProps<KeyValueMap> | any,
	) => {
		try {
			if (entityType === "asset") {
				await sdk.cma.asset.publish({ assetId: id }, entity);
			} else {
				await sdk.cma.entry.publish({ entryId: id }, entity);
			}
			return true;
		} catch (error) {
			logError(`Error publishing ${entityType}:`, error);
			throw error;
		}
	};

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
		} catch {
			errors++;
			errored.push(asset.sys);
		}
		setStatus({ total, published, errors, errored, isScheduled, scheduledTime, scheduledActionIds });
	}

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
		} catch {
			errors++;
			errored.push(entry.sys);
		}
		setStatus({ total, published, errors, errored, isScheduled, scheduledTime, scheduledActionIds });
	}

	if (errors === 0) {
		try {
			if (overrideEntry) {
				if (isScheduled && scheduledTime) {
					await schedulePublish(
						"entry",
						overrideEntry.id,
						overrideEntry.entry.sys.space.sys.id,
						overrideEntry.entry.sys.environment.sys.id,
					);
				} else {
					await publishImmediately("entry", overrideEntry.id, overrideEntry.entry);
				}
			} else {
				const entrySys = sdk.entry.getSys();
				if (isScheduled && scheduledTime) {
					await schedulePublish(
						"entry",
						entrySys.id,
						entrySys.space.sys.id,
						entrySys.environment.sys.id,
					);
				} else {
					await sdk.entry.publish();
				}
			}
		} catch (error) {
			logError("Error with main entry:", error);
			errors++;
		}
	}

	return errors === 0;
}

export async function doReversePublish(
	information: IReferenceInformation,
	upstreamRoots: IUpstreamRoot[],
	sdk: SidebarAppSDK,
	setStatus: (status: IPublishStatus) => void,
	scheduledTime?: string,
	options?: { skipComponentPublish?: boolean },
): Promise<boolean> {
	if (!options?.skipComponentPublish) {
		const ok = await doPublish(information, sdk, setStatus, scheduledTime);
		if (!ok) return false;
	}

	for (const root of upstreamRoots.filter((r) => r.safe)) {
		await doPublish(
			root.information,
			sdk,
			setStatus,
			scheduledTime,
			{ id: root.entry.sys.id, entry: root.entry },
		);
	}

	return true;
}
