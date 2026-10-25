/**
 * i18n System for Discord Bot
 *
 * ## Adding a New Language
 *
 * 1. Update `Locale` type: Add the new locale code (e.g., 'ko')
 *    ```ts
 *    export type Locale = 'ja' | 'en' | 'ko';
 *    ```
 *
 * 2. Update `SUPPORTED_LOCALES`: Add the new locale to the array
 *    ```ts
 *    export const SUPPORTED_LOCALES: Locale[] = ['ja', 'en', 'ko'];
 *    ```
 *
 * 3. Create translation file: Copy `en.ts` to `{locale}.ts` and translate all strings
 *    - File: `src/locales/ko.ts`
 *    - Export: `export const ko: TranslationKeys = { ... }`
 *
 * 4. Register in index.ts:
 *    - Import: `import { ko } from './ko.js';`
 *    - Add to translations: `const translations: Record<Locale, TranslationKeys> = { en, ja, ko };`
 *    - Add Discord locale mapping in `mapDiscordLocale()`:
 *      ```ts
 *      const localeMap: Record<string, Locale> = {
 *        ja: 'ja',
 *        'en-US': 'en',
 *        'en-GB': 'en',
 *        ko: 'ko',  // Discord locale code -> our locale
 *      };
 *      ```
 *
 * 5. Add Discord locale to `getLocalizations()` in `index.ts` (if needed for command localization)
 *
 * ## Discord Locale Codes Reference
 * See: https://discord.com/developers/docs/reference#locales
 */

/**
 * Supported locales
 */
export type Locale = 'ja' | 'en';

/**
 * Default locale for unmapped Discord locales
 */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Supported locales list
 */
export const SUPPORTED_LOCALES: Locale[] = ['ja', 'en'];

/**
 * Translation keys structure
 * Nested object with string values
 */
export interface TranslationKeys {
  // Common
  common: {
    error: string;
    warning: string;
    guildOnly: string;
    noPermission: string;
    noData: string;
    /** {id}: short error reference that is also written to the log. */
    unexpectedError: string;
    /** A panel button/select failed. {id} as in unexpectedError. */
    actionFailed: string;
    cooldownTitle: string;
    /** {command}: mention of the full path; {seconds}: whole seconds left. */
    cooldown: string;
    permissionDeniedTitle: string;
    /** {permissions}: localized names, already joined (formatPermissionNames). */
    permissionsRequired: string;
    permissionsUnverifiable: string;
    /** Labels as Discord's own client shows them, keyed by permission flag. */
    permissionNames: {
      Administrator: string;
      ManageGuild: string;
      ManageRoles: string;
      ManageChannels: string;
      ManageMessages: string;
      KickMembers: string;
      BanMembers: string;
      ModerateMembers: string;
      ViewAuditLog: string;
      ViewChannel: string;
      SendMessages: string;
      EmbedLinks: string;
      AttachFiles: string;
      Connect: string;
      Speak: string;
      MoveMembers: string;
    };
    serverOnlyTitle: string;
    confirm: string;
    cancel: string;
    confirmMessage: string;
    cancelled: string;
    nextStep: string;
    timedOutTitle: string;
    confirmTimedOut: string;
    confirmTimedOutRetry: string;
    promptClosedTitle: string;
    confirmInterrupted: string;
    confirmInterruptedRetry: string;
    onlyCommandUser: string;
    onlyCommandUserGeneric: string;
    panelExpired: string;
    panelExpiredGeneric: string;
    componentExpired: string;
    componentExpiredGeneric: string;
    componentNotReady: string;
    formExpired: string;
    notSet: string;
    notSetWithHint: string;
    /** Building blocks for formatDuration (src/locales/format.ts). */
    duration: {
      /** Joins two units: '1時間' + '23分', or '1h' + ' ' + '23m'. */
      pair: string;
      short: {
        hours: string;
        minutes: string;
        seconds: string;
        lessThanMinute: string;
      };
      long: {
        hoursOne: string;
        hoursOther: string;
        minutesOne: string;
        minutesOther: string;
        secondsOne: string;
        secondsOther: string;
        lessThanMinute: string;
      };
    };
  };

