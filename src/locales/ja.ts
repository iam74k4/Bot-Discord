import type { TranslationKeys } from './types.js';

/**
 * Japanese translations
 */
export const ja: TranslationKeys = {
  common: {
    error: 'エラー',
    warning: '警告',
    guildOnly: 'このコマンドはサーバー内でのみ使用できます。',
    noPermission: 'このコマンドを使用する権限がありません。',
    noData: 'データなし',
    unexpectedError: 'コマンドの実行中に予期しないエラーが発生しました。',
    cooldown: '`/{command}` を再使用するには {time} 秒お待ちください。',
    commandBlocked: 'コマンドがブロックされました',
    permissionsRequired: '次の権限が必要です: {permissions}',
    permissionsUnverifiable: '権限を確認できません。',
    confirm: '確認',
    cancel: 'キャンセル',
    confirmMessage: '本当に実行しますか？',
    cancelled: 'キャンセルしました。',
    nextStep: '次のおすすめ',
  },

  settings: {
    title: 'サーバー設定',
    language: {
      name: '言語',
      changed: '言語を {language} に変更しました',
      current: '現在の言語',
      auto: '自動（ユーザーに合わせる）',
      autoHint:
        '「自動」の場合、各ユーザーのDiscordクライアントの言語で表示します。',
    },
    audit: {
      name: '監査ログチャンネル',
      notSet: '未設定',
      configured: '監査ログを <#{channel}> に送信します',
      disabled: '監査ログチャンネルを削除しました。',
    },
    announcements: {
      name: 'お知らせチャンネル',
      notSet: 'お知らせを受け取らない',
      configured: 'Bot オーナーからのお知らせを <#{channel}> に投稿します',
      disabled: 'このサーバーは Bot オーナーからのお知らせを受け取りません。',
    },
    logs: {
      title: '監査ログ',
      noLogs: 'このサーバーの監査ログはありません。',
      showing: '{total}件中{count}件を表示',
    },
    overview: '概要',
    panel: {
      languagePlaceholder: '言語を選択...',
      auditPlaceholder: '監査ログのチャンネルを選択...',
      clearAudit: '監査チャンネルを解除',
      overviewFooter: 'このパネルから言語・監査・ログを管理できます',
      languageFooter: '下のセレクトから即時に言語を更新できます',
      auditFooter: '下のセレクトで設定、または現在の設定を解除できます',
    },
  },

  roulette: {
    member: {
      title: 'ルーレット',
      countdown: '{count}...',
      selecting: '候補から選択中...\n\n[{candidates}]',
      result: 'ルーレット結果',
      onlyOne:
        'チャンネルにはメンバーが1人しかいません！\n\n選ばれたのは: {member}',
      footer: '{channel}の{count}人のメンバーから選択',
    },
    team: {
      title: 'チーム分け',
      shuffling:
        '{count}人のメンバーを{teams}チームにシャッフル中...\n\n[{candidates}]',
      result: 'チーム分け結果',
      resultDesc: '{count}人のメンバーを{teams}チームに分けました！',
      teamName: 'チーム{number} ({count}人)',
      noMembers: 'メンバーなし',
      footer: '{channel}のメンバー',
    },
    errors: {
      notInVoice: 'ボイスチャンネル未参加',
      notInVoiceDesc:
        'このコマンドを使用するにはボイスチャンネルに参加してください。',
      noMembers: 'メンバーがいません',
      noMembersDesc: 'ボイスチャンネルにメンバーがいません（Botは除外）。',
      notEnough: 'メンバーが不足しています',
      notEnoughDesc:
        '{teams}チームには最低{required}人のメンバーが必要です。\n現在のメンバー: {current}人（Bot除外）',
    },
  },

  ping: {
    title: 'Pong!',
    latency: 'レイテンシ',
    apiLatency: 'API レイテンシ',
  },

  poll: {
    ended: '投票が終了しました',
    endedMessage: '投票を締め切りました。結果が確定しました。',
    noActivePoll: '受付中の投票がありません',
    noActivePollDesc:
      'このチャンネルにあなたが作成した受付中の投票はありません。',
    errors: {
      notEnoughOptions: '投票には最低2つの選択肢が必要です。',
      questionTooLong: '質問は300文字以内にしてください。',
      optionTooLong: '各選択肢は55文字以内にしてください。',
      pollEnded: '投票終了',
      pollEndedDesc: 'この投票は既に締め切られたか、存在しません。',
    },
  },

  admin: {
    role: {
      add: {
        success: 'ロールを付与しました',
        successDesc: '**{user}** にロール **{role}** を付与しました。',
      },
      remove: {
        success: 'ロールを剥奪しました',
        successDesc: '**{user}** からロール **{role}** を剥奪しました。',
      },
      errors: {
        noPermission: 'このコマンドには「ロールの管理」権限が必要です。',
        memberNotFound: 'メンバーが見つかりません。',
        botRoleHierarchy: 'Botの最高ロールより上位のロールは操作できません。',
        actorRoleHierarchy:
          '自分の最高ロールより上位のロールは操作できません。',
        targetMemberHierarchy:
          '自分より上位または同等の最高ロールを持つメンバーは操作できません。',
        botTargetMemberHierarchy:
          'Botの最高ロール以上のメンバーは操作できません。',
        alreadyHasRole: 'このメンバーは既にそのロールを持っています。',
        doesNotHaveRole: 'このメンバーはそのロールを持っていません。',
        failed: 'ロールの操作に失敗しました。',
      },
    },
    panel: {
      statsTab: '統計',
      dbTab: 'DB',
      guildsTab: 'Guilds',
      healthTab: 'Health',
      metricsTab: 'Metrics',
      backupsTab: 'Backups',
      refresh: '更新',
      runBackup: 'バックアップ実行',
      statsTitle: 'Bot統計',
      dbTitle: 'データベース統計',
      guildsTitle: '参加サーバー一覧',
      healthTitle: 'システムヘルスチェック',
      metricsTitle: 'Botメトリクス',
      backupsTitle: 'データベースバックアップ',
      backupsFooter: '下のボタンから手動バックアップを実行できます',
      serversLabel: 'サーバー数',
      usersLabel: 'ユーザー数',
      channelsLabel: 'チャンネル数',
      uptimeLabel: '稼働時間',
      memoryLabel: 'メモリ',
      nodeLabel: 'Node.js',
      tablesLabel: 'テーブル',
      backupSuccess: 'バックアップを作成しました: `{filename}` ({size} KB)',
      backupFailure: 'バックアップに失敗しました: {error}',
    },
  },

  owner: {
    errors: {
      ownerOnly: 'このコマンドは Bot オーナーのみ使用できます。',
    },
    broadcast: {
      confirm:
        '以下のメッセージを {total} サーバー中 {count} 件のお知らせチャンネルへ投稿します。未設定のサーバーは対象外です。\n\n{message}',
      progress:
        '一斉通知を送信中... {processed}/{total}{capNote} (成功 {sent}, 失敗 {failed})',
      complete:
        '一斉通知が完了しました\n成功: {sent}\n失敗: {failed}\nお知らせチャンネル未設定: {skipped}{capNote}',
      capNote:
        '\n\n注: お知らせチャンネルを設定済みの {total} サーバー中、先頭 {limit} 件のみ処理しました。',
      noChannel:
        'お知らせチャンネルを設定しているサーバーがないため、送信先がありません。各サーバーの管理者が `/admin settings announcements` で受け取りを有効にできます。',
    },
    backup: {
      confirm: '手動データベースバックアップを今すぐ作成します。続行しますか？',
      complete:
        'バックアップを作成しました。\n\n**ファイル名:** `{filename}`\n**サイズ:** {size} KB',
      failed: 'バックアップに失敗しました: {error}',
    },
  },

  help: {
    title: 'コマンド一覧',
    description:
      '利用可能なコマンドの一覧です。詳細は `/general help` にコマンド名を指定して確認できます。',
    usage: '使い方',
    commandNotFound: 'コマンドが見つかりません',
    commandNotFoundDesc: '`{command}` というコマンドは存在しません。',
    permission: {
      everyone: '全員',
      manageGuild: 'サーバー管理',
      manageRoles: 'ロール管理',
      owner: 'Botオーナー',
    },
    filteredFooter: '実行可能なコマンドのみ表示しています',
    selectCategory: 'カテゴリーを選択...',
    showAll: 'すべて表示',
    onlyCommandUser: 'コマンドを実行したユーザーのみ操作できます。',
  },

  notification: {
    voice: {
      setTitle: 'VC通知設定完了',
      set: 'VC入退室通知を <#{channel}> に送信します',
      removedTitle: 'VC通知無効化',
      removed: 'VC入退室通知を無効にしました。',
      nextStep: '`/notification status` で他の通知設定もまとめて確認できます。',
      disabledHint:
        'あとで再開する場合は `/notification voice set` で再設定してください。',
    },
    welcome: {
      setTitle: 'メンバー参加通知設定完了',
      set: 'メンバー参加通知を <#{channel}> に送信します',
      removedTitle: 'メンバー参加通知無効化',
      removed: 'メンバー参加通知を無効にしました。',
      nextStep: '`/notification status` で他の通知設定もまとめて確認できます。',
      disabledHint:
        '参加通知を再開するには `/notification welcome set` を使ってください。',
    },
    status: {
      title: '通知設定',
      voiceLabel: 'VC入退室',
      welcomeLabel: 'メンバー参加',
      disabled: '未設定',
    },
    panel: {
      statusTab: '設定',
      statsTab: '統計',
      periodPlaceholder: '統計期間を選択...',
      voicePlaceholder: 'VC通知先チャンネルを選択...',
      welcomePlaceholder: '参加通知先チャンネルを選択...',
      removeVoice: 'VC通知を無効化',
      removeWelcome: '参加通知を無効化',
      statusDescription: 'このパネルから通知チャンネルを直接更新できます。',
    },
    stats: {
      title: 'あなたのVC統計',
      noData: 'VCセッションデータがありません。',
      total: '合計',
      period: '期間',
      periods: {
        today: '今日',
        week: '今週',
        month: '今月',
        all: '全期間',
      },
    },
    events: {
      voiceJoin: '**{name}** が <#{channel}> に参加しました',
      voiceLeave: '**{name}** が <#{channel}> から退出しました',
      voiceMove: '**{name}** が <#{from}> から <#{to}> に移動しました',
      voiceDigestTitle: 'ボイスチャンネルの動き',
      memberJoinTitle: 'ようこそ！',
      memberJoin: '**{name}** がサーバーに参加しました！',
      memberCount: 'メンバー数',
    },
    errors: {
      textChannelOnly: 'テキストチャンネルを選択してください。',
      notConfigured: '削除する通知設定がありません。',
      channelNotSendable:
        'Bot がそのチャンネルに送信できません。別のテキストチャンネルを選択してください。',
      manageGuildRequired:
        'サーバー通知設定の変更には「サーバーの管理」権限が必要です。',
    },
  },

  record: {
    autojoin: {
      title: 'VC自動参加',
      enabled:
        'このサーバーでVCへの自動参加を有効にしました。Botは人がいるVCに参加し、直近{minutes}分の音声を保持します。',
      disabled:
        'このサーバーでVCへの自動参加を無効にしました。Botが自分からVCに参加することはなくなり、音声も保持しません。',
      excluded:
        '<#{channel}> を自動参加の対象外にしました。このチャンネルの音声は保持されません。',
      included: '<#{channel}> を自動参加の対象に戻しました。',
      notExcluded: '<#{channel}> は対象外に設定されていません。',
      statusEnabled: '有効',
      statusDisabled: '無効',
      exclusionCount: '対象外チャンネル',
      currentChannelBuffered: '現在のチャンネルは音声を保持中です',
      currentChannelExcluded: '現在のチャンネルは対象外です',
      currentChannelReadingOnly:
        '現在のチャンネルでは読み上げだけを行っており、音声は保持していません',
      currentChannelNotKept: '現在のチャンネルの音声は保持していません',
      currentChannelNone: 'VCに参加していません',
      readingStopped:
        '<#{channel}> では音声を保持していたため、読み上げも終了しました。`/tts start` を実行すると、音声を保持せずに読み上げを再開できます。',
      ttsStillReads:
        '`/tts start` で読み上げるときだけ、Botはスピーカーミュートの状態で参加します。',
    },
    notice: {
      title: '音声を保持しています',
      body: 'このチャンネルの音声を直近{minutes}分ぶん保持しています。サーバー管理者は `/voice record` で書き出せます。',
      optOut:
        '保持を止めるには管理者が `/voice autojoin exclude` を実行してください。',
    },
    bufferWindow: '保持時間',
    recording: '録音中...',
    recordingDesc: '過去{duration}の音声を録音しています。',
    success: '録音完了',
    successDesc: '過去{duration}の音声を録音しました。',
    successNextStep:
      '接続数や上限を確認したい場合は `/voice status` を使ってください。',
    durationNote: 'ヒント: 録音時間は保持バッファと最大5分の制限を受けます。',
    statusHint:
      'この状態表示は自分だけに見えます。録音前の容量確認に使えます。',
    errors: {
      notInVoice: 'ボイスチャンネル未参加',
      notInVoiceDesc:
        'このコマンドを使用するにはボイスチャンネルに参加してください。',
      botNotInVoice: 'BotがVCに参加していません',
      botNotInVoiceDesc: 'Botがこのボイスチャンネルに参加していません。',
      invalidDuration: '無効な期間',
      invalidDurationDesc: '期間の形式が正しくありません。例: 30s, 1m, 5m',
      durationTooLong: '期間が長すぎます',
      durationTooLongDesc: '最大録音時間は{max}秒です。',
      durationExceedsBuffer: 'バッファ範囲外',
      durationExceedsBufferDesc:
        '指定された期間が保持可能な音声ウィンドウ（{buffer}秒）を超えています。',
      noAudibleAudio: '音声が検出されませんでした',
      noAudibleAudioDesc:
        'その期間に十分な音量の音声がありませんでした。マイクに近づくか、より短い時間で試してください。',
      noPermission: '権限不足',
      noPermissionDesc: 'Botがファイルを送信する権限がありません。',
      deliveryIncomplete: '録音配信が不完全です',
      deliveryIncompleteDesc:
        '分割録音のパート {parts}（全{total}件中）を配信できませんでした。完全な音声が必要な場合は `/record` を再実行してください。',
      failed: '録音失敗',
      failedDesc: '録音の処理中にエラーが発生しました: {error}',
    },
  },

  tts: {
    errors: {
      notConfigured: '読み上げは設定されていません',
      notConfiguredDesc:
        'このBotには読み上げエンジン（VOICEVOX）が設定されていません。Botの運営者に `VOICEVOX_URL` の設定を依頼してください。',
      engineDown: '読み上げエンジンに接続できません',
      engineDownDesc:
        'VOICEVOXが応答していません。少し待ってからもう一度お試しください。続く場合はBotの運営者に連絡してください。',
      notInVoice: 'VCに参加してください',
      notInVoiceDesc:
        '読み上げたいボイスチャンネルに先に参加してから、`/tts start` を実行してください。',
      busyElsewhere: 'Botは別のVCにいます',
      busyElsewhereDesc:
        'Botは今 <#{channel}> に参加しています（Discordの仕様で、1つのサーバーで同時に入れるVCは1つだけです）。そのVCで使うか、Botが抜けるまでお待ちください。',
      cannotJoin: 'VCに参加できませんでした',
      cannotJoinDesc:
        'Botにそのチャンネルの「接続」権限があるか、同時接続数の上限に達していないか確認してください。',
      notRunning: '読み上げは行われていません',
      notRunningDesc: '`/tts start` で読み上げを始められます。',
      notInSameVoice: '操作できません',
      notInSameVoiceDesc:
        '読み上げ中のVC（<#{channel}>）に参加している人か、「サーバーの管理」権限を持つ人だけが操作できます。',
      stageUnsupported: 'ステージチャンネルでは読み上げできません',
      stageUnsupportedDesc:
        'ステージではBotが聞き手として参加するため、読み上げても声が届きません。通常のボイスチャンネルで `/tts start` を実行してください。',
    },
    started: '読み上げを開始しました',
    startedDesc:
      '<#{voice}> で、このチャンネルとVCのチャットに書かれた発言を読み上げます。',
    startedDescVoiceOnly:
      '<#{voice}> で、VCのチャットに書かれた発言を読み上げます。',
    howToTitle: '使い方',
    howTo:
      '・読み上げるのは <#{voice}> にいる人の発言だけです\n・先頭に `;` を付けると読み上げません\n・`/tts voice` で自分の声と速さを変えられます\n・`/tts dict add` で読み方を登録できます\n・`/tts skip` で今の発言を飛ばし、`/tts stop` で終了します',
    noSpeakPermission:
      '⚠️ Botに <#{voice}> の「発言」権限がないため、声が届かない可能性があります。',
    noViewPermission:
      '⚠️ Botはこのチャンネルを閲覧できないため、ここでの発言は読み上げられません。読み上げるのはVCのチャットだけです。',
    credit: '音声: {credits}',
    stopped: '読み上げを終了しました',
    stoppedDesc: 'また使うときは `/tts start` を実行してください。',
    stoppedByOptOut:
      '管理者が音声の保持を止めたため、Botは退出しました。`/tts start` を実行すると、音声を保持せずに読み上げを再開できます。',
    skipped: '今の発言を飛ばしました。',
    nothingToSkip: '今は何も読み上げていません。',
    voice: {
      currentTitle: 'あなたの読み上げ設定',
      current: '声: **{voice}**\n速さ: **{speed}倍**',
      changeHint:
        '`/tts voice` の `speaker` で声を、`speed` で速さ（0.5〜2.0）を変えられます。',
      setTitle: '読み上げの声を変更しました',
      unknown: 'その声は見つかりませんでした',
      unknownDesc: '入力欄に表示される候補から選んでください。',
      credit: 'クレジット: VOICEVOX:{character}',
      preview: 'この声で読み上げます',
      changed: '<@{user}> さんの読み上げの声が **{voice}** になりました。',
    },
    dict: {
      addedTitle: '辞書に登録しました',
      added: '{word} を {reading} と読みます。',
      updated: '{word} の読み方を {reading} に更新しました。',
      removedTitle: '辞書から削除しました',
      removed: '{word} を辞書から削除しました。',
      notFound: '{word} は辞書に登録されていません。',
      notOwner:
        '他の人が登録した単語は、登録した本人か「サーバーの管理」権限を持つ人だけが変更・削除できます。',
      full: '辞書の登録数が上限（{max}件）に達しています。不要な単語を `/tts dict remove` で削除してください。',
      listTitle: 'このサーバーの読み上げ辞書',
      listEmpty:
        'まだ単語が登録されていません。`/tts dict add` で登録できます。',
      listMore: 'ほか{count}件',
      invalid:
        '単語は1〜{wordMax}文字、読み方は1〜{readingMax}文字で入力してください。',
    },
  },
};
