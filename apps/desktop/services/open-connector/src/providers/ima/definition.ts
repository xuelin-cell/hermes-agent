import type { ProviderDefinition } from "../../core/types.ts";

import { imaActions } from "./actions.ts";

const service = "ima";

/**
 * IMA provider backed by Tencent IMA OpenAPI.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "ima",
  categories: ["AI", "Productivity"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "clientId",
          label: "Client ID",
          inputType: "text",
          required: true,
          secret: false,
          description:
            "The IMA OpenAPI client ID sent with the ima-openapi-clientid header. Get it from the Tencent IMA desktop client.",
        },
        {
          key: "apiKey",
          label: "API Key",
          inputType: "password",
          required: true,
          secret: true,
          description:
            "The IMA OpenAPI API key sent with the ima-openapi-apikey header. Get it from the Tencent IMA desktop client.",
        },
      ],
    },
  ],
  homepageUrl: "https://ima.qq.com",
  actions: imaActions,
};
