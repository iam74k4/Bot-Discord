import type { TranslationKeys } from './types.js';

/**
 * English translations
 */
export const en: TranslationKeys = {
  common: {
    error: 'Error',
    warning: 'Warning',
    guildOnly: 'This command can only be used in a server.',
    noPermission: 'You do not have permission to use this command.',
    noData: 'No data',
    unexpectedError:
      'Something went wrong. Please try again in a moment. If it keeps happening, give a server admin this error ID: `{id}`.',
    actionFailed:
      'That action could not be applied. Please try again. If it keeps happening, give a server admin this error ID: `{id}`.',
    cooldownTitle: 'Slow down',
    cooldown: 'You can use {command} again in {seconds}s.',
    permissionDeniedTitle: 'Missing permission',
    permissionsRequired:
      'Required permissions: {permissions}. Ask a server admin if you need it done.',
    permissionsUnverifiable:
      'Your permissions could not be checked. Please try again.',
    permissionNames: {
      Administrator: 'Administrator',
      ManageGuild: 'Manage Server',
      ManageRoles: 'Manage Roles',
      ManageChannels: 'Manage Channels',
      ManageMessages: 'Manage Messages',
      KickMembers: 'Kick Members',
      BanMembers: 'Ban Members',
      ModerateMembers: 'Timeout Members',
      ViewAuditLog: 'View Audit Log',
      ViewChannel: 'View Channels',
      SendMessages: 'Send Messages',
      EmbedLinks: 'Embed Links',
      AttachFiles: 'Attach Files',
      Connect: 'Connect',
      Speak: 'Speak',
      MoveMembers: 'Move Members',
    },
    serverOnlyTitle: 'Server only',
    confirm: 'Confirm',
    cancel: 'Cancel',
    confirmMessage: 'Are you sure you want to proceed?',
    cancelled: 'Action cancelled.',
    nextStep: 'Next step',
    timedOutTitle: 'Timed out',
    confirmTimedOut: 'No response within {seconds}s, so nothing was done.',
    confirmTimedOutRetry:
      'No response within {seconds}s, so nothing was done. Run {command} again if you still need it.',
    promptClosedTitle: 'Prompt closed',
    confirmInterrupted:
      'This prompt was closed because the bot is restarting. Nothing was done.',
    confirmInterruptedRetry:
      'This prompt was closed because the bot is restarting. Nothing was done. If you still need it, run {command} again in a moment.',
    onlyCommandUser:
      'This menu belongs to {user}. Run {command} to open your own.',
    onlyCommandUserGeneric: 'This menu belongs to {user}.',
    panelExpired: '⏱ This panel has expired. Run {command} again to continue.',
    panelExpiredGeneric:
      '⏱ This panel has expired. Run the command again to continue.',
    componentExpired:
      'These buttons have expired (the bot restarted or time ran out). Run {command} again.',
    componentExpiredGeneric:
      'These buttons have expired (the bot restarted or time ran out). Run the command again.',
    componentNotReady:
      'The bot is restarting. Please try again in a few seconds.',
    formExpired:
      'This form has expired (the bot restarted or time ran out), so what you entered was not saved. Run the command again.',
    notSet: 'Not set',
    notSetWithHint: 'Not set (set it up with {command})',
    duration: {
      pair: '{first} {second}',
      short: {
        hours: '{count}h',
        minutes: '{count}m',
        seconds: '{count}s',
        lessThanMinute: '<1m',
      },
      long: {
        hoursOne: '{count} hour',
        hoursOther: '{count} hours',
        minutesOne: '{count} minute',
        minutesOther: '{count} minutes',
        secondsOne: '{count} second',
        secondsOther: '{count} seconds',
        lessThanMinute: 'less than a minute',
      },
    },
  },

  settings: {
    title: 'Server Settings',
    language: {
      name: 'Language',
      changed: 'Language changed to {language}',
      current: 'Current Language',
      auto: 'Automatic (follow each user)',
      autoHint:
        'On automatic, command replies use each viewer\u2019s own Discord language. Posts to channels (VC and welcome notifications, audit logs) are in **{lang}** (community servers follow Discord\u2019s server language). To fix the language of posts, pick English or \u65e5\u672c\u8a9e below (command replies will then use it for everyone too).',
    },
    audit: {
      name: 'Audit Channel',
      notSet: 'Not set',
      configured: 'Audit logs will be sent to <#{channel}>',
      disabled: 'The audit log channel has been cleared.',
    },
    announcements: {
      name: 'Announcement Channel',
      notSet: 'Not receiving announcements',
      configured: 'Bot operator announcements will be posted in <#{channel}>',
      disabled:
        'This server will no longer receive bot operator announcements.',
    },
    logs: {
      title: 'Audit Logs',
      noLogs: 'No audit logs found for this server.',
      showingRange: 'Showing {from}\u2013{to} of {total}',
    },
    panel: {
      tabOverview: 'Overview',
      tabLanguage: 'Language',
      tabAudit: 'Audit channel',
      tabAnnouncements: 'Announcements',
      tabLogs: 'Audit log',
      languagePlaceholder: 'Choose a language...',
      auditPlaceholder: 'Choose a channel for audit logs...',
      announcementPlaceholder: 'Choose a channel for announcements...',
      clearAudit: 'Stop audit logging',
      clearAnnouncements: 'Stop announcements',
      prevPage: '\u25c0 Prev',
      nextPage: 'Next \u25b6',
      overviewFooter:
        'Change the language, audit log and announcements from this panel',
      languageFooter: 'Pick a language below; it applies right away',
      auditFooter: 'Choose a channel below or clear the current setting',
      announcementsFooter:
        'Pick a channel below to receive bot operator announcements there',
    },
    errors: {
      channelNotSendable:
        'The bot cannot post in that channel. Please choose another text channel.',
      channelMissingPermissions:
        "The bot can't post in <#{channel}>. Missing: {permissions}. Allow them for the bot's role under Edit Channel \u2192 Permissions, then try again.",
    },
  },

  roulette: {
    member: {
      title: 'Roulette',
      countdown: '{count}...',
      selecting: 'Picking from the candidates...\n\n[{candidates}]',
      result: 'Roulette Result',
      winner: '🎉 **{name}** ({mention}) was picked!',
      onlyOne:
        '**{name}** ({mention}) is the only one in the voice channel, so they are picked!',
      footer: 'Picked from {count} members in {channel}',
      footerExcluded:
        'Picked from {count} members in {channel} ({excluded} excluded)',
    },
    team: {
      title: 'Team Assignment',
      shuffling:
        'Shuffling {count} members into {teams} teams...\n\n[{candidates}]',
      result: 'Team Assignment Result',
      resultDesc: '{count} members divided into {teams} teams!',
      teamName: 'Team {number} ({count} members)',
      noMembers: 'No members',
      footer: 'Members from {channel}',
    },
    andMore: '…and {count} more',
    buttons: {
      again: 'Spin again',
      excludeWinner: 'Re-draw without the winner',
      reshuffle: 'Reshuffle teams',
    },
    errors: {
      notInVoice: 'Not in a Voice Channel',
      notInVoiceDesc: 'Join a voice channel first, then try again.',
      noMembers: 'No Members',
      noMembersDesc:
        'No members found in the voice channel (bots are excluded).',
      notEnough: 'Not Enough Members',
      notEnoughDesc:
        'Need at least {required} members for {teams} teams.\nCurrent members: {current} (bots excluded)',
      onlyParticipants: 'Only people in <#{channel}> can re-draw.',
      noCandidatesLeft:
        'No one is left to pick (excluded members and bots are skipped).',
    },
  },

  ping: {
    title: 'Pong!',
    latency: 'Latency',
    apiLatency: 'API Latency',
    notMeasured: 'Not measured yet (just connected)',
  },

  about: {
    title: 'About this bot',
    description:
      'Voice join/leave notices, welcome messages, voice time stats, polls, roulette, text-to-speech and voice recording (admins only). See every command with {help}.',
    popularTitle: 'Popular commands',
    voiceTitle: 'Voice audio in this server',
    voiceOn:
      'Voice auto-join is on. The bot joins occupied voice channels (except ones admins excluded) and keeps only the last {duration} of audio in memory (older audio is overwritten). Admins can turn this off with {disable}.',
    voiceOff:
      'Voice auto-join is off, so the bot keeps no audio (admins can turn it on with {enable}).',
    recordings:
      'A recording file is made only when an admin uses {record}. The bot deletes its own copy after about {retention} (the file sent on Discord stays).',
    languageTitle: 'Language',
    languageGuild: '{language} (set for this server)',
    languageAuto: "{language} (follows each member's Discord language)",
    languageChange: 'Admins can change it with {command}.',
  },

  poll: {
    ended: 'Poll Ended',
    endedMessage: 'Your poll is closed and its results are final.',
    noActivePoll: 'No Open Poll',
    noActivePollDesc:
      'You have no open poll in this server. Create one with {command}.',
    createdHint: 'Poll created. To close it early, run {command}.',
    endChoice: '#{channel} · {remaining} left',
    confirm: {
      title: 'End this poll?',
      body: 'Results become final right away, and the poll cannot be reopened.',
      inChannel: 'This poll is in <#{channel}>.',
      confirm: 'End poll',
      cancel: 'Keep open',
    },
    modal: {
      title: 'Create a poll',
      question: 'Question',
      options: 'Options',
      optionsDescription:
        'One per line, 2 to 10 options (up to 55 characters each)',
      optionsPlaceholder: 'Ramen\nCurry\nSushi',
      duration: 'Duration',
      multi: 'Allow multiple answers',
      retry: 'Edit and try again',
      retryHint:
        'Press "Edit and try again" to reopen the form with what you entered.',
    },
    durations: {
      oneHour: '1 hour',
      fourHours: '4 hours',
      eightHours: '8 hours',
      oneDay: '24 hours',
      threeDays: '3 days',
      sevenDays: '7 days',
    },
    errors: {
      createFailed: "Couldn't create the poll",
      notEnoughOptions: 'Enter at least 2 options.',
      tooManyOptions: 'A poll can have up to 10 options ({count} entered).',
      optionLineTooLong:
        'The option on line {line} is longer than 55 characters ({length}).',
      questionMissing: 'Enter a question.',
      questionTooLong: 'Question must be 300 characters or less.',
      optionTooLong: 'Each option must be 55 characters or less.',
      pollEnded: 'Poll Already Closed',
      pollEndedDesc: 'This poll has already closed or was deleted.',
      endFailed: "Couldn't end the poll",
      noAccessDesc:
        "The bot can't read messages in <#{channel}>. Check that it has the View Channel and Read Message History permissions there. If you can't change permissions, ask a server admin.",
      pickedNotFound: 'Poll Not Found',
      pickedNotFoundDesc:
        "That poll wasn't found or has already closed. Pick one from the suggestions for the poll option.",
    },
  },

  admin: {
    role: {
      add: {
        success: 'Role Added',
        successDesc: 'Added <@&{roleId}> to <@{userId}> (**{displayName}**).',
      },
      remove: {
        success: 'Role Removed',
        successDesc:
          'Removed <@&{roleId}> from <@{userId}> (**{displayName}**).',
      },
      errors: {
        memberNotFound: 'Member not found.',
        everyoneRole:
          'Every member has @everyone, so it cannot be added or removed.',
        managedRole:
          '"{role}" is managed automatically by Server Boosts or an integration, so it cannot be added or removed by hand.',
        botMissingManageRoles:
          'The bot is missing the Manage Roles permission. Turn it on under Server Settings → Roles → "{botRole}".',
        botRoleHierarchy:
          '"{role}" is at or above the bot\'s role "{botRole}", so the bot cannot manage it. Drag "{botRole}" above "{role}" under Server Settings → Roles.',
        actorRoleHierarchy:
          'You can only manage roles lower than your highest role.',
        targetMemberHierarchy:
          'You can only manage members with a lower highest role than yours.',
        botTargetMemberHierarchy:
          "Cannot manage members at or above the bot's highest role.",
        alreadyHasRole: 'This member already has that role.',
        doesNotHaveRole: 'This member does not have that role.',
        failed: 'Failed to modify role.',
      },
    },
    panel: {
      statsTab: 'Stats',
      dbTab: 'DB',
      guildsTab: 'Servers',
      healthTab: 'Health',
      metricsTab: 'Metrics',
      backupsTab: 'Backups',
      refresh: 'Refresh',
      runBackup: 'Run Backup',
      statsTitle: 'Bot Statistics',
      dbTitle: 'Database Statistics',
      guildsTitle: 'Server List',
      healthTitle: 'System Health Check',
      metricsTitle: 'Bot Metrics',
      backupsTitle: 'Database Backups',
      backupsFooter: 'Use the button below to run a manual backup',
      serversLabel: 'Servers',
      usersLabel: 'Users',
      channelsLabel: 'Channels',
      uptimeLabel: 'Uptime',
      uptimeDays: '{count}d',
      memoryLabel: 'Memory',
      nodeLabel: 'Node.js',
      environmentLabel: 'Environment',
      commandsLabel: 'Commands',
      tablesLabel: 'Tables',
      backupSuccess: 'Backup created: `{filename}` ({size} KB)',
      backupFailure: 'Backup failed: {error}',
      noBackups: 'No backups yet.',
      moreBackups: '…and {count} more',
    },
  },

  owner: {
    errors: {
      ownerOnly: 'Only the bot operator can use this command.',
    },
    broadcast: {
      confirmTitle: 'Post this announcement?',
      confirmLabel: 'Post',
      confirm:
        'This will post the message below in the announcement channel of {count} of {total} servers. Servers that have not set one are skipped.\n\n{message}',
      progress:
        'Broadcast in progress... {processed}/{total} ({capNote}sent {sent}, failed {failed})',
      progressCap: 'capped at {limit} of {total} servers, ',
      completeTitle: 'Broadcast Complete',
      complete:
        'Sent: {sent}\nFailed: {failed}\nNo announcement channel: {skipped}{capNote}',
      capNote:
        '\n\nNote: only the first {limit} of {total} servers with an announcement channel were processed.',
      noChannel:
        'No server has set an announcement channel yet, so there is nothing to broadcast to. Server admins opt in with {command}.',
      embedTitle: 'Announcement from the bot operator',
      embedFooter:
        'To stop these, a server admin can run /admin settings announcements without a channel',
      failures: '\n\n**Not delivered to**\n{list}',
      moreFailures: '…and {count} more',
      failureReasons: {
        notSendable:
          "can't post in the channel (deleted, or missing permissions)",
        timeout: 'no response',
        sendFailed: 'sending failed',
      },
    },
    backup: {
      confirmTitle: 'Create a backup now?',
      confirmLabel: 'Back up',
      confirm: 'A database backup will be created right away.',
      running: '⏳ Running a backup...',
      completeTitle: 'Backup Complete',
      complete:
        'Backup created successfully.\n\n**Filename:** `{filename}`\n**Size:** {size} KB',
      failedTitle: 'Backup Failed',
      failed: 'Backup failed: {error}',
      noReason: 'No reason was recorded. Check the logs.',
    },
  },

  audit: {
    actions: {
      NOTIFY_SETUP: 'Notification Setup',
      NOTIFY_ENABLE: 'Notifications Enabled',
      NOTIFY_DISABLE: 'Notifications Disabled',
      NOTIFY_REMOVE: 'Notification Settings Removed',
      SETTINGS_CHANGE: 'Settings Changed',
      AUDIT_SETUP: 'Audit Log Configured',
      ROLE_ADD: 'Role Added',
      ROLE_REMOVE: 'Role Removed',
    },
    fields: {
      user: 'User',
      target: 'Target',
      details: 'Details',
    },
    userWithName: '{mention} ({name})',
    kinds: {
      Voice: 'Voice',
      Welcome: 'Welcome',
    },
    details: {
      notifySetup: '{kind} notifications → <#{channel}>',
      notifyChannel: 'Channel: <#{channel}>',
      notifyRemove: '{kind} notifications turned off',
      auditChannelCleared: 'Audit log channel cleared',
      announcementChannelSet: 'Announcement channel: <#{channel}>',
      announcementChannelCleared: 'Stopped receiving announcements',
      language: 'Language changed to {language}',
      role: 'Role: <@&{roleId}> ({roleName})',
    },
  },

  help: {
    title: 'Command List',
    description:
      'Commands you can use. Pick one from the menu below to see how to use it.',
    descriptionNoMenu: 'Commands you can use.',
    usage: 'Usage',
    examples: 'Examples',
    commandNotFound: 'Command Not Found',
    commandNotFoundDesc: 'Command `{command}` does not exist.',
    noMatch: 'No command matches `{query}`.',
    didYouMean: 'Did you mean {suggestion}?',
    noMatchHint:
      'Run {help} without a command to list everything you can use. Commands that need a permission are only shown to people who have it.',
    matchesTitle: 'Commands matching "{query}"',
    matchesHint:
      'Pick a command from the suggestions while typing to see how to use it.',
    requires: 'Requires: {permissions}',
    optionLine: '• `{name}`{required}: {description}',
    optionRequired: ' (required)',
    optionChoices: ' (choices: {choices})',
    permission: {
      everyone: 'Everyone',
      manageGuild: 'Manage Server',
      manageRoles: 'Manage Roles',
      administrator: 'Administrator',
      owner: 'Bot Operator',
    },
    filteredFooter: 'Showing only commands you can use',
    selectCategory: 'Select a category...',
    selectCommand: 'Pick a command for details...',
    showAll: 'Show All',
    back: 'Back to the list',
  },

  notification: {
    voice: {
      setTitle: 'VC Notifications Configured',
      set: 'Voice channel notifications will be sent to <#{channel}>',
      removedTitle: 'VC Notifications Disabled',
      removed: 'Voice channel notifications have been disabled.',
      nextStep:
        'Next step: use {command} to review all notification settings together.',
      disabledHint:
        'Next step: use {command} to re-enable VC notifications later.',
      alreadyDisabled:
        'VC join/leave notifications are already off. Use {command} to turn them back on.',
    },
    welcome: {
      setTitle: 'Welcome Notifications Configured',
      set: 'Member join notifications will be sent to <#{channel}>',
      removedTitle: 'Welcome Notifications Disabled',
      removed: 'Member join notifications have been disabled.',
      nextStep:
        'Next step: use {command} to review all notification settings together.',
      disabledHint:
        'Next step: use {command} to enable member join messages again.',
      alreadyDisabled:
        'Welcome messages are already off. Use {command} to turn them back on.',
    },
    language: {
      line: 'Notification language: {language}',
      autoHint:
        'The server language is set to automatic, so notifications are posted in {language}. To change it, pick a language with {command} (command replies will then use it for everyone too).',
    },
    status: {
      title: 'Notification Settings',
      voiceLabel: 'VC Join/Leave',
      welcomeLabel: 'Member Join',
      disabled: 'Not configured',
      postLanguage: 'Notification language',
    },
    panel: {
      statusTab: 'Settings',
      statsTab: 'Stats',
      periodPlaceholder: 'Choose a stats period...',
      voicePlaceholder: 'Select a channel for VC notifications...',
      welcomePlaceholder: 'Select a channel for welcome notifications...',
      removeVoice: 'Disable VC Notifications',
      removeWelcome: 'Disable Welcome Notifications',
      statusDescription:
        'You can update notification channels directly from this panel.',
      confirmRemove:
        'Turn off {type} notifications (<#{channel}>)? Nothing more will be posted there.',
      confirmRemoveButton: 'Turn off',
      cancelRemoveButton: 'Back',
      changed: '✅ {type} notifications will now go to <#{channel}>.',
      removed:
        '🗑 {type} notifications are off (they went to <#{channel}>). Pick a channel below to turn them back on.',
    },
    stats: {
      title: 'Your VC Statistics',
      noData:
        'No VC time recorded yet ({period}).\nJoin a voice channel and your time will show up here.',
      noDataInPeriodHint:
        'Switch the period to "{all}" to see your earlier time.',
      liveSession:
        '🔊 You are in <#{channel}> now ({duration} so far). This time is included below.',
      live: ' (in VC now)',
      sessions: ' ({count}x)',
      more: '…and {count} more',
      dayBoundaryJapan: 'Days start at 00:00 Japan time (JST)',
      dayBoundary: 'Days start at 00:00 {zone}',
      total: 'Total',
      period: 'Period',
      periods: {
        today: 'Today',
        week: 'Last 7 days',
        month: 'Last 30 days',
        all: 'All time',
      },
    },
    events: {
      voiceJoin: '🟢 **{name}** joined <#{channel}>',
      voiceLeave: '🔴 **{name}** left <#{channel}>',
      voiceMove: '🔁 **{name}**: <#{from}> → <#{to}>',
      voiceDigestTitle: 'Voice channel activity',
      memberJoinTitle: 'New member',
      memberJoin: '**{name}**, welcome! 🎉\nYou are member **#{count}**.',
      memberJoinRules: 'Please start by reading <#{channel}>.',
    },
    summary: {
      voice: 'VC join/leave notifications',
      welcome: 'Welcome messages',
    },
    errors: {
      textChannelOnly: 'Please select a text channel.',
      channelNotSendable:
        'The bot cannot send messages to that channel. Please choose another text channel.',
      channelMissingPermissions:
        "The bot can't post in <#{channel}>. Missing: {permissions}. Allow them for the bot's role under Edit Channel → Permissions, then try again.",
    },
  },

  record: {
    autojoin: {
      title: 'Voice auto-join',
      enabled:
        "Auto-join is on for this server. The bot joins an occupied voice channel and keeps the last {minutes} minutes of audio. It joins one voice channel per server and posts a notice in that channel's chat.",
      joinedNow:
        'Joined <#{channel}> and started keeping its audio. Nothing from before now can be saved.',
      waitingForMembers:
        'No voice channel is occupied right now; the bot joins when someone does.',
      disabled:
        'Auto-join is off for this server. The bot will not join voice channels or keep any audio. Use {command} to turn it back on.',
      disabledDropped:
        'The bot left its voice channel and discarded the audio it was keeping.',
      excluded:
        'Auto-join now skips <#{channel}>. Audio in that channel is not kept.',
      alreadyExcluded: '<#{channel}> is already excluded from auto-join.',
      excludedLeft:
        'The bot left <#{channel}> and discarded the audio it was keeping.',
      included: 'Auto-join covers <#{channel}> again.',
      includedWhileOff:
        'Auto-join is still off for the whole server, though. Turn it on with {command}.',
      notExcluded: '<#{channel}> was not on the exclusion list.',
      alreadyReadOnly:
        'The bot is in <#{channel}> only to read chat aloud, so no audio is kept yet. Once reading ends and the bot leaves, keeping starts the next time someone joins a voice channel.',
      statusEnabled: 'On',
      statusDisabled: 'Off',
      exclusions: 'Excluded channels',
      exclusionsNone: 'None',
      exclusionsMore: '+{count} more',
      currentChannelBuffered:
        '✅ Audio in <#{channel}> is being kept (you can save the last {available} right now).',
      currentChannelListening:
        '✅ Audio in <#{channel}> is being kept (nobody has been heard yet).',
      currentChannelExcluded: '⏸ <#{channel}> is excluded from auto-join.',
      currentChannelNotBuffered:
        '⚠️ Audio in <#{channel}> is not being kept. {reason}',
      currentChannelNone: 'You are not in a voice channel.',
    },
    notice: {
      title: '🎙️ Audio in this channel is briefly kept',
      body: 'The bot keeps only the last {minutes} minutes in memory and keeps overwriting it. Nothing is saved unless a server admin runs {command}; the file goes only to them and is deleted from the bot after about {hours} hours.',
      optOut:
        'Prefer not? Ask a server admin. Admins can exclude this channel with the button below ({command} stops it for the whole server).',
      optOutButton: 'Exclude this channel',
      optOutNotAllowed:
        'Only admins with the Manage Server permission can use this button. Let a server admin know if this concerns you.',
      optedOut: '🔕 <#{channel}> is now excluded (set by {user}).',
      optedOutLeft: 'The bot left and discarded the audio it was keeping.',
      channelStatus: '🔴 Bot is keeping the last {minutes} min of audio',
    },
    notBuffered: {
      autoJoinOff:
        'Auto-join is off on this server, so no audio is kept. Turn it on with {command} to record conversations from then on.',
      excluded:
        '<#{channel}> is excluded from auto-join. {command} brings it back.',
      busyElsewhere:
        'The bot is keeping audio in <#{other}> on this server (it can be in one voice channel per server). Run this there, or wait until that channel empties.',
      readOnly:
        'The bot is in <#{channel}> only to read chat aloud, so it keeps no audio. Once reading ends and the bot leaves, auto-join starts keeping audio the next time someone joins a voice channel.',
      atLimit:
        'The bot is in as many voice channels as it may be ({max}), so it could not join this one. Try again in a while.',
      noPermission:
        "The bot lacks View Channel or Connect in <#{channel}>. Allow them for the bot's role under Edit Channel → Permissions.",
      notYetJoined:
        'The bot has not joined this channel yet. Leave and rejoin the voice channel to bring it in; audio from then on can be recorded.',
      startedTitle: 'Started keeping audio',
      startedNow:
        'The bot joined this channel and started keeping its audio. Only audio from now on can be recorded, so talk for a while and run this again.',
      beforeJoinNote: 'Audio from before the bot joined cannot be saved.',
    },
    status: {
      title: 'Voice status',
      botChannel: "Bot's voice channel here",
      capacity: 'Bot capacity',
      capacityAvailable: 'Available',
      capacityFull: 'Full (at the connection limit)',
      saveLimit: 'Longest save',
      saveLimitValue:
        'Up to {max} (recordings over {limit} MB are sent as several files)',
      noticeNoPermission:
        '⚠️ The notice could not be posted in <#{channel}>. Give the bot Send Messages in that channel.',
      noticeSendFailed:
        '⚠️ Posting the notice in <#{channel}> failed. The bot tries again the next time it joins.',
    },
    panel: {
      enable: 'Turn auto-join on',
      disable: 'Turn auto-join off',
      confirmDisable: 'Turn off (discards kept audio)',
      cancelDisable: 'Keep it on',
      confirmDisablePrompt:
        'Turning it off makes the bot leave its voice channel and discard the audio it kept. Press "Turn off" to confirm.',
      disabled: 'Voice auto-join is now off.',
      exclusionsPlaceholder: 'Voice channels to skip (pick any)',
      exclusionsUpdated:
        '✅ Excluded channels updated. Added: {added} / Removed: {removed}',
      nothingChanged: 'Nothing changed.',
      tooManyExclusions:
        'Too many channels are excluded to pick them here. Use {exclude} or {include} instead.',
      hiddenExclusions:
        '{count} excluded channel(s) you cannot view are not shown in the menu. The menu never lifts their exclusion.',
    },
    audit: {
      autoJoinEnabled: 'Voice auto-join turned on ({via})',
      autoJoinDisabled: 'Voice auto-join turned off ({via})',
      channelExcluded: 'Excluded <#{channel}> from voice auto-join ({via})',
      channelIncluded: 'Re-included <#{channel}> in voice auto-join ({via})',
      exclusionsChanged:
        'Voice auto-join exclusions changed: added {added} / removed {removed} ({via})',
      viaCommand: 'with {command}',
      viaPanel: 'in the {command} panel',
      viaNoticeButton: 'with the button on the notice',
    },
    recording: '⏳ Saving…',
    recordingDesc: 'Putting the last {duration} of audio into a file.',
    inProgressNote:
      'The file will be attached to this message when it is ready (only you can see it).',
    success: 'Recording saved',
    successDesc: 'Saved the last {duration} of audio.',
    trimmedNote:
      'The bot has only been hearing this channel for {available}, so {available} was saved.',
    saveWarning:
      'Only you can see this message, and it disappears when Discord reloads. Save the file now.',
    fileSize: 'File size: {size} MB',
    fileSizeSplit: 'Total {size} MB (split into {count} files)',
    partLabel: 'Part {part} of {total} ({from}–{to})',
    partLabelShort: 'Part {part} of {total}',
    statusHint: 'Only you can see this.',
    errors: {
      notInVoice: 'Not in a voice channel',
      notInVoiceDesc:
        'Join the voice channel you want to record, then run this again.',
      notVoiceChannel: 'Only voice and stage channels can be chosen.',
      notBuffered: 'This voice channel is not being kept',
      botUnavailable:
        "Could not check the bot's state. Try again in a few seconds.",
      invalidDuration: 'Invalid duration',
      invalidDurationDesc: 'Pick one of the listed durations.',
      durationTooLong: 'Duration too long',
      durationTooLongDesc: 'Recordings can be at most {max}.',
      durationExceedsBuffer: 'Longer than the audio kept',
      durationExceedsBufferDesc:
        'The bot only keeps the last {buffer} of audio.',
      noAudibleAudio: 'No audio found',
      noAudibleAudioDesc:
        'Nobody was heard in the last {duration}. Audio from before the bot joined cannot be saved.',
      noAudibleAudioLongerHint:
        'To save an earlier conversation, pick a longer duration.',
      noPermission: 'Cannot send files here',
      noPermissionDesc:
        'The bot lacks Attach Files in this channel (<#{channel}>). Run this in another channel, or ask a server admin to grant it.',
      deliveryIncomplete: 'Some files could not be sent',
      deliveryIncompleteDesc:
        'Could not send part(s) {parts} of {total}. The kept audio keeps moving, so run {command} again right away if you need the full audio.',
      busy: 'Another recording is being saved',
      busyDesc:
        'Another recording of this voice channel is being saved. Try again in a few seconds.',
      tooLarge: 'File too large',
      tooLargeDesc:
        "The recording ({size} MB) is over this server's upload limit ({limit} MB). Run {command} again with a shorter duration.",
      failed: 'Could not save the recording',
      failedDesc:
        'Saving the recording failed. Please try again; if it keeps happening, give a server admin the error ID `{id}`.',
    },
  },

  onboarding: {
    title: 'Thanks for adding the bot',
    description:
      'Voice join/leave notices, welcome messages, voice time stats, polls, roulette, text-to-speech and voice recording (admins only). See every command with {help}.',
    bufferingTitle: 'About keeping voice audio',
    buffering:
      'By default the bot joins occupied voice channels and keeps the last {minutes} minutes of audio in memory, so admins can save it with {record}. Turn this off with {disable}, or skip single channels with {exclude}.',
    setupTitle: 'Getting started',
    setup:
      '1. {language} display language\n2. {voice} voice join/leave notices\n3. {welcome} welcome messages\n4. {audit} audit log\n5. {announcements} announcements',
    missingTitle: 'Missing permissions',
    missingLine: '• {permission}: {effect}',
    missing: {
      ViewChannel: 'the bot cannot see channels, so most features fail',
      Connect:
        'the bot cannot join voice channels, so auto-join, recording and text-to-speech fail',
      SendMessages: 'notices and announcements cannot be posted',
      EmbedLinks: 'notices and announcements cannot be shown properly',
      AttachFiles: 'recordings cannot be sent',
      ManageRoles: '{command} does not work',
    },
    footer: 'This message is sent once, when the bot joins a server.',
  },

  tts: {
    errors: {
      notConfigured: 'Text-to-speech is not set up',
      notConfiguredDesc:
        'This bot has no speech engine (VOICEVOX) configured. Ask the bot operator to set `VOICEVOX_URL`.',
      engineDown: 'Cannot reach the speech engine',
      engineDownDesc:
        'VOICEVOX is not responding. Try again in a moment, and contact the bot operator if it keeps happening.',
      notInVoice: 'Join a voice channel first',
      notInVoiceDesc:
        'Join the voice channel you want messages read in, then run {command}.',
      busyElsewhere: 'The bot is in another voice channel',
      busyElsewhereDesc:
        'The bot is currently in <#{channel}> (Discord lets a bot be in one voice channel per server). Use it there, or wait until it leaves.',
      cannotJoin: 'Could not join the voice channel',
      cannotJoinDesc:
        'Check that the bot has the Connect permission there and that the connection limit has not been reached.',
      notRunning: 'Nothing is being read',
      notRunningDesc: 'Start reading with {command}.',
      notInSameVoice: 'Not allowed',
      notInSameVoiceDesc:
        'Only members in the voice channel being read (<#{channel}>) or members with {permission} can do this.',
    },
    started: 'Text-to-speech started',
    startedDesc:
      'Messages in this channel and in the voice chat of <#{voice}> will be read aloud.',
    howToTitle: 'How it works',
    howTo:
      '• Only messages from people in <#{voice}> are read\n• Start a message with `;` to keep it silent\n• Change your voice and speed with {voiceCommand}\n• Teach readings with {dictCommand}\n• {skipCommand} skips the current message, {stopCommand} ends reading',
    noSpeakPermission:
      '⚠️ The bot lacks the Speak permission in this channel, so it may not be heard.',
    credit: 'Voice: VOICEVOX',
    stopped: 'Text-to-speech stopped',
    stoppedDesc: 'Run {command} whenever you want it again.',
    skipped: 'Skipped the current message.',
    nothingToSkip: 'Nothing is being read right now.',
    voice: {
      currentTitle: 'Your text-to-speech settings',
      current: 'Voice: **{voice}**\nSpeed: **{speed}x**',
      changeHint:
        'Use the `speaker` option of {command} to change voice and `speed` (0.5–2.0) to change speed.',
      setTitle: 'Voice updated',
      unknown: 'Voice not found',
      unknownDesc: 'Pick one of the suggestions shown while typing.',
      credit: 'Credit: VOICEVOX:{character}',
      preview: 'この声で読み上げます',
    },
    dict: {
      addedTitle: 'Added to the dictionary',
      added: '"{word}" will be read as "{reading}".',
      updated: 'Updated the reading of "{word}" to "{reading}".',
      removedTitle: 'Removed from the dictionary',
      removed: 'Removed "{word}" from the dictionary.',
      notFoundTitle: 'Word not in the dictionary',
      notFound: '"{word}" is not in the dictionary.',
      notOwnerTitle: 'You cannot remove this word',
      notOwner:
        'Only the member who added a word, or members with {permission}, can remove it.',
      fullTitle: 'The dictionary is full',
      full: 'The dictionary is full ({max} words). Remove unused words with {command}.',
      listTitle: 'Reading dictionary for this server',
      listEmpty: 'No words yet. Add one with {command}.',
      listMore: 'and {count} more',
      invalidTitle: 'Check what you entered',
      invalid:
        'Words must be 1–{wordMax} characters and readings 1–{readingMax} characters.',
    },
  },
};
