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
      'An unexpected error occurred while executing this command.',
    cooldown: 'Please wait {time} seconds before using `/{command}` again.',
    commandBlocked: 'Command Blocked',
    permissionsRequired: 'You need the following permissions: {permissions}',
    permissionsUnverifiable: 'Unable to verify permissions.',
    confirm: 'Confirm',
    cancel: 'Cancel',
    confirmMessage: 'Are you sure you want to proceed?',
    cancelled: 'Action cancelled.',
    nextStep: 'Next step',
  },

  settings: {
    title: 'Server Settings',
    language: {
      name: 'Language',
      changed: 'Language changed to {language}',
      current: 'Current Language',
      auto: 'Automatic (follow each user)',
      autoHint:
        'On automatic, replies use each viewer\u2019s own Discord client language.',
    },
    audit: {
      name: 'Audit Channel',
      notSet: 'Not set',
      configured: 'Audit logs will be sent to <#{channel}>',
      disabled: 'Audit log channel has been removed.',
    },
    announcements: {
      name: 'Announcement Channel',
      notSet: 'Not receiving announcements',
      configured: 'Bot owner announcements will be posted in <#{channel}>',
      disabled: 'This server will no longer receive bot owner announcements.',
    },
    logs: {
      title: 'Audit Logs',
      noLogs: 'No audit logs found for this server.',
      showing: 'Showing {count} of {total} logs',
    },
    overview: 'Overview',
    panel: {
      languagePlaceholder: 'Choose a language...',
      auditPlaceholder: 'Choose an audit channel...',
      clearAudit: 'Clear Audit Channel',
      overviewFooter: 'Manage language, audit, and logs from this panel',
      languageFooter: 'Select a language below to update immediately',
      auditFooter: 'Choose a channel below or clear the current setting',
    },
  },

  roulette: {
    member: {
      title: 'Roulette',
      countdown: '{count}...',
      selecting: 'Selecting from candidates...\n\n[{candidates}]',
      result: 'Roulette Result',
      onlyOne: 'Only one member in the channel!\n\nSelected: {member}',
      footer: 'Selected from {count} members in {channel}',
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
    errors: {
      notInVoice: 'Not in Voice Channel',
      notInVoiceDesc: 'You must be in a voice channel to use this command.',
      noMembers: 'No Members',
      noMembersDesc:
        'No members found in the voice channel (bots are excluded).',
      notEnough: 'Not Enough Members',
      notEnoughDesc:
        'Need at least {required} members for {teams} teams.\nCurrent members: {current} (bots excluded)',
    },
  },

  ping: {
    title: 'Pong!',
    latency: 'Latency',
    apiLatency: 'API Latency',
  },

  poll: {
    ended: 'Poll Ended',
    endedMessage: 'Your poll is closed and its results are final.',
    noActivePoll: 'No Active Poll',
    noActivePollDesc: 'You do not have an open poll in this channel.',
    errors: {
      notEnoughOptions: 'A poll needs at least 2 options.',
      questionTooLong: 'Question must be 300 characters or less.',
      optionTooLong: 'Each option must be 55 characters or less.',
      pollEnded: 'Poll Ended',
      pollEndedDesc: 'This poll has already closed or no longer exists.',
    },
  },

  admin: {
    role: {
      add: {
        success: 'Role Added',
        successDesc: 'Added role **{role}** to **{user}**.',
      },
      remove: {
        success: 'Role Removed',
        successDesc: 'Removed role **{role}** from **{user}**.',
      },
      errors: {
        noPermission:
          'You need the "Manage Roles" permission to use this command.',
        memberNotFound: 'Member not found.',
        botRoleHierarchy:
          "Cannot manage roles higher than the bot's highest role.",
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
      guildsTab: 'Guilds',
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
      memoryLabel: 'Memory',
      nodeLabel: 'Node.js',
      tablesLabel: 'Tables',
      backupSuccess: 'Backup created: `{filename}` ({size} KB)',
      backupFailure: 'Backup failed: {error}',
    },
  },

  owner: {
    errors: {
      ownerOnly: 'Only the bot owner can use this command.',
    },
    broadcast: {
      confirm:
        'This will post the message below in the announcement channel of {count} of {total} servers. Servers that have not set one are skipped.\n\n{message}',
      progress:
        'Broadcast in progress... {processed}/{total}{capNote} (sent {sent}, failed {failed})',
      complete:
        'Broadcast complete\nSent: {sent}\nFailed: {failed}\nNo announcement channel: {skipped}{capNote}',
      capNote:
        '\n\nNote: only the first {limit} of {total} guilds with an announcement channel were processed.',
      noChannel:
        'No server has set an announcement channel yet, so there is nothing to broadcast to. Server admins opt in with `/admin settings announcements`.',
    },
    backup: {
      confirm:
        'A manual database backup will be created immediately. Continue?',
      complete:
        'Backup created successfully.\n\n**Filename:** `{filename}`\n**Size:** {size} KB',
      failed: 'Backup failed: {error}',
    },
  },

  help: {
    title: 'Command List',
    description:
      'List of available commands. Use `/general help` with a command name for details.',
    usage: 'Usage',
    commandNotFound: 'Command Not Found',
    commandNotFoundDesc: 'Command `{command}` does not exist.',
    permission: {
      everyone: 'Everyone',
      manageGuild: 'Manage Server',
      manageRoles: 'Manage Roles',
      owner: 'Bot Owner',
    },
    filteredFooter: 'Showing only commands you can use',
    selectCategory: 'Select a category...',
    showAll: 'Show All',
    onlyCommandUser: 'Only the command user can interact.',
  },

  notification: {
    voice: {
      setTitle: 'VC Notifications Configured',
      set: 'Voice channel notifications will be sent to <#{channel}>',
      removedTitle: 'VC Notifications Disabled',
      removed: 'Voice channel notifications have been disabled.',
      nextStep:
        'Next step: use `/notification status` to review all notification settings together.',
      disabledHint:
        'Next step: use `/notification voice set` to re-enable VC notifications later.',
    },
    welcome: {
      setTitle: 'Welcome Notifications Configured',
      set: 'Member join notifications will be sent to <#{channel}>',
      removedTitle: 'Welcome Notifications Disabled',
      removed: 'Member join notifications have been disabled.',
      nextStep:
        'Next step: use `/notification status` to review all notification settings together.',
      disabledHint:
        'Next step: use `/notification welcome set` to enable member join messages again.',
    },
    status: {
      title: 'Notification Settings',
      voiceLabel: 'VC Join/Leave',
      welcomeLabel: 'Member Join',
      disabled: 'Not configured',
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
    },
    stats: {
      title: 'Your VC Statistics',
      noData: 'No VC session data found.',
      total: 'Total',
      period: 'Period',
      periods: {
        today: 'Today',
        week: 'This week',
        month: 'This month',
        all: 'All time',
      },
    },
    events: {
      voiceJoin: '**{name}** joined <#{channel}>',
      voiceLeave: '**{name}** left <#{channel}>',
      voiceMove: '**{name}** moved from <#{from}> to <#{to}>',
      voiceDigestTitle: 'Voice channel activity',
      memberJoinTitle: 'Welcome!',
      memberJoin: '**{name}** joined the server!',
      memberCount: 'Member Count',
    },
    errors: {
      textChannelOnly: 'Please select a text channel.',
      notConfigured: 'No notification settings to remove.',
      channelNotSendable:
        'The bot cannot send messages to that channel. Please choose another text channel.',
      manageGuildRequired:
        'You need the "Manage Server" permission to change server notification settings.',
    },
  },

  record: {
    autojoin: {
      title: 'Voice auto-join',
      enabled:
        'Auto-join is on for this server. The bot joins occupied voice channels and keeps the last {minutes} minutes of audio.',
      disabled:
        'Auto-join is off for this server. The bot will no longer join voice channels on its own or keep any audio. `/tts start` can still bring it in, deafened, to read chat.',
      excluded:
        'Auto-join now skips <#{channel}>. Audio in that channel is not kept; `/tts start` can still bring the bot in, deafened, to read chat.',
      included: 'Auto-join covers <#{channel}> again.',
      notExcluded: '<#{channel}> was not on the exclusion list.',
      statusEnabled: 'On',
      statusDisabled: 'Off',
      exclusionCount: 'Excluded channels',
      currentChannelBuffered: 'Audio in your current channel is being kept',
      currentChannelExcluded: 'Your current channel is excluded',
      currentChannelReadingOnly:
        'The bot is only reading chat aloud in your current channel; no audio is kept',
      currentChannelNotKept: 'Audio in your current channel is not being kept',
      currentChannelNone: 'You are not in a voice channel',
      readingStopped:
        'Reading in <#{channel}> stopped too, because that connection was keeping audio. `/tts start` resumes reading without keeping any.',
    },
    notice: {
      title: 'Audio is being kept',
      body: 'The last {minutes} minutes of audio in this channel are kept so a server admin can save them with `/voice record`.',
      optOut: 'An admin can stop this with `/voice autojoin exclude`.',
    },
    bufferWindow: 'Buffer window',
    recording: 'Recording...',
    recordingDesc: 'Recording {duration} of past audio.',
    success: 'Recording Complete',
    successDesc: 'Recorded {duration} of past audio.',
    successNextStep:
      'Need capacity details? Use `/voice status` to check active connections and the limit.',
    durationNote:
      'Tip: recordings are limited by the retained audio buffer and 5-minute maximum.',
    statusHint:
      'This status is shown only to you. Use it to check recorder capacity before starting a capture.',
    errors: {
      notInVoice: 'Not in Voice Channel',
      notInVoiceDesc: 'You must be in a voice channel to use this command.',
      botNotInVoice: 'Bot Not in Voice Channel',
      botNotInVoiceDesc: 'Bot is not connected to this voice channel.',
      invalidDuration: 'Invalid Duration',
      invalidDurationDesc: 'Invalid duration format. Examples: 30s, 1m, 5m',
      durationTooLong: 'Duration Too Long',
      durationTooLongDesc: 'Maximum recording duration is {max} seconds.',
      durationExceedsBuffer: 'Duration Exceeds Buffer',
      durationExceedsBufferDesc:
        'Specified duration exceeds the retainable audio window ({buffer} seconds).',
      noAudibleAudio: 'No Audible Audio',
      noAudibleAudioDesc:
        'No usable audio was captured in that window. Speak closer to the mic or try a shorter duration.',
      noPermission: 'No Permission',
      noPermissionDesc: 'Bot does not have permission to send files.',
      deliveryIncomplete: 'Recording Delivery Incomplete',
      deliveryIncompleteDesc:
        'Could not deliver split recording part(s) {parts} of {total}. Retry `/record` for the full audio.',
      failed: 'Recording Failed',
      failedDesc: 'An error occurred while processing the recording: {error}',
    },
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
        'Join the voice channel you want messages read in, then run `/tts start`.',
      busyElsewhere: 'The bot is in another voice channel',
      busyElsewhereDesc:
        'The bot is currently in <#{channel}> (Discord lets a bot be in one voice channel per server). Use it there, or wait until it leaves.',
      cannotJoin: 'Could not join the voice channel',
      cannotJoinDesc:
        'Check that the bot has the Connect permission there and that the connection limit has not been reached.',
      notRunning: 'Nothing is being read',
      notRunningDesc: 'Start reading with `/tts start`.',
      notInSameVoice: 'Not allowed',
      notInSameVoiceDesc:
        'Only members in the voice channel being read (<#{channel}>) or members with Manage Server can do this.',
      stageUnsupported: 'Text-to-speech does not work in Stage channels',
      stageUnsupportedDesc:
        'On a Stage the bot joins as a listener, so nobody would hear it. Run `/tts start` in a regular voice channel.',
    },
    started: 'Text-to-speech started',
    startedDesc:
      'Messages in this channel and in the voice chat of <#{voice}> will be read aloud.',
    startedDescVoiceOnly:
      'Messages in the voice chat of <#{voice}> will be read aloud.',
    howToTitle: 'How it works',
    howTo:
      '• Only messages from people in <#{voice}> are read\n• Start a message with `;` to keep it silent\n• Change your voice and speed with `/tts voice`\n• Teach readings with `/tts dict add`\n• `/tts skip` skips the current message, `/tts stop` ends reading',
    noSpeakPermission:
      '⚠️ The bot lacks the Speak permission in <#{voice}>, so it may not be heard.',
    noViewPermission:
      '⚠️ The bot cannot view this channel, so messages here will not be read; only the voice chat is.',
    credit: 'Voice: {credits}',
    stopped: 'Text-to-speech stopped',
    stoppedDesc: 'Run `/tts start` whenever you want it again.',
    stoppedByOptOut:
      'An admin stopped audio buffering here, so the bot left. Run `/tts start` to resume reading without keeping any audio.',
    skipped: 'Skipped the current message.',
    nothingToSkip: 'Nothing is being read right now.',
    voice: {
      currentTitle: 'Your text-to-speech settings',
      current: 'Voice: **{voice}**\nSpeed: **{speed}x**',
      changeHint:
        'Use the `speaker` option of `/tts voice` to change voice and `speed` (0.5–2.0) to change speed.',
      setTitle: 'Voice updated',
      unknown: 'Voice not found',
      unknownDesc: 'Pick one of the suggestions shown while typing.',
      credit: 'Credit: VOICEVOX:{character}',
      preview: 'この声で読み上げます',
      changed: "<@{user}>'s voice is now **{voice}**.",
    },
    dict: {
      addedTitle: 'Added to the dictionary',
      added: '"{word}" will be read as "{reading}".',
      updated: 'Updated the reading of "{word}" to "{reading}".',
      removedTitle: 'Removed from the dictionary',
      removed: 'Removed "{word}" from the dictionary.',
      notFound: '"{word}" is not in the dictionary.',
      notOwner:
        'Only the member who added a word, or members with Manage Server, can change or remove it.',
      full: 'The dictionary is full ({max} words). Remove unused words with `/tts dict remove`.',
      listTitle: 'Reading dictionary for this server',
      listEmpty: 'No words yet. Add one with `/tts dict add`.',
      listMore: 'and {count} more',
      invalid:
        'Words must be 1–{wordMax} characters and readings 1–{readingMax} characters.',
    },
  },
};
