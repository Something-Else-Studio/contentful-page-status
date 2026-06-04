import React, { useCallback, useState, useEffect } from "react";
import type { ConfigAppSDK } from "@contentful/app-sdk";
import {
  Heading,
  Form,
  Paragraph,
  Flex,
  FormControl,
  TextInput,
  Badge,
  Stack,
} from "@contentful/f36-components";
import { css } from "@emotion/css";
import { /* useCMA, */ useSDK } from "@contentful/react-apps-toolkit";
import type { AppInstallationParameters } from "../lib/types";

const ConfigScreen = () => {
  const [parameters, setParameters] = useState<AppInstallationParameters>({});
  const sdk = useSDK<ConfigAppSDK>();

  const onConfigure = useCallback(async () => {
    // This method will be called when a user clicks on "Install"
    // or "Save" in the configuration screen.
    // for more details see https://www.contentful.com/developers/docs/extensibility/ui-extensions/sdk-reference/#register-an-app-configuration-hook

    // Get current the state of EditorInterface and other entities
    // related to this app installation
    const currentState = await sdk.app.getCurrentState();

    return {
      // Parameters to be persisted as the app configuration.
      parameters,
      // In case you don't want to submit any update to app
      // locations, you can just pass the currentState as is
      targetState: currentState,
    };
  }, [parameters, sdk]);

  useEffect(() => {
    // `onConfigure` allows to configure a callback to be
    // invoked when a user attempts to install the app or update
    // its configuration.
    sdk.app.onConfigure(() => onConfigure());
  }, [sdk, onConfigure]);

  useEffect(() => {
    (async () => {
      // Get current parameters of the app.
      // If the app is not installed yet, `parameters` will be `null`.
      const currentParameters: AppInstallationParameters | null =
        await sdk.app.getParameters();

      if (currentParameters) {
        setParameters(currentParameters);
      }

      // Once preparation has finished, call `setReady` to hide
      // the loading screen and present the app to a user.
      sdk.app.setReady();
    })();
  }, [sdk]);

  return (
    <Flex
      flexDirection="column"
      className={css({ margin: "80px", maxWidth: "800px" })}
    >
      <Form>
        <Heading>Page Status App Config</Heading>
        <Paragraph>
          Configure which Contentful content types should be treated as "root" entries
          (top-level pages, articles, variants, indexes, etc.).
        </Paragraph>

        <FormControl>
          <FormControl.Label>Root Content Types</FormControl.Label>
          <TextInput
            value={(parameters.rootContentTypes || []).join(", ")}
            onChange={(e) => {
              const value = e.target.value;
              const arr = value
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              setParameters({
                ...parameters,
                rootContentTypes: arr.length > 0 ? arr : undefined,
              });
            }}
            placeholder="page, article, pageVariant, customType, articleType, tag, tagType, person"
          />
          <FormControl.HelpText>
            Comma-separated list of content type IDs (e.g. "page,article,pageVariant").
            These entries get full downward dependency scanning before publishing, and
            are discovered via "Used on" when editing shared components/collections.
            Leave empty to use the built-in defaults (recommended).
          </FormControl.HelpText>
        </FormControl>

        {(parameters.rootContentTypes || []).length > 0 && (
          <Stack spacing="spacingXs" flexDirection="row" style={{ flexWrap: "wrap", marginTop: "8px" }}>
            {(parameters.rootContentTypes || []).map((ct) => (
              <Badge key={ct} variant="primary">
                {ct}
              </Badge>
            ))}
          </Stack>
        )}

        <Paragraph style={{ marginTop: "16px", fontSize: "0.85em", color: "#6b7280" }}>
          Defaults (when left empty): article, articleType, customType, page, pageVariant, person, tag, tagType.
          These are the types that have their own component trees in the SE core platform
          and customer sites (brightline, pedestal, etc.).
        </Paragraph>
      </Form>
    </Flex>
  );
};

export default ConfigScreen;
