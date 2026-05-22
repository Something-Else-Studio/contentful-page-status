import type { EntryProps, KeyValueMap } from "contentful-management";
import type { IEditorLinkSys } from "./types";
import { logError } from "./debug";

export const ROOT_CONTENT_TYPES = ["article", "page"];

export function getEntryLabel(entry: EntryProps<KeyValueMap>): string {
	if (!entry.fields) return "Untitled";

	const titleField =
		entry.fields["title"] ||
		entry.fields["name"] ||
		entry.fields["label"] ||
		entry.fields["headline"];
	if (titleField) {
		return titleField["en-US"] || Object.values(titleField)[0] || "Untitled";
	}

	const firstField = Object.values(entry.fields)[0];
	if (firstField) {
		return firstField["en-US"] || Object.values(firstField)[0] || "Untitled";
	}

	return "Untitled";
}

export function getEntrySlug(entry: EntryProps<KeyValueMap>): string {
	const slugField = entry.fields?.["slug"];
	if (slugField) {
		return slugField["en-US"] || Object.values(slugField)[0] || "";
	}
	return getEntryLabel(entry);
}

export function getLinksFromEntry(entry: EntryProps<KeyValueMap>) {
	const links: { type: "Entry" | "Asset"; id: string }[] = [];

	if (!entry.fields) return links;

	Object.values(entry.fields).forEach((fieldValue) => {
		const value = fieldValue["en-US"] || Object.values(fieldValue)[0];

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

export function getMissingIds(
	requestedIds: string[],
	foundItems: { sys: { id: string } }[],
) {
	const foundIds = new Set(foundItems.map((item) => item.sys.id));
	return requestedIds.filter((id) => !foundIds.has(id));
}

export function getEditorEntry(sys: IEditorLinkSys): string {
	try {
		return `https://app.contentful.com/spaces/${sys.space.sys.id}/environments/${sys.environment.sys.id}/${
			sys.type === "Asset" ? "assets" : "entries"
		}/${sys.id}`;
	} catch (error) {
		logError("getEditorEntry error", error);
		return "/";
	}
}
