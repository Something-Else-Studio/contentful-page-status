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
import { EntryAPI, EntrySys, SidebarAppSDK } from "@contentful/app-sdk";
import { useSDK } from "@contentful/react-apps-toolkit";
import {
  EntryReferenceError,
  EntryReferenceProps,
} from "contentful-management/dist/typings/entities/entry";
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

// Entry types to exclude from recursive reference fetching
const EXCLUDED_CONTENT_TYPES = [
  "article",
  "page",
  "articleType",
  "person",
  "tag",
  "template",
  "customType",
  "navigation",
];

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

// Function to iteratively fetch references with improved deduplication
async function fetchReferencesIteratively(
  sdk: SidebarAppSDK,
  entryId: string,
  setProgress?: (progress: { processed: number; total: number }) => void
): Promise<IAllReferences> {
  // Initialize the collection of all references
  const allReferences: IAllReferences = {
    entries: [],
    assets: [],
    errors: [],
    processedEntryIds: new Set<string>(),
  };

  // Queue of entries to process
  const entriesToProcess: string[] = [entryId];

  // Set to track entries that have been added to the queue
  const entriesQueued = new Set<string>([entryId]);

  // Sets to track unique entry and asset IDs already added to our collections
  const trackedEntryIds = new Set<string>();
  const trackedAssetIds = new Set<string>();

  // Counters for progress
  let processed = 0;
  let total = 1; // Start with 1 for the initial entry

  // Process the queue until it's empty
  while (entriesToProcess.length > 0) {
    // Get the next entry to process
    const currentEntryId = entriesToProcess.shift()!;

    try {
      // Skip if we've already processed this entry
      if (allReferences.processedEntryIds.has(currentEntryId)) {
        continue;
      }

      // Mark this entry as processed
      allReferences.processedEntryIds.add(currentEntryId);

      // Fetch references for this entry
      const references = await sdk.cma.entry.references({
        entryId: currentEntryId,
      });

      // Update progress counters
      processed++;
      if (setProgress) {
        setProgress({ processed, total });
      }

      if (!references) {
        continue;
      }

      debug("references", references);

      // Add any errors
      if (references.errors) {
        allReferences.errors.push(...references.errors);
      }

      // Process assets
      if (references.includes?.Asset) {
        for (const asset of references.includes.Asset) {
          debug(
            `Looking at asset ${asset.sys.id}: ${
              asset.fields.title["en-US"]
            } ${isPublished(asset)}`
          );
          const assetId = asset.sys.id;
          // Check if we already have this asset using the Set for O(1) lookup
          if (!trackedAssetIds.has(assetId)) {
            allReferences.assets.push(asset);
            trackedAssetIds.add(assetId);
          }
        }
      }

      // Process entries
      const entries = references.includes?.Entry || [];

      // Add entries to our collection (if not already there)
      for (const entry of entries) {
        debug(
          `Looking at entry ${entry.sys.id}: ${entry.sys.contentType.sys.id} ${
            Object.entries(entry.fields)[0][1]["en-US"]
          } ${isPublished(entry)}`
        );
        const entryId = entry.sys.id;
        // Use the Set for O(1) lookup instead of array.some() which is O(n)
        if (!trackedEntryIds.has(entryId)) {
          allReferences.entries.push(entry);
          trackedEntryIds.add(entryId);
        }

        // Queue up this entry for processing if it's not excluded and not already queued
        const contentType = entry.sys.contentType.sys.id;
        if (
          !EXCLUDED_CONTENT_TYPES.includes(contentType) &&
          !entriesQueued.has(entryId)
        ) {
          entriesToProcess.push(entryId);
          entriesQueued.add(entryId);
          total++; // Increment total count for progress tracking

          // Update progress
          if (setProgress) {
            setProgress({ processed, total });
          }
        }
      }
    } catch (error) {
      console.error(
        "Error fetching references for entry",
        currentEntryId,
        ":",
        error
      );
      // Add a generic error
      allReferences.errors.push({
        details: {
          errors: [{ message: `Error fetching references: ${error}` }],
        },
        sys: { id: currentEntryId, type: "Entry" },
      } as any);

      // Update progress
      processed++;
      if (setProgress) {
        setProgress({ processed, total });
      }
    }
  }

  return allReferences;
}
function buildReferenceInformation(
  entrySys: EntrySys,
  allReferences: IAllReferences
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
      publishedDate && a.sys.publishedAt && a.sys.publishedAt > publishedDate
  );
  const entriesPublishedAfter = entries?.filter(
    (e) =>
      publishedDate && e.sys.publishedAt && e.sys.publishedAt > publishedDate
  );
  const isOutOfDate =
    (assetsPublishedAfter?.length ?? 0) > 0 ||
    (entriesPublishedAfter?.length ?? 0) > 0;

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
    const result = `https://app.contentful.com/spaces/${sys.space.sys.id}/${
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
  scheduledTime?: string
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
    environmentId: string
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
        }
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
    entity: any
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
          asset.sys.environment.sys.id
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
          entry.sys.environment.sys.id
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
          entrySys.environment.sys.id
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
    []
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
        updateProgress
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
                    publishStatus.scheduledTime || ""
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

    const publishNeeded =
      information.errorCount === 0 &&
      (!information.published ||
        (information.errorCount === 0 && publishNeedCount > 0));

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
                {publishNeedCount > 0 && (
                  <Text>
                    {publishNeedCount} item
                    {`${publishNeedCount === 1 ? "" : "s"}`} need
                    {`${publishNeedCount === 1 ? "s" : ""}`} publishing
                  </Text>
                )}
                <Stack spacing="spacingS">
                  <Button variant="primary" onClick={handlePublish}>
                    Publish Now
                  </Button>
                  <Button variant="secondary" onClick={toggleScheduleOptions}>
                    Schedule...
                  </Button>
                </Stack>
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
              <Note variant="positive">All up to date</Note>
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
