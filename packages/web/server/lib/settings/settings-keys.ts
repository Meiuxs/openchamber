export type StringSettingsKey =
  | 'themeId' | 'locale' | 'lightThemeId' | 'darkThemeId' | 'splashBgLight' | 'splashFgLight' | 'splashBgDark'
  | 'splashFgDark' | 'lastDirectory' | 'homeDirectory' | 'opencodeBinary' | 'desktopUiPassword' | 'activeProjectId'
  | 'uiFont' | 'monoFont' | 'customUiFont' | 'customMonoFont' | 'uiFontWeight' | 'githubClientId' | 'githubScopes'
  | 'gitlabClientId' | 'fileEditorVimMappings' | 'tunnelProvider' | 'tunnelMode' | 'lastSelectedModel'
  | 'pwaAppName' | 'pwaOrientation' | 'mobileKeyboardMode' | 'browserProvider' | 'agentMemoryDreamingModel'
  | 'agentMemoryDreamingVariant' | 'agentImageModel' | 'isolatedSpacesSshHost' | 'openCodeUpdateToastDismissedVersion'
  | 'terminalShell' | 'openInAppId' | 'globalBehaviorPrompt' | 'responseStylePreset' | 'responseStyleCustomInstructions'
  | 'sttServerUrl' | 'sttModel' | 'sttEndpointPath' | 'sttLocalModel' | 'sttLanguage' | 'sttPrompt' | 'sidebarProjectDisplayMode'
  | 'sidebarViewMode' | 'sidebarListSessionGrouping' | 'sidebarGrouping' | 'sidebarProjectSortOrder'
  | 'selectionApprovalText' | 'allowedInsecureGitOrigins' | 'logLevel' | 'modelRateLimitGateways';

export type ClearableStringSettingsKey =
  | 'managedRemoteTunnelHostname' | 'managedRemoteTunnelSelectedPresetId' | 'defaultModel' | 'defaultVariant'
  | 'defaultAgent' | 'smallModelOverride' | 'smallModelVariant' | 'walkthroughModelOverride' | 'walkthroughModelVariant'
  | 'fallbackModel' | 'fallbackVariant' | 'defaultGitIdentityId' | 'zenModel' | 'chatsDefaultModel' | 'chatsDefaultVariant' | 'chatsDefaultAgent';

export type NumberSettingsKey =
  | 'inputHistoryLimit' | 'sidebarSessionBatchSize' | 'liveBrowserTabLimit' | 'sessionGoalMaxAutoTurns'
  | 'sessionGoalDefaultBudget' | 'summaryThreshold' | 'summaryLength' | 'maxLastMessageLength' | 'autoDeleteAfterDays'
  | 'tunnelSessionTtlMs' | 'tunnelHttpsPort' | 'fontSize' | 'chatFontSize' | 'terminalFontSize' | 'editorFontSize'
  | 'padding' | 'cornerRadius' | 'inputBarOffset'
  | 'modelRateLimitRequests' | 'modelRateLimitWindowMinutes';

export type StringArraySettingsKey =
  | 'workStatusHiddenSections' | 'workStatusSectionOrder' | 'sidebarHiddenSections' | 'sidebarPageOrder' | 'sidebarHiddenPages' | 'securityScopedBookmarks'
  | 'pinnedDirectories' | 'providerOrder' | 'usageDropdownProviders' | 'accountSwitchProviders'
  | 'terminalLoginShells' | 'collapsedModelProviders' | 'recentAgents' | 'favoriteAgents';