  // Settings command
  settings: {
    title: string;
    language: {
      name: string;
      changed: string;
      current: string;
      auto: string;
      /** {lang}: the language channel posts use while on automatic. */
      autoHint: string;
    };
    audit: {
      name: string;
      notSet: string;
      configured: string;
      disabled: string;
    };
    announcements: {
      name: string;
      notSet: string;
      configured: string;
      disabled: string;
    };
    logs: {
      title: string;
      noLogs: string;
      /** {from}-{to}: entries on this page; {total}: all entries kept. */
      showingRange: string;
    };
    panel: {
      tabOverview: string;
      tabLanguage: string;
      tabAudit: string;
      tabAnnouncements: string;
      tabLogs: string;
      languagePlaceholder: string;
      auditPlaceholder: string;
      announcementPlaceholder: string;
      clearAudit: string;
      clearAnnouncements: string;
      prevPage: string;
      nextPage: string;
      overviewFooter: string;
      languageFooter: string;
      auditFooter: string;
      announcementsFooter: string;
    };
    errors: {
      channelNotSendable: string;
      /** {channel}: channel id; {permissions}: formatPermissionNames. */
      channelMissingPermissions: string;
    };
  };

  // Roulette command
  roulette: {
    member: {
      title: string;
      countdown: string;
      selecting: string;
      result: string;
      /** {name}: escaped display name; {mention}: `<@id>`. */
      winner: string;
      /** {name}: escaped display name; {mention}: `<@id>`. */
      onlyOne: string;
      footer: string;
      /** {channel}, {count}: candidates drawn from, {excluded}: left out. */
      footerExcluded: string;
    };
    team: {
      title: string;
      shuffling: string;
      result: string;
      resultDesc: string;
      teamName: string;
      noMembers: string;
      footer: string;
    };
    /** Ends a name list cut short to fit. {count}: names left out. */
    andMore: string;
    /** Re-draw buttons under a result. */
    buttons: {
      again: string;
      excludeWinner: string;
      reshuffle: string;
    };
    errors: {
      notInVoice: string;
      notInVoiceDesc: string;
      noMembers: string;
      noMembersDesc: string;
      notEnough: string;
      notEnoughDesc: string;
      /** {channel}: voice channel id. */
      onlyParticipants: string;
      noCandidatesLeft: string;
    };
  };

  // Ping command
  ping: {
    title: string;
    latency: string;
    apiLatency: string;
    /** Shown instead of a figure before the first gateway heartbeat. */
    notMeasured: string;
  };

  // Poll command
  poll: {
    ended: string;
    endedMessage: string;
    noActivePoll: string;
    /** {command}: mention of `/community poll create`. */
    noActivePollDesc: string;
    /** {command}: mention of `/community poll end`. */
    createdHint: string;
    /** Autocomplete choice. {channel}: channel name; {remaining}: duration. */
    endChoice: string;
    confirm: {
      title: string;
      body: string;
      /** {channel}: channel id. */
      inChannel: string;
      confirm: string;
      cancel: string;
    };
    /** The form `/community poll create` opens when options are left out. */
    modal: {
      title: string;
      question: string;
      options: string;
      optionsDescription: string;
      optionsPlaceholder: string;
      duration: string;
      multi: string;
      retry: string;
      retryHint: string;
    };
    durations: {
      oneHour: string;
      fourHours: string;
      eightHours: string;
      oneDay: string;
      threeDays: string;
      sevenDays: string;
    };
    errors: {
      createFailed: string;
      notEnoughOptions: string;
      /** {count}: distinct options entered. */
      tooManyOptions: string;
      /** {line}: 1-based line number; {length}: its length. */
      optionLineTooLong: string;
      questionMissing: string;
      questionTooLong: string;
      optionTooLong: string;
      pollEnded: string;
      pollEndedDesc: string;
      endFailed: string;
      /** {channel}: channel id. */
      noAccessDesc: string;
      /** The `poll` option names none of the caller's open polls. */
      pickedNotFound: string;
      pickedNotFoundDesc: string;
    };
  };

