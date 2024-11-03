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
import { SidebarAppSDK } from "@contentful/app-sdk";
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

function buildReferenceInformation(
  references: EntryReferenceProps
): IReferenceInformation {
  const published = isPublished(references.items[0]);
  const errors = references.errors;
  const errorCount = errors?.length ?? 0;
  const entries = references.includes?.Entry;
  const entryCount = entries?.length ?? 0;
  const draftEntries = entries?.filter(isDraft) ?? [];
  const updatedEntries = entries?.filter(isUpdated) ?? [];
  const draftEntryCount = draftEntries.length;
  const updatedEntryCount = updatedEntries.length;
  const assets = references.includes?.Asset;
  const assetCount = assets?.length ?? 0;
  const draftAssets = assets?.filter(isDraft) ?? [];
  const draftAssetCount = draftAssets.length;
  const updatedAssets = assets?.filter(isUpdated) ?? [];
  const updatedAssetCount = updatedAssets.length;

  return {
    published,
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
}

function getEditorEntry(sys: EntityMetaSysProps) {
  console.log("get editor entry", sys);
  try {
    const result = `https://app.contentful.com/spaces/${sys.space.sys.id}/${
      sys.type === "Asset" ? "assets" : "entries"
    }/${sys.id}`;
    return result;
  } catch (error) {
    console.log("error", error);
    return "/";
  }
}
async function doPublish(
  information: IReferenceInformation,
  sdk: SidebarAppSDK,
  setStatus: (status: IPublishStatus) => void
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
  let errored = [];
  for (const asset of [...draftAssets, ...updatedAssets]) {
    try {
      await sdk.cma.asset.publish({ assetId: asset.sys.id }, asset);
      published++;
    } catch (error) {
      console.log("Error", error);
      errors++;
      errored.push(asset.sys);
    }
    setStatus({ total, published, errors, errored });
  }
  for (const entry of [...draftEntries, ...updatedEntries]) {
    try {
      await sdk.cma.entry.publish({ entryId: entry.sys.id }, entry);
      published++;
    } catch (error) {
      console.log("Entry error", error);
      errors++;
      errored.push(entry.sys);
    }
    setStatus({ total, published, errors, errored });
  }
  if (errors === 0) {
    await sdk.entry.publish();
  }
  return errors === 0;
}

const Sidebar = () => {
  const sdk = useSDK<SidebarAppSDK>();
  const [status, setStatus] = useState<Status>("Idle");
  const [error, setError] = useState<string>();
  const [information, setInformation] = useState<IReferenceInformation>();
  const [publishStatus, setPublishStatus] = useState<IPublishStatus>();

  const retrieveInformation = useCallback(() => {
    setStatus("Reading");
    sdk.cma.entry
      .references({ entryId: sdk.entry.getSys().id })
      .then((references) => {
        if (!references) {
          setStatus("Error");
          setError("No references returned");
          return;
        }
        setStatus("Complete");
        const information = buildReferenceInformation(references);
        setInformation(information);
        return;
      })
      .catch((error) => {
        setStatus("Error");
        setError(`Error: ${error}`);
      });
  }, [sdk]);

  useEffect(() => {
    retrieveInformation();
  }, [retrieveInformation]);

  const handlePublish = useCallback(() => {
    if (!information) return;
    setStatus("Publishing");
    doPublish(information, sdk, setPublishStatus)
      .then((status) => {
        console.log("Done publishing");
        if (status) {
          retrieveInformation();
        }
      })
      .catch((error) => {
        console.log("Error publishing", error);
      });
  }, [information, retrieveInformation, sdk]);

  const handleRefresh = useCallback(() => {
    retrieveInformation();
  }, [retrieveInformation]);

  if (status === "Idle" || status === "Reading") {
    return (
      <Box padding="spacingM">
        <Paragraph>Loading ...</Paragraph>
      </Box>
    );
  }

  if (status === "Publishing" && publishStatus) {
    return (
      <Box padding="spacingM">
        <Note variant="primary">
          <Stack spacing="spacingS">
            <Text fontWeight="fontWeightMedium">Publishing</Text>
            <List>
              <ListItem>
                Published: {publishStatus.published}/{publishStatus.total}
              </ListItem>
              {publishStatus.errors > 0 && (
                <>
                  <ListItem>Errors: {publishStatus.errors}</ListItem>
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
                </>
              )}
            </List>
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
    const publishNeeded =
      information.errorCount === 0 &&
      (!information.published ||
        (information.errorCount === 0 &&
          information.draftEntryCount +
            information.updatedEntryCount +
            information.draftAssetCount +
            information.updatedAssetCount >
            0));

    return (
      <Box>
        {publishNeeded ? (
          <Stack
            spacing="spacingM"
            flexDirection="column"
            alignItems="flex-start"
          >
            <Flex gap="spacingS">
              <Button variant="primary" onClick={handlePublish}>
                Publish outdated
              </Button>
              <Button onClick={handleRefresh} variant="secondary">
                Refresh
              </Button>
            </Flex>

            <Stack
              spacing="spacingS"
              flexDirection="column"
              alignItems="flex-start"
            >
              <Stack
                spacing="none"
                flexDirection="column"
                alignItems="flex-start"
              >
                {information.errorCount > 0 && (
                  <Text fontColor="red900">
                    Error count: {information.errorCount}
                  </Text>
                )}
                <Text>
                  Draft entries: {information.draftEntryCount}/
                  {information.entryCount}
                </Text>
                <Text>
                  Updated entries: {information.updatedEntryCount}/
                  {information.entryCount}
                </Text>
                <Text>
                  Draft assets: {information.draftAssetCount}/
                  {information.assetCount}
                </Text>
                <Text>
                  Updated assets: {information.updatedAssetCount}/
                  {information.assetCount}
                </Text>
              </Stack>
            </Stack>
          </Stack>
        ) : (
          <Box padding="spacingM">
            <Stack
              spacing="spacingS"
              flexDirection="column"
              alignItems="flex-start"
            >
              <Note variant="positive">All up to date</Note>
              <Button onClick={handleRefresh} variant="secondary">
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
