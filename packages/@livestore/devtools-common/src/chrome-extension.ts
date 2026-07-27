export const makeNodeName = {
  devtools: ({ tabId }: { tabId: number }) => `devtools-${tabId}`,
  contentscriptMain: ({ tabId }: { tabId: number }) => `contentscript-main-${tabId}` as const,
  contentscriptIframe: ({ tabId }: { tabId: number }) => `contentscript-iframe-${tabId}` as const,
  panel: ({ tabId }: { tabId: number }) => `devtools-panel-${tabId}` as const,
  extensionWorker: () => 'extension-worker' as const,
}

export const makeChannelName = {
  clipboard: ({ tabId }: { tabId: number }) => `devtools-background-clipboard-${tabId}`,
}