  // Admin command
  admin: {
    role: {
      add: {
        success: string;
        /** {userId}, {displayName}, {roleId}. */
        successDesc: string;
      };
      remove: {
        success: string;
        /** {userId}, {displayName}, {roleId}. */
        successDesc: string;
      };
      errors: {
        memberNotFound: string;
        everyoneRole: string;
        /** {role}: role name. */
        managedRole: string;
        /** {botRole}: the bot's own role, where the permission is granted. */
        botMissingManageRoles: string;
        /** {role}: the role asked for; {botRole}: the bot's highest role. */
        botRoleHierarchy: string;
        actorRoleHierarchy: string;
        targetMemberHierarchy: string;
        botTargetMemberHierarchy: string;
        alreadyHasRole: string;
        doesNotHaveRole: string;
        failed: string;
      };
    };
    panel: {
      statsTab: string;
      dbTab: string;
      guildsTab: string;
      healthTab: string;
      metricsTab: string;
      backupsTab: string;
      refresh: string;
      runBackup: string;
      statsTitle: string;
      dbTitle: string;
      guildsTitle: string;
      healthTitle: string;
      metricsTitle: string;
      backupsTitle: string;
      backupsFooter: string;
      serversLabel: string;
      usersLabel: string;
      channelsLabel: string;
      uptimeLabel: string;
      /** {count}: whole days, the part of an uptime formatDuration lacks. */
      uptimeDays: string;
      memoryLabel: string;
      nodeLabel: string;
      environmentLabel: string;
      commandsLabel: string;
      tablesLabel: string;
      backupSuccess: string;
      backupFailure: string;
      noBackups: string;
      /** {count}: backups beyond the ones listed. */
      moreBackups: string;
    };
  };

  owner: {
    errors: {
      ownerOnly: string;
    };
    broadcast: {
      confirmTitle: string;
      confirmLabel: string;
      confirm: string;
      progress: string;
      /** {limit} of {total} servers; filled into progress's {capNote}. */
      progressCap: string;
      completeTitle: string;
      complete: string;
      capNote: string;
      noChannel: string;
      /** Title of the posted announcement, in each server's language. */
      embedTitle: string;
      embedFooter: string;
      /** {list}: one failed server per line. */
      failures: string;
      /** {count}: failed servers not listed. */
      moreFailures: string;
      failureReasons: {
        notSendable: string;
        timeout: string;
        sendFailed: string;
      };
    };
    backup: {
      confirmTitle: string;
      confirmLabel: string;
      confirm: string;
      running: string;
      completeTitle: string;
      complete: string;
      failedTitle: string;
      failed: string;
      /** Stands in for a failure the backup service gave no reason for. */
      noReason: string;
    };
  };

  /**
   * The audit trail: embeds posted to the audit channel (in the server's
   * language) and the detail strings stored with each row, which are written
   * once in that language and shown as stored.
   */
  audit: {
    actions: {
      NOTIFY_SETUP: string;
      NOTIFY_ENABLE: string;
      NOTIFY_DISABLE: string;
      NOTIFY_REMOVE: string;
      SETTINGS_CHANGE: string;
      AUDIT_SETUP: string;
      ROLE_ADD: string;
      ROLE_REMOVE: string;
    };
    fields: {
      user: string;
      target: string;
      details: string;
    };
    /** {mention}: a user mention; {name}: their name at the time. */
    userWithName: string;
    /** Notification kinds as the notification feature names them. */
    kinds: {
      Voice: string;
      Welcome: string;
    };
    details: {
      notifySetup: string;
      notifyChannel: string;
      notifyRemove: string;
      auditChannelCleared: string;
      announcementChannelSet: string;
      announcementChannelCleared: string;
      language: string;
      role: string;
    };
  };

