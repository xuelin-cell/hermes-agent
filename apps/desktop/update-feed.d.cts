interface DarwinFeed {
  /** Feed directory key under the public bucket, no trailing slash.
   *  e.g. "releases/darwin/stable" | "releases/darwin/light/canary" */
  directory: string
  /** Validated slug; existence is resolved through R2. */
  channel: string
  /** electron-updater manifest filename. e.g. "stable-mac.yml" */
  fileName: string
  /** Legacy nonstable feeds admit prereleases. */
  allowPrerelease: boolean
}

/**
 * Feed layout contract shared by the desktop runtime and the release
 * pipeline. `light` selects the Light-variant feed directory.
 * The generic-provider feed URL is PUBLIC_URL + '/' + directory + '/' + fileName.
 */
declare function darwinFeed(channel: string, light?: boolean): DarwinFeed

interface Win32Feed {
  /** Feed directory key under the public bucket, no trailing slash.
   *  e.g. "releases/win32/stable" | "releases/win32/light/canary" */
  directory: string
  /** electron-updater channel name. e.g. "stable" | "canary" */
  channel: string
  /** electron-updater manifest filename. e.g. "stable.yml" */
  fileName: string
  /** Nonstable feeds admit prereleases. */
  allowPrerelease: boolean
}

/**
 * The NSIS electron-updater feed for a channel. Same directory shape as
 * darwinFeed, but the manifest is `<channel>.yml` (electron-updater's
 * Windows naming) instead of `<channel>-mac.yml`.
 */
declare function win32Feed(channel: string, light?: boolean): Win32Feed

/** Validate and canonicalize the public updater feed base URL. */
declare function feedBaseUrl(raw: string | undefined): string | undefined

declare const contract: {
  darwinFeed: typeof darwinFeed
  win32Feed: typeof win32Feed
  feedBaseUrl: typeof feedBaseUrl
}
export = contract
