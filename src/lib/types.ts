import type {
	AssetProps,
	EntityMetaSysProps,
	EntryProps,
	EntryReferenceProps,
	KeyValueMap,
} from "contentful-management";

export type EntryReferenceError = NonNullable<
	EntryReferenceProps["errors"]
>[number];

export type Status = "Idle" | "Reading" | "Complete" | "Error" | "Publishing";

/** Minimal entry sys fields needed by buildReferenceInformation. Satisfied by both
 *  EntrySys (app-sdk) and EntryProps.sys (contentful-management) without casting. */
export interface IEntrySysLike {
	id: string;
	publishedAt?: string | null;
	publishedVersion?: number | null;
	version: number;
}

/** Minimal sys fields needed by getEditorEntry. Satisfied by both EntityMetaSysProps
 *  and EntryProps.sys without casting. */
export interface IEditorLinkSys {
	id: string;
	type: string;
	space: { sys: { id: string } };
	environment: { sys: { id: string } };
}

export interface IReferenceInformation {
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

export interface IProgressStatus {
	processed: number;
	total: number;
	isComplete: boolean;
}

export interface IAllReferences {
	entries: EntryProps<KeyValueMap>[];
	assets: AssetProps[];
	errors: EntryReferenceError[];
	processedEntryIds: Set<string>;
}

export interface IPublishStatus {
	total: number;
	published: number;
	errors: number;
	errored: EntityMetaSysProps[];
	isScheduled?: boolean;
	scheduledTime?: string;
	scheduledActionIds?: string[];
}

export interface IUpstreamRoot {
	entry: EntryProps<KeyValueMap>;
	/** @deprecated Full per-root dependency info no longer populated (heavy reverse scans removed for simplicity). */
	information?: IReferenceInformation;
	safe: boolean;
}

export interface IUpstreamRootsResult {
	roots: EntryProps<KeyValueMap>[];
	failedLookups: number;
}

/** Installation parameters for the app (set via ConfigScreen). */
export interface AppInstallationParameters {
	/** Custom list of content type IDs to treat as "roots" for dependency publishing
	 *  and reverse "Used on" discovery. Falls back to the built-in default list
	 *  (article, page, pageVariant, customType, etc.) if empty or unset. */
	rootContentTypes?: string[];
}