  // Help command
  help: {
    title: string;
    /** Overview text that points at the menus below it. */
    description: string;
    /** Overview text when no menu is shown. */
    descriptionNoMenu: string;
    usage: string;
    examples: string;
    commandNotFound: string;
    /** A command name Discord sent that this build does not have. {command} */
    commandNotFoundDesc: string;
    /** {query}: what was typed, already stripped of backticks. */
    noMatch: string;
    /** {suggestion}: a command mention or `/path`. */
    didYouMean: string;
    /** {help}: mention of /general help. */
    noMatchHint: string;
    /** {query} as in noMatch. */
    matchesTitle: string;
    matchesHint: string;
    /** {permissions}: the levels, joined with "or". */
    requires: string;
    /** {name}, {required} (optionRequired or ''), {description}. */
    optionLine: string;
    optionRequired: string;
    /** {choices}: the choice labels joined with ' / '. */
    optionChoices: string;
    permission: {
      everyone: string;
      manageGuild: string;
      manageRoles: string;
      administrator: string;
      owner: string;
    };
    filteredFooter: string;
    selectCategory: string;
    selectCommand: string;
    showAll: string;
    back: string;
  };

  // /general about
  about: {
    title: string;
    /** {help}: mention of /general help. */
    description: string;
    popularTitle: string;
    voiceTitle: string;
    /** {duration}: how much audio is kept; {disable}: mention. */
    voiceOn: string;
    /** {enable}: mention. */
    voiceOff: string;
    /** {record}: mention; {retention}: how long the bot keeps its copy. */
    recordings: string;
    languageTitle: string;
    /** {language}: the language's own name. */
    languageGuild: string;
    languageAuto: string;
    /** {command}: mention of the language setting. */
    languageChange: string;
  };

  // Notification command
  notification: {
    voice: {
      setTitle: string;
      set: string;
      removedTitle: string;
      removed: string;
      nextStep: string;
      disabledHint: string;
      alreadyDisabled: string;
    };
    welcome: {
      setTitle: string;
      set: string;
      removedTitle: string;
      removed: string;
      nextStep: string;
      disabledHint: string;
      alreadyDisabled: string;
    };
    language: {
      line: string;
      autoHint: string;
    };
    status: {
      title: string;
      voiceLabel: string;
      welcomeLabel: string;
      disabled: string;
      postLanguage: string;
    };
    panel: {
      statusTab: string;
      statsTab: string;
      periodPlaceholder: string;
      voicePlaceholder: string;
      welcomePlaceholder: string;
      removeVoice: string;
      removeWelcome: string;
      statusDescription: string;
      confirmRemove: string;
      confirmRemoveButton: string;
      cancelRemoveButton: string;
      changed: string;
      removed: string;
    };
    stats: {
      title: string;
      noData: string;
      noDataInPeriodHint: string;
      liveSession: string;
      live: string;
      sessions: string;
      more: string;
      dayBoundaryJapan: string;
      dayBoundary: string;
      total: string;
      period: string;
      periods: {
        today: string;
        week: string;
        month: string;
        all: string;
      };
    };
    events: {
      voiceJoin: string;
      voiceLeave: string;
      voiceMove: string;
      voiceDigestTitle: string;
      memberJoinTitle: string;
      memberJoin: string;
      memberJoinRules: string;
    };
    summary: {
      voice: string;
      welcome: string;
    };
    errors: {
      textChannelOnly: string;
      channelNotSendable: string;
      channelMissingPermissions: string;
    };
  };

