import React, { useCallback, useEffect, useState } from "react";
import {
  Button,
  List,
  ListItem,
  Note,
  Paragraph,
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
  isUpdated,
} from "contentful-management";

type Status = "Idle" | "Reading" | "Complete" | "Error" | "Publishing";

interface IReferenceInformation {
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
        // console.log("References", references);
        // console.log(JSON.stringify(references, undefined, 2));
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

  /*
     To use the cma, inject it as follows.
     If it is not needed, you can remove the next line.
  */
  // const cma = useCMA();

  if (status === "Idle" || status === "Reading") {
    return <Paragraph>Loading ...</Paragraph>;
  }

  if (status === "Publishing" && publishStatus) {
    return (
      <Note>
        Publishing
        <List>
          <ListItem>Total: {publishStatus.total}</ListItem>
          <ListItem>Published: {publishStatus.published}</ListItem>
          <ListItem>Errors: {publishStatus.errors}</ListItem>
          {publishStatus.errored.map((s) => (
            <ListItem key={s.id}>
              <a href={getEditorEntry(s)} target="_blank" rel="noreferrer">
                {s.type} {s.id}
              </a>
            </ListItem>
          ))}
        </List>
      </Note>
    );
  }

  if (error) {
    return <Paragraph>Error processing: {error}</Paragraph>;
  }
  if (information) {
    const publishNeeded =
      information.errorCount === 0 &&
      information.draftEntryCount +
        information.updatedEntryCount +
        information.assetCount +
        information.draftAssetCount >
        0;

    return (
      <>
        {publishNeeded && (
          <Button variant="primary" onClick={handlePublish}>
            Publish outdated
          </Button>
        )}
        <Note>
          Details for component
          <List>
            <ListItem>Error count: {information.errorCount}</ListItem>
            <ListItem>Entry count: {information.entryCount}</ListItem>
            <ListItem>Draft entries: {information.draftEntryCount}</ListItem>
            <ListItem>
              Updated entries: {information.updatedEntryCount}
            </ListItem>
            <ListItem>Asset count: {information.assetCount}</ListItem>
            <ListItem>
              Draft asset count: {information.draftAssetCount}
            </ListItem>
            <ListItem>
              Updated asset count: {information.updatedAssetCount}
            </ListItem>
          </List>
        </Note>
      </>
    );
  }
  return <Paragraph>Hmm - something didn't work</Paragraph>;
};

export default Sidebar;