  // Record command
  record: {
    autojoin: {
      title: string;
      enabled: string;
      joinedNow: string;
      waitingForMembers: string;
      disabled: string;
      disabledDropped: string;
      excluded: string;
      alreadyExcluded: string;
      excludedLeft: string;
      included: string;
      includedWhileOff: string;
      notExcluded: string;
      alreadyReadOnly: string;
      statusEnabled: string;
      statusDisabled: string;
      exclusions: string;
      exclusionsNone: string;
      exclusionsMore: string;
      currentChannelBuffered: string;
      currentChannelListening: string;
      currentChannelExcluded: string;
      currentChannelNotBuffered: string;
      currentChannelNone: string;
    };
    notice: {
      title: string;
      body: string;
      optOut: string;
      optOutButton: string;
      optOutNotAllowed: string;
      optedOut: string;
      optedOutLeft: string;
      channelStatus: string;
    };
    notBuffered: {
      autoJoinOff: string;
      excluded: string;
      busyElsewhere: string;
      readOnly: string;
      atLimit: string;
      noPermission: string;
      notYetJoined: string;
      startedTitle: string;
      startedNow: string;
      beforeJoinNote: string;
    };
    status: {
      title: string;
      botChannel: string;
      capacity: string;
      capacityAvailable: string;
      capacityFull: string;
      saveLimit: string;
      saveLimitValue: string;
      noticeNoPermission: string;
      noticeSendFailed: string;
    };
    panel: {
      enable: string;
      disable: string;
      confirmDisable: string;
      cancelDisable: string;
      confirmDisablePrompt: string;
      disabled: string;
      exclusionsPlaceholder: string;
      exclusionsUpdated: string;
      nothingChanged: string;
      tooManyExclusions: string;
      hiddenExclusions: string;
    };
    audit: {
      autoJoinEnabled: string;
      autoJoinDisabled: string;
      channelExcluded: string;
      channelIncluded: string;
      exclusionsChanged: string;
      viaCommand: string;
      viaPanel: string;
      viaNoticeButton: string;
    };
    recording: string;
    recordingDesc: string;
    inProgressNote: string;
    success: string;
    successDesc: string;
    trimmedNote: string;
    saveWarning: string;
    fileSize: string;
    fileSizeSplit: string;
    partLabel: string;
    partLabelShort: string;
    statusHint: string;
    errors: {
      notInVoice: string;
      notInVoiceDesc: string;
      notVoiceChannel: string;
      notBuffered: string;
      botUnavailable: string;
      invalidDuration: string;
      invalidDurationDesc: string;
      durationTooLong: string;
      durationTooLongDesc: string;
      durationExceedsBuffer: string;
      durationExceedsBufferDesc: string;
      noAudibleAudio: string;
      noAudibleAudioDesc: string;
      noAudibleAudioLongerHint: string;
      noPermission: string;
      noPermissionDesc: string;
      deliveryIncomplete: string;
      deliveryIncompleteDesc: string;
      busy: string;
      busyDesc: string;
      tooLarge: string;
      tooLargeDesc: string;
      failed: string;
      failedDesc: string;
    };
  };

  // First-run message when a server adds the bot (voice feature)
  onboarding: {
    title: string;
    description: string;
    bufferingTitle: string;
    buffering: string;
    setupTitle: string;
    setup: string;
    missingTitle: string;
    missingLine: string;
    missing: {
      ViewChannel: string;
      Connect: string;
      SendMessages: string;
      EmbedLinks: string;
      AttachFiles: string;
      ManageRoles: string;
    };
    footer: string;
  };

  // Text-to-speech
  tts: {
    errors: {
      notConfigured: string;
      notConfiguredDesc: string;
      engineDown: string;
      engineDownDesc: string;
      notInVoice: string;
      notInVoiceDesc: string;
      busyElsewhere: string;
      busyElsewhereDesc: string;
      cannotJoin: string;
      cannotJoinDesc: string;
      notRunning: string;
      notRunningDesc: string;
      notInSameVoice: string;
      notInSameVoiceDesc: string;
    };
    started: string;
    startedDesc: string;
    howToTitle: string;
    howTo: string;
    noSpeakPermission: string;
    credit: string;
    stopped: string;
    stoppedDesc: string;
    skipped: string;
    nothingToSkip: string;
    voice: {
      currentTitle: string;
      current: string;
      changeHint: string;
      setTitle: string;
      unknown: string;
      unknownDesc: string;
      credit: string;
      preview: string;
    };
    dict: {
      addedTitle: string;
      added: string;
      updated: string;
      removedTitle: string;
      removed: string;
      notFoundTitle: string;
      notFound: string;
      notOwnerTitle: string;
      notOwner: string;
      fullTitle: string;
      full: string;
      listTitle: string;
      listEmpty: string;
      listMore: string;
      invalidTitle: string;
      invalid: string;
    };
  };
}

/**
 * Flatten nested object keys with dot notation
 * e.g., { common: { error: 'Error' } } -> 'common.error'
 */
type FlattenKeys<T, Prefix extends string = ''> = T extends object
  ? {
      [K in keyof T]: K extends string
        ? T[K] extends object
          ? FlattenKeys<T[K], `${Prefix}${K}.`>
          : `${Prefix}${K}`
        : never;
    }[keyof T]
  : never;

/**
 * All available translation keys as string literals
 */
export type TranslationKey = FlattenKeys<TranslationKeys>;
