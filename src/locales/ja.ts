import type { TranslationKeys } from './types.js';

/**
 * Japanese translations
 *
 * Copy is です/ます調. Use one term per concept:
 * - VC: voice channels in UI copy (ボイスチャンネル only in command
 *   descriptions, where it is Discord's own term).
 * - サーバー: a Discord server (never ギルド).
 * - 録音: the audio file /voice record writes. 読み上げ: text-to-speech.
 * - 保持: the bot keeping the last few minutes of audio in memory (not
 *   バッファ or ウィンドウ). Excluding a VC is 「自動参加の対象外」.
 * - 外す: taking a role off a member (not 剥奪); the pair is 付与・解除.
 * - メニュー: a select menu (not セレクト).
 * - Bot運営者: whoever runs the bot (BOT_OWNER_IDS). Not Botオーナー, which
 *   reads as the server owner.
 * - Bot: no space before particles (Botが, Botのロール).
 * - Ellipses are 「…」; "N more" is 「…ほか{count}件」 (人 for people).
 */
export const ja: TranslationKeys = {
  common: {
    error: 'エラー',
    warning: '警告',
    guildOnly: 'このコマンドはサーバー内でのみ使用できます。',
    guildNotAllowed:
      'このBotはこのサーバーでは利用できない設定になっています。',
    noPermission: 'このコマンドを使用する権限がありません。',
    noData: 'データなし',
    unexpectedError:
      '処理中に問題が発生しました。少し待ってからもう一度お試しください。繰り返し発生する場合は、エラーID `{id}` をサーバー管理者にお伝えください。',
    actionFailed:
      'この操作を反映できませんでした。もう一度お試しください。繰り返し発生する場合は、エラーID `{id}` をサーバー管理者にお伝えください。',
    cooldownTitle: '少しお待ちください',
    cooldown: '{command} はあと{seconds}秒で使えるようになります。',
    permissionDeniedTitle: '権限が足りません',
    permissionsRequired:
      'この操作には{permissions}の権限が必要です。権限を持つサーバー管理者に依頼してください。',
    permissionsUnverifiable:
      '権限を確認できませんでした。もう一度お試しください。',
    permissionNames: {
      Administrator: '管理者',
      ManageGuild: 'サーバー管理',
      ManageRoles: 'ロールの管理',
      ManageChannels: 'チャンネルの管理',
      ManageMessages: 'メッセージの管理',
      KickMembers: 'メンバーをキック',
      BanMembers: 'メンバーをBAN',
      ModerateMembers: 'メンバーをタイムアウト',
      ViewAuditLog: '監査ログを表示',
      ViewChannel: 'チャンネルを見る',
      SendMessages: 'メッセージを送信',
      EmbedLinks: '埋め込みリンク',
      AttachFiles: 'ファイルを添付',
      Connect: '接続',
      Speak: '発言',
      MoveMembers: 'メンバーを移動',
    },
    serverOnlyTitle: 'サーバー専用のコマンドです',
    confirm: '確認',
    cancel: 'キャンセル',
    confirmMessage: '本当に実行しますか？',
    cancelled: 'キャンセルしました。',
    nextStep: '次にできること',
    timedOutTitle: '時間切れです',
    confirmTimedOut: '{seconds}秒間操作がなかったため、何も実行していません。',
    confirmTimedOutRetry:
      '{seconds}秒間操作がなかったため、何も実行していません。必要であれば {command} をもう一度実行してください。',
    promptClosedTitle: '受付を終了しました',
    confirmInterrupted:
      'Botの再起動のため受付を終了しました。何も実行していません。',
    confirmInterruptedRetry:
      'Botの再起動のため受付を終了しました。何も実行していません。必要であれば、少し待ってから {command} をもう一度実行してください。',
    onlyCommandUser:
      'このメニューは {user} さん専用です。ご自身で操作するには {command} を実行してください。',
    onlyCommandUserGeneric: 'このメニューは {user} さん専用です。',
    panelExpired:
      '⏱ 操作の受付時間が終了しました。続けるには {command} をもう一度実行してください。',
    panelExpiredGeneric:
      '⏱ 操作の受付時間が終了しました。続けるには、もう一度コマンドを実行してください。',
    componentExpired:
      'このボタンやメニューは受付を終了しています（Botの再起動または時間切れのため）。{command} をもう一度実行してください。',
    componentExpiredGeneric:
      'このボタンやメニューは受付を終了しています（Botの再起動または時間切れのため）。もう一度コマンドを実行してください。',
    componentNotReady:
      'Botを再起動しています。数秒後にもう一度お試しください。',
    formExpired:
      'このフォームは受付を終了しています（Botの再起動または時間切れのため）。入力内容は保存されていません。もう一度コマンドを実行してください。',
    notSet: '未設定',
    notSetWithHint: '未設定（{command} で設定できます）',
    duration: {
      pair: '{first}{second}',
      short: {
        hours: '{count}時間',
        minutes: '{count}分',
        seconds: '{count}秒',
        lessThanMinute: '1分未満',
      },
      long: {
        hoursOne: '{count}時間',
        hoursOther: '{count}時間',
        minutesOne: '{count}分',
        minutesOther: '{count}分',
        secondsOne: '{count}秒',
        secondsOther: '{count}秒',
        lessThanMinute: '1分未満',
      },
    },
  },

  settings: {
    title: 'サーバー設定',
    language: {
      name: '言語',
      changed: '言語を {language} に変更しました',
      current: '現在の言語',
      auto: '自動（ユーザーに合わせる）',
      autoHint:
        '「自動」の場合、コマンドへの返信は各ユーザーのDiscordの言語で表示します。VC入退室通知・参加通知・監査ログなど、チャンネルへの投稿は **{lang}** で表示します（コミュニティサーバーではDiscordのサーバー言語に合わせます）。投稿の言語を固定するには、下のメニューで「日本語」か「English」を選んでください（コマンドへの返信も全員その言語になります）。',
    },
    audit: {
      name: '監査ログチャンネル',
      notSet: '未設定',
      configured: '監査ログを <#{channel}> に送信します',
      disabled: '監査ログチャンネルの設定を解除しました。',
    },
    announcements: {
      name: 'お知らせチャンネル',
      notSet: '受け取っていません',
      configured: 'Bot運営者からのお知らせを <#{channel}> に投稿します',
      disabled: 'このサーバーはBot運営者からのお知らせを受け取りません。',
    },
    logs: {
      title: '監査ログ',
      noLogs: 'このサーバーの監査ログはありません。',
      showingRange: '全{total}件中 {from}〜{to}件目',
    },
    panel: {
      tabOverview: '概要',
      tabLanguage: '言語',
      tabAudit: '監査先',
      tabAnnouncements: 'お知らせ',
      tabLogs: 'ログ',
      languagePlaceholder: '言語を選択…',
      auditPlaceholder: '監査ログを送るチャンネルを選択…',
      announcementPlaceholder: 'お知らせを受け取るチャンネルを選択…',
      clearAudit: '監査ログの送信をやめる',
      clearAnnouncements: 'お知らせを受け取らない',
      prevPage: '◀ 前へ',
      nextPage: '次へ ▶',
      overviewFooter: 'このパネルで言語・監査ログ・お知らせを変更できます',
      languageFooter: '下のメニューで選ぶとすぐに反映されます',
      auditFooter: '下のメニューでチャンネルを選ぶか、現在の設定を解除できます',
      announcementsFooter:
        '下のメニューでチャンネルを選ぶと、Bot運営者からのお知らせがそこに投稿されます',
    },
    errors: {
      channelNotSendable:
        'Botがそのチャンネルに投稿できません。別のテキストチャンネルを選択してください。',
      channelMissingPermissions:
        'Botが <#{channel}> に投稿できません。不足している権限: {permissions}。チャンネルの編集 → 権限 でBotのロールに許可してから、もう一度設定してください。',
    },
  },

  roulette: {
    member: {
      title: 'ルーレット',
      countdown: '{count}…',
      selecting: '候補から選んでいます…\n\n[{candidates}]',
      result: 'ルーレット結果',
      winner: '🎉 **{name}** さん（{mention}）が選ばれました！',
      onlyOne:
        'VCにいるのは **{name}** さん（{mention}）だけなので、そのまま選ばれました！',
      footer: '{channel}の{count}人から選びました',
      footerExcluded:
        '{channel}の{count}人から選びました（{excluded}人を除外）',
    },
    team: {
      title: 'チーム分け',
      shuffling: '{count}人を{teams}チームに分けています…\n\n[{candidates}]',
      result: 'チーム分け結果',
      resultDesc: '{count}人を{teams}チームに分けました！',
      teamName: 'チーム{number}（{count}人）',
      noMembers: 'メンバーなし',
      footer: '{channel}のメンバー',
    },
    andMore: '…ほか{count}人',
    buttons: {
      again: 'もう一度',
      excludeWinner: '当選者を除いて再抽選',
      reshuffle: 'チームを組み直す',
    },
    errors: {
      notInVoice: 'VCに参加していません',
      notInVoiceDesc: 'ルーレットを使うには、先にVCに参加してください。',
      noMembers: 'メンバーがいません',
      noMembersDesc: 'VCにメンバーがいません（Botは対象外です）。',
      notEnough: 'メンバーが足りません',
      notEnoughDesc:
        '{teams}チームに分けるには{required}人以上必要です。\n現在のメンバー: {current}人（Botは対象外）',
      onlyParticipants: '<#{channel}> に参加している人だけが再抽選できます。',
      noCandidatesLeft:
        '抽選できるメンバーが残っていません（除外したメンバーとBotは対象外です）。',
    },
  },

  ping: {
    title: 'Pong!',
    latency: 'レイテンシ',
    apiLatency: 'API レイテンシ',
    notMeasured: '未計測（接続直後のため）',
  },

  about: {
    title: 'このBotについて',
    description:
      'VCの入退室通知・参加メッセージ・VC滞在時間の統計・投票・ルーレット・読み上げ・VC録音（管理者のみ）が使えるBotです。コマンドの一覧は {help} で確認できます。',
    popularTitle: 'よく使うコマンド',
    voiceTitle: 'このサーバーでの音声の扱い',
    voiceOn:
      'VC自動参加はオンです。Botは人がいるVC（管理者が対象外にしたVCを除く）に参加し、直近{duration}の音声だけをメモリ上に保持します（古い音声は自動で上書きされます）。管理者は {disable} で止められます。',
    voiceOff:
      'VC自動参加はオフのため、Botは音声を保持していません（管理者は {enable} でオンにできます）。',
    recordings:
      '録音ファイルが作られるのは、管理者が {record} を使ったときだけです。Bot側に残るコピーは約{retention}後に削除されます（Discordに送られたファイルは残ります）。',
    languageTitle: '表示言語',
    languageGuild: '{language}（サーバーで設定されています）',
    languageAuto: '{language}（各自のDiscordの言語設定に合わせています）',
    languageChange: '管理者は {command} で変更できます。',
  },

  poll: {
    ended: '投票が終了しました',
    endedMessage: '投票を締め切りました。結果が確定しました。',
    noActivePoll: '受付中の投票がありません',
    noActivePollDesc:
      'このサーバーに、あなたが作成した受付中の投票はありません。新しい投票は {command} で作成できます。',
    createdHint:
      '投票を作成しました。早めに締め切るには {command} を実行してください。',
    endChoice: '#{channel}・残り{remaining}',
    confirm: {
      title: 'この投票を締め切りますか？',
      body: '締め切ると結果がその場で確定し、再開できません。',
      inChannel: '<#{channel}> の投票です。',
      confirm: '締め切る',
      cancel: 'やめる',
    },
    modal: {
      title: '投票を作成',
      question: '質問',
      options: '選択肢',
      optionsDescription:
        '1行に1つずつ、2〜10個入力してください（各55文字まで）',
      optionsPlaceholder: 'ラーメン\nカレー\n寿司',
      duration: '期間',
      multi: '複数選択を許可する',
      retry: '入力し直す',
      retryHint:
        '「入力し直す」を押すと、入力した内容が残ったままフォームが開きます。',
    },
    durations: {
      oneHour: '1時間',
      fourHours: '4時間',
      eightHours: '8時間',
      oneDay: '24時間',
      threeDays: '3日',
      sevenDays: '7日',
    },
    errors: {
      createFailed: '投票を作成できませんでした',
      notEnoughOptions: '選択肢を2つ以上入力してください。',
      tooManyOptions: '選択肢は10個までです（{count}個入力されています）。',
      optionLineTooLong:
        '{line}行目の選択肢が55文字を超えています（{length}文字）。',
      questionMissing: '質問を入力してください。',
      questionTooLong: '質問は300文字以内にしてください。',
      optionTooLong: '各選択肢は55文字以内にしてください。',
      pollEnded: '投票は終了しています',
      pollEndedDesc: 'この投票はすでに締め切られたか、削除されています。',
      endFailed: '投票を締め切れませんでした',
      noAccessDesc:
        'Botが <#{channel}> のメッセージを読めません。そのチャンネルでBotに「チャンネルを見る」と「メッセージ履歴を読む」の権限があるか確認してください。権限を変更できない場合は、サーバーの管理者に依頼してください。',
      pickedNotFound: '投票が見つかりません',
      pickedNotFoundDesc:
        '選んだ投票は見つからないか、すでに締め切られています。「投票」の候補から選び直してください。',
    },
  },

  admin: {
    role: {
      add: {
        success: 'ロールを付与しました',
        successDesc:
          '<@{userId}>（**{displayName}**）に <@&{roleId}> を付与しました。',
      },
      remove: {
        success: 'ロールを外しました',
        successDesc:
          '<@{userId}>（**{displayName}**）から <@&{roleId}> を外しました。',
      },
      errors: {
        memberNotFound: 'メンバーが見つかりません。',
        everyoneRole:
          '@everyone はすべてのメンバーが持つロールのため、付与・解除できません。',
        managedRole:
          '「{role}」はサーバーブーストや連携アプリが自動で管理しているロールのため、手動では付与・解除できません。',
        botMissingManageRoles:
          'Botに「ロールの管理」権限がありません。サーバー設定 → ロール →「{botRole}」で「ロールの管理」をオンにしてください。',
        botRoleHierarchy:
          '「{role}」がBotのロール「{botRole}」と同じか上にあるため操作できません。サーバー設定 → ロール で「{botRole}」を「{role}」より上にドラッグしてください。',
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
      guildsTab: 'サーバー',
      healthTab: 'ヘルス',
      metricsTab: 'メトリクス',
      backupsTab: 'バックアップ',
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
      uptimeDays: '{count}日',
      memoryLabel: 'メモリ',
      nodeLabel: 'Node.js',
      environmentLabel: '環境',
      commandsLabel: 'コマンド数',
      tablesLabel: 'テーブル',
      backupSuccess: 'バックアップを作成しました: `{filename}` ({size} KB)',
      backupFailure: 'バックアップに失敗しました: {error}',
      noBackups: 'バックアップはまだありません。',
      moreBackups: '…ほか{count}件',
    },
  },

  owner: {
    errors: {
      ownerOnly: 'このコマンドはBot運営者のみ使用できます。',
    },
    broadcast: {
      confirmTitle: 'お知らせを一斉通知しますか？',
      confirmLabel: '投稿する',
      confirm:
        '以下のメッセージを {total} サーバー中 {count} 件のお知らせチャンネルへ投稿します。未設定のサーバーは対象外です。\n\n{message}',
      progress:
        '一斉通知を送信中… {processed}/{total}（{capNote}成功 {sent}、失敗 {failed}）',
      progressCap: '上限 {limit}/{total} サーバー、',
      completeTitle: '一斉通知が完了しました',
      complete:
        '成功: {sent}\n失敗: {failed}\nお知らせチャンネル未設定: {skipped}{capNote}',
      capNote:
        '\n\n注: お知らせチャンネルを設定済みの {total} サーバー中、先頭 {limit} 件のみ処理しました。',
      noChannel:
        'お知らせチャンネルを設定しているサーバーがないため、送信先がありません。各サーバーの管理者が {command} で受け取りを有効にできます。',
      embedTitle: 'Bot運営者からのお知らせ',
      embedFooter:
        '受け取りを停止するには、サーバー管理者が /admin settings announcements をチャンネル未指定で実行してください',
      failures: '\n\n**届かなかったサーバー**\n{list}',
      moreFailures: '…ほか{count}件',
      failureReasons: {
        notSendable: 'チャンネルに投稿できません（削除済みまたは権限不足）',
        timeout: '応答がありません',
        sendFailed: '送信に失敗しました',
      },
    },
    backup: {
      confirmTitle: 'バックアップを作成しますか？',
      confirmLabel: 'バックアップする',
      confirm: 'データベースのバックアップを今すぐ作成します。',
      running: '⏳ バックアップを実行中です…',
      completeTitle: 'バックアップ完了',
      complete:
        'バックアップを作成しました。\n\n**ファイル名:** `{filename}`\n**サイズ:** {size} KB',
      failedTitle: 'バックアップ失敗',
      failed: 'バックアップに失敗しました: {error}',
      noReason: '原因は記録されていません。ログを確認してください。',
    },
  },

  audit: {
    actions: {
      NOTIFY_SETUP: '通知を設定',
      NOTIFY_ENABLE: '通知を有効化',
      NOTIFY_DISABLE: '通知を無効化',
      NOTIFY_REMOVE: '通知を解除',
      SETTINGS_CHANGE: '設定を変更',
      AUDIT_SETUP: '監査ログを設定',
      ROLE_ADD: 'ロールを付与',
      ROLE_REMOVE: 'ロールを外す',
    },
    fields: {
      user: '実行者',
      target: '対象',
      details: '詳細',
    },
    userWithName: '{mention}（{name}）',
    kinds: {
      Voice: 'VC入退室',
      Welcome: 'メンバー参加',
    },
    details: {
      notifySetup: '{kind}通知 → <#{channel}>',
      notifyChannel: 'チャンネル: <#{channel}>',
      notifyRemove: '{kind}通知を解除',
      auditChannelCleared: '監査ログの送信先を解除',
      announcementChannelSet: 'お知らせの投稿先: <#{channel}>',
      announcementChannelCleared: 'お知らせの受け取りを停止',
      language: '言語を {language} に変更',
      role: 'ロール: <@&{roleId}>（{roleName}）',
    },
  },

  help: {
    title: 'コマンド一覧',
    description:
      '使えるコマンドの一覧です。下のメニューで選ぶと、詳しい使い方を表示します。',
    descriptionNoMenu: '使えるコマンドの一覧です。',
    usage: '使い方',
    examples: '例',
    commandNotFound: 'コマンドが見つかりません',
    commandNotFoundDesc: '`{command}` というコマンドは存在しません。',
    noMatch: '`{query}` に一致するコマンドは見つかりませんでした。',
    didYouMean: 'もしかして: {suggestion}',
    noMatchHint:
      '使えるコマンドの一覧は、{help} を何も指定せずに実行すると表示されます。権限が必要なコマンドは、使える人にだけ表示されます。',
    matchesTitle: '「{query}」に一致するコマンド',
    matchesHint:
      '詳しい使い方は、入力中に表示される候補からコマンドを選ぶと表示されます。',
    requires: '必要な権限: {permissions}',
    optionLine: '・`{name}`{required}: {description}',
    optionRequired: '（必須）',
    optionChoices: '（選択肢: {choices}）',
    permission: {
      everyone: '全員',
      manageGuild: 'サーバー管理',
      manageRoles: 'ロールの管理',
      administrator: '管理者',
      owner: 'Bot運営者',
    },
    filteredFooter: '実行可能なコマンドのみ表示しています',
    selectCategory: 'カテゴリーを選択…',
    selectCommand: '詳しく見るコマンドを選択…',
    showAll: 'すべて表示',
    back: '一覧に戻る',
  },

  notification: {
    voice: {
      setTitle: 'VC通知設定完了',
      set: 'VC入退室通知を <#{channel}> に送信します',
      removedTitle: 'VC通知無効化',
      removed: 'VC入退室通知を無効にしました。',
      nextStep: '{command} で他の通知設定もまとめて確認できます。',
      disabledHint: 'あとで再開する場合は {command} で再設定してください。',
      alreadyDisabled:
        'VC入退室通知はすでに無効です。再開するには {command} を使ってください。',
    },
    welcome: {
      setTitle: 'メンバー参加通知設定完了',
      set: 'メンバー参加通知を <#{channel}> に送信します',
      removedTitle: 'メンバー参加通知無効化',
      removed: 'メンバー参加通知を無効にしました。',
      nextStep: '{command} で他の通知設定もまとめて確認できます。',
      disabledHint: '参加通知を再開するには {command} を使ってください。',
      alreadyDisabled:
        'メンバー参加通知はすでに無効です。再開するには {command} を使ってください。',
    },
    language: {
      line: '通知の言語: {language}',
      autoHint:
        'サーバーの言語設定が「自動」のため、通知は{language}で投稿します。変更するには {command} で言語を選んでください（コマンドの返信も全員その言語になります）。',
    },
    status: {
      title: '通知設定',
      voiceLabel: 'VC入退室',
      welcomeLabel: 'メンバー参加',
      disabled: '未設定',
      postLanguage: '通知の言語',
    },
    panel: {
      statusTab: '設定',
      statsTab: '統計',
      periodPlaceholder: '統計期間を選択…',
      voicePlaceholder: 'VC通知先チャンネルを選択…',
      welcomePlaceholder: '参加通知先チャンネルを選択…',
      removeVoice: 'VC通知を無効化',
      removeWelcome: '参加通知を無効化',
      statusDescription: 'このパネルから通知チャンネルを直接更新できます。',
      confirmRemove:
        '{type}通知（<#{channel}>）を無効にしますか？無効にすると、このチャンネルへの通知は止まります。',
      confirmRemoveButton: '無効にする',
      cancelRemoveButton: '戻る',
      changed: '✅ {type}通知の送信先を <#{channel}> に設定しました。',
      removed:
        '🗑 {type}通知を無効にしました（以前の送信先: <#{channel}>）。下のメニューからいつでも再設定できます。',
    },
    stats: {
      title: 'あなたのVC統計',
      noData:
        'VCの滞在記録はまだありません（{period}）。\nVCに参加すると、ここに滞在時間が表示されます。',
      noDataInPeriodHint:
        '期間を「{all}」に変えると、これまでの記録を確認できます。',
      liveSession:
        '🔊 いま <#{channel}> に参加中です（参加してから{duration}）。この時間も集計に含めています。',
      live: '（参加中）',
      sessions: '（{count}回）',
      more: '…ほか{count}件',
      dayBoundaryJapan: '日付は日本時間の0:00で区切っています',
      dayBoundary: '日付は {zone} の0:00で区切っています',
      total: '合計',
      period: '期間',
      periods: {
        today: '今日',
        week: '過去7日間',
        month: '過去30日間',
        all: '全期間',
      },
    },
    events: {
      voiceJoin: '🟢 **{name}** が <#{channel}> に参加',
      voiceLeave: '🔴 **{name}** が <#{channel}> から退出',
      voiceMove: '🔁 **{name}**：<#{from}> → <#{to}>',
      voiceDigestTitle: 'VCの入退室',
      memberJoinTitle: '新しいメンバーが参加しました',
      memberJoin:
        '**{name}** さん、ようこそ！🎉\nあなたは **{count}人目** のメンバーです。',
      memberJoinRules: 'まずは <#{channel}> をご確認ください。',
    },
    summary: {
      voice: 'VC入退室通知',
      welcome: 'メンバー参加通知',
    },
    errors: {
      textChannelOnly: 'テキストチャンネルを選択してください。',
      channelNotSendable:
        'Botがそのチャンネルに投稿できません。別のテキストチャンネルを選択してください。',
      channelMissingPermissions:
        'Botが <#{channel}> に投稿できません。不足している権限: {permissions}。チャンネルの編集 → 権限 でBotのロールに許可してから、もう一度設定してください。',
    },
  },

  record: {
    autojoin: {
      title: 'VC自動参加',
      enabled:
        'このサーバーでVC自動参加をオンにしました。Botは人がいるVCに参加して、直近{minutes}分の音声を保持します。参加できるVCは1サーバーにつき1つで、参加したVCのチャットでお知らせします。',
      joinedNow:
        '<#{channel}> に参加し、音声の保持を始めました。これより前の音声は保存できません。',
      waitingForMembers:
        '今は人がいるVCがないため、誰かがVCに入ったときに参加します。',
      disabled:
        'このサーバーでVC自動参加をオフにしました。Botが自分からVCに参加することはなくなり、音声も保持しません。再開するには {command} を使ってください。',
      disabledDropped:
        '参加していたVCから退出し、保持していた音声を破棄しました。',
      excluded:
        '<#{channel}> を自動参加の対象外にしました。このVCの音声は保持されません。',
      alreadyExcluded: '<#{channel}> はすでに自動参加の対象外です。',
      excludedLeft:
        'Botは <#{channel}> から退出し、保持していた音声を破棄しました。',
      included: '<#{channel}> を自動参加の対象に戻しました。',
      includedWhileOff:
        'ただし、今はサーバー全体で自動参加がオフです。{command} でオンにしてください。',
      notExcluded: '<#{channel}> は対象外に設定されていません。',
      alreadyReadOnly:
        'Botは今 <#{channel}> に読み上げか字幕のためだけに参加しているため、まだ音声を保持していません。読み上げや字幕が終わってBotが退出したあと、誰かがVCに入ると保持が始まります。',
      statusEnabled: 'オン',
      statusDisabled: 'オフ',
      exclusions: '対象外のVC',
      exclusionsNone: 'なし',
      exclusionsMore: '…ほか{count}件',
      currentChannelBuffered:
        '✅ <#{channel}> の音声を保持しています（いま保存できるのは直近{available}です）。',
      currentChannelListening:
        '✅ <#{channel}> の音声を保持しています（まだ誰の声も届いていません）。',
      currentChannelExcluded: '⏸ <#{channel}> は自動参加の対象外です。',
      currentChannelNotBuffered:
        '⚠️ <#{channel}> の音声は保持されていません。{reason}',
      currentChannelNone: 'あなたはVCに参加していません。',
      readingStopped:
        '<#{channel}> では音声を保持していたため、読み上げも終了しました。`/tts start` を実行すると、音声を保持せずに読み上げを再開できます。',
      ttsStillReads:
        '`/tts start` で読み上げるときだけ、Botはスピーカーミュートの状態で参加します。',
    },
    notice: {
      title: '🎙️ このVCの音声を一時的に保持しています',
      body: 'Botは直近{minutes}分の音声だけをメモリ上に保持し、古い音声は自動で上書きされます。サーバー管理者が {command} を使ったときだけファイルとして保存され、その人にだけ届きます（Botからは約{hours}時間後に削除されます）。',
      optOut:
        '保持してほしくない場合は、サーバー管理者に伝えてください。管理者は下のボタンでこのVCを対象外にできます（{command} ではサーバー全体で止められます）。',
      optOutButton: 'このVCを自動参加の対象外にする',
      optOutNotAllowed:
        'このボタンを使えるのは「サーバー管理」権限を持つ管理者だけです。気になる場合はサーバー管理者に伝えてください。',
      optedOut:
        '🔕 <#{channel}> は自動参加の対象外になりました（{user} さんが設定）。',
      optedOutLeft: 'Botは退出し、保持していた音声を破棄しました。',
      channelStatus: '🔴 Botが直近{minutes}分の音声を保持中',
    },
    notBuffered: {
      autoJoinOff:
        'このサーバーではVC自動参加がオフのため、音声を保持していません。{command} でオンにすると、それ以降の会話を録音できます。',
      excluded:
        '<#{channel}> は自動参加の対象外です。{command} で対象に戻せます。',
      busyElsewhere:
        'Botは同じサーバーの <#{other}> で音声を保持しています（Botが同時に入れるVCは1サーバーにつき1つです）。そのVCで実行するか、そのVCが空くまでお待ちください。',
      readOnly:
        'Botは <#{channel}> に読み上げか字幕のためだけに参加しているため、音声を保持していません。読み上げや字幕が終わってBotが退出したあと、誰かがVCに入ると自動参加で保持が始まります。',
      atLimit:
        'Botの同時接続数が上限（{max}）に達しているため、このVCには参加できていません。しばらくしてからもう一度お試しください。',
      noPermission:
        'Botに <#{channel}> の「チャンネルを見る」「接続」権限がありません。チャンネルの編集 → 権限 で、Botのロールに許可してください。',
      notYetJoined:
        'Botはまだこのチャンネルに参加していません。VCに入り直すとBotが参加し、それ以降の音声を録音できます。',
      startedTitle: '音声の保持を始めました',
      startedNow:
        'Botがこのチャンネルに参加し、音声の保持を始めました。録音できるのはこれ以降の音声なので、しばらく話してからもう一度実行してください。',
      beforeJoinNote: '※ Botが参加する前の音声は、さかのぼって保存できません。',
    },
    status: {
      title: 'ボイス機能の状態',
      botChannel: 'このサーバーでBotがいるVC',
      capacity: 'Botの空き',
      capacityAvailable: 'あり',
      capacityFull: 'なし（同時接続数の上限です）',
      saveLimit: '保存できる長さ',
      saveLimitValue: '最大{max}（{limit}MBを超える録音は分割して送信します）',
      noticeNoPermission:
        '⚠️ <#{channel}> にお知らせを投稿できませんでした。Botにこのチャンネルの「メッセージを送信」権限を付けてください。',
      noticeSendFailed:
        '⚠️ <#{channel}> へのお知らせの投稿に失敗しました。Botが次にこのVCに参加したときに再度投稿します。',
    },
    panel: {
      enable: '自動参加をオンにする',
      disable: '自動参加をオフにする',
      confirmDisable: 'オフにする（保持中の音声は破棄）',
      cancelDisable: 'やめる',
      confirmDisablePrompt:
        'オフにすると、Botは参加中のVCから退出し、保持していた音声を破棄します。よろしければ「オフにする」を押してください。',
      disabled: 'VC自動参加をオフにしました。',
      exclusionsPlaceholder: '音声を保持しないVCを選択（複数可）',
      exclusionsUpdated:
        '✅ 対象外のVCを更新しました。追加: {added} ／ 解除: {removed}',
      nothingChanged: '変更はありませんでした。',
      tooManyExclusions:
        '対象外のVCが多いため、ここでは選択できません。{exclude} / {include} で変更してください。',
      hiddenExclusions:
        '対象外のVCのうち{count}件は、あなたが閲覧できないチャンネルのためメニューに表示していません。このメニューで解除されることはありません。',
    },
    audit: {
      autoJoinEnabled: 'VC自動参加をオンに変更（{via}）',
      autoJoinDisabled: 'VC自動参加をオフに変更（{via}）',
      channelExcluded: '<#{channel}> を自動参加の対象外に変更（{via}）',
      channelIncluded: '<#{channel}> の対象外を解除（{via}）',
      exclusionsChanged:
        '自動参加の対象外のVCを変更: 追加 {added} ／ 解除 {removed}（{via}）',
      viaCommand: '{command} から',
      viaPanel: '{command} のパネルから',
      viaNoticeButton: 'お知らせのボタンから',
    },
    recording: '⏳ 書き出し中…',
    recordingDesc: '直前{duration}の音声をファイルにまとめています。',
    inProgressNote:
      '完了すると、このメッセージにファイルが添付されます（あなたにだけ表示されます）。',
    success: '録音を保存しました',
    successDesc: '直前{duration}の音声を保存しました。',
    trimmedNote:
      'Botがこのチャンネルの音声を受け取り始めてから{available}しか経っていないため、{available}ぶんを保存しました。',
    saveWarning:
      'このメッセージはあなたにだけ表示され、Discordを再読み込みすると消えます。必要なファイルは今すぐ保存してください。',
    fileSize: 'ファイルサイズ: {size}MB',
    fileSizeSplit: '合計 {size}MB（{count}ファイルに分割）',
    partLabel: 'パート {part}/{total}（{from}〜{to}）',
    partLabelShort: 'パート {part}/{total}',
    statusHint: 'この表示はあなたにだけ見えます。',
    errors: {
      notInVoice: 'VCに参加していません',
      notInVoiceDesc:
        'このコマンドを使うには、録音したいVCに参加してください。',
      notVoiceChannel:
        '指定できるのはボイスチャンネルとステージチャンネルだけです。',
      notBuffered: 'このVCの音声は保持されていません',
      botUnavailable:
        'Botの状態を確認できませんでした。数秒後にもう一度お試しください。',
      invalidDuration: '時間の指定が正しくありません',
      invalidDurationDesc: '表示される選択肢から時間を選んでください。',
      durationTooLong: '時間が長すぎます',
      durationTooLongDesc: '録音できるのは最大{max}です。',
      durationExceedsBuffer: '保持している時間を超えています',
      durationExceedsBufferDesc:
        'Botが保持している音声は直近{buffer}までです。',
      noAudibleAudio: '音声が見つかりませんでした',
      noAudibleAudioDesc:
        '直前{duration}のあいだ、Botには誰の声も届いていませんでした。Botが参加する前の音声は保存できません。',
      noAudibleAudioLongerHint:
        'もっと前の会話を保存したい場合は、長めの時間を選んでください。',
      noPermission: 'ファイルを送信できません',
      noPermissionDesc:
        'このチャンネル（<#{channel}>）でBotに「ファイルを添付」権限がありません。別のチャンネルで実行するか、サーバー管理者に権限を付けてもらってください。',
      deliveryIncomplete: '一部のファイルを送れませんでした',
      deliveryIncompleteDesc:
        '分割したファイルのうち、パート {parts}（全{total}件中）を送れませんでした。保持中の音声は古いものから消えていくため、必要ならすぐに {command} でもう一度保存してください。',
      busy: 'ほかの録音を書き出し中です',
      busyDesc:
        'このVCでは別の録音を書き出し中です。数秒後にもう一度お試しください。',
      tooLarge: 'ファイルが大きすぎます',
      tooLargeDesc:
        '録音ファイル（{size}MB）がこのサーバーのアップロード上限（{limit}MB）を超えたため、送れませんでした。{command} でもっと短い時間を選んでください。',
      failed: '録音を保存できませんでした',
      failedDesc:
        '録音の書き出しに失敗しました。もう一度お試しください。繰り返し発生する場合は、エラーID `{id}` をサーバー管理者にお伝えください。',
    },
  },

  onboarding: {
    title: 'Botを導入していただきありがとうございます',
    description:
      'VCの入退室通知・参加メッセージ・VC滞在時間の統計・投票・ルーレット・読み上げ・VC録音（管理者のみ）が使えます。コマンドの一覧は {help} で確認できます。',
    bufferingTitle: '音声の保持について',
    buffering:
      '初期設定では、人がいるVCにBotが自動で参加し、直近{minutes}分の音声をメモリ上に保持します（管理者が {record} で書き出すためです）。不要な場合は {disable}、特定のVCだけ外す場合は {exclude} を使ってください。',
    setupTitle: 'はじめの設定',
    setup:
      '1. {language} 表示言語\n2. {voice} VCの入退室通知\n3. {welcome} 参加メッセージ\n4. {audit} 監査ログ\n5. {announcements} お知らせ',
    missingTitle: '足りない権限',
    missingLine: '・{permission}: {effect}',
    missing: {
      ViewChannel: 'チャンネルが見えないため、多くの機能が動きません',
      Connect: 'VCに参加できないため、自動参加・録音・読み上げが動きません',
      SendMessages: '通知やお知らせを投稿できません',
      EmbedLinks: '通知やお知らせを正しく表示できません',
      AttachFiles: '録音ファイルを送れません',
      ManageRoles: '{command} が使えません',
    },
    footer: 'この案内は、サーバーにBotが追加されたときに一度だけ送られます。',
  },

  tts: {
    errors: {
      notConfigured: '読み上げは設定されていません',
      notConfiguredDesc:
        'このBotには読み上げエンジン（VOICEVOX）が設定されていません。Bot運営者に `VOICEVOX_URL` の設定を依頼してください。',
      engineDown: '読み上げエンジンに接続できません',
      engineDownDesc:
        'VOICEVOXが応答していません。少し待ってからもう一度お試しください。続く場合はBot運営者に連絡してください。',
      notInVoice: 'VCに参加してください',
      notInVoiceDesc:
        '読み上げたいVCに先に参加してから、{command} を実行してください。',
      busyElsewhere: 'Botは別のVCにいます',
      busyElsewhereDesc:
        'Botは今 <#{channel}> に参加しています（Discordの仕様で、1つのサーバーで同時に入れるVCは1つだけです）。そのVCで使うか、Botが抜けるまでお待ちください。',
      cannotJoin: 'VCに参加できませんでした',
      cannotJoinDesc:
        'Botにそのチャンネルの「接続」権限があるか、同時接続数の上限に達していないか確認してください。',
      notRunning: '読み上げは行われていません',
      notRunningDesc: '{command} で読み上げを始められます。',
      notInSameVoice: '操作できません',
      notInSameVoiceDesc:
        '読み上げ中のVC（<#{channel}>）に参加している人か、{permission}の権限を持つ人だけが操作できます。',
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
      '・読み上げるのは <#{voice}> にいる人の発言だけです\n・先頭に `;` を付けると読み上げません\n・{voiceCommand} で自分の声と速さを変えられます\n・{dictCommand} で読み方を登録できます\n・{skipCommand} で今の発言を飛ばし、{stopCommand} で終了します',
    noSpeakPermission:
      '⚠️ Botに <#{voice}> の「発言」権限がないため、声が届かない可能性があります。',
    noViewPermission:
      '⚠️ Botはこのチャンネルを閲覧できないため、ここでの発言は読み上げられません。読み上げるのはVCのチャットだけです。',
    credit: '音声: {credits}',
    stopped: '読み上げを終了しました',
    stoppedDesc: 'また使うときは {command} を実行してください。',
    stoppedByOptOut:
      '管理者が音声の保持を止めたため、Botは退出しました。`/tts start` を実行すると、音声を保持せずに読み上げを再開できます。',
    skipped: '今の発言を飛ばしました。',
    nothingToSkip: '今は何も読み上げていません。',
    voice: {
      currentTitle: 'あなたの読み上げ設定',
      current: '声: **{voice}**\n速さ: **{speed}倍**',
      changeHint:
        '{command} の `speaker` で声を、`speed` で速さ（0.5〜2.0）を変えられます。',
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
      notFoundTitle: '辞書に登録されていない単語です',
      notFound: '{word} は辞書に登録されていません。',
      notOwnerTitle: 'この単語は変更・削除できません',
      notOwner:
        '他の人が登録した単語は、登録した本人か{permission}の権限を持つ人だけが変更・削除できます。',
      fullTitle: '辞書がいっぱいです',
      full: '辞書の登録数が上限（{max}件）に達しています。不要な単語を {command} で削除してください。',
      listTitle: 'このサーバーの読み上げ辞書',
      listEmpty: 'まだ単語が登録されていません。{command} で登録できます。',
      listMore: '…ほか{count}件',
      invalidTitle: '入力内容を確認してください',
      invalid:
        '単語は1〜{wordMax}文字、読み方は1〜{readingMax}文字で入力してください。',
    },
  },
  captions: {
    errors: {
      notConfigured: '字幕は設定されていません',
      notConfiguredDesc:
        'このBotには音声認識エンジン（Whisper）が設定されていません。Bot運営者に `WHISPER_URL` の設定を依頼してください。',
      engineDown: '音声認識エンジンに接続できません',
      engineDownDesc:
        'Whisperが応答していません。少し待ってからもう一度お試しください。続く場合はBot運営者に連絡してください。',
      notInVoice: 'VCに参加してください',
      notInVoiceDesc:
        '字幕を付けたいVCに先に参加してから、{command} を実行してください。',
      busyElsewhere: 'Botは別のVCにいます',
      busyElsewhereDesc:
        'Botは今 <#{channel}> に参加しています（Discordの仕様で、1つのサーバーで同時に入れるVCは1つだけです）。そのVCで使うか、Botが抜けるまでお待ちください。',
      cannotJoin: 'VCに参加できませんでした',
      cannotJoinDesc:
        'Botにそのチャンネルの「接続」権限があるか、同時接続数の上限に達していないか確認してください。',
      notRunning: '字幕は動いていません',
      notRunningDesc: '{command} で字幕を始められます。',
      notInSameVoice: '操作できません',
      notInSameVoiceDesc:
        '字幕を表示しているVC（<#{channel}>）に参加している人か、{permission}の権限を持つ人だけが操作できます。',
    },
    started: '字幕を開始しました',
    startedDesc:
      '<#{voice}> での発言を文字にして、このVCのチャットに表示します。',
    consentCount:
      'VCにいる{members}人のうち、字幕を許可しているのは{consented}人です。',
    noPostPermission:
      '⚠️ Botに <#{voice}> の「チャンネルを見る」「メッセージを送信」権限がないため、字幕を表示できません。',
    howToTitle: '使い方',
    howTo:
      '・字幕は話してから数秒遅れて表示されます\n・{stopCommand} で終了します\n・VCに誰もいなくなると自動で終了します',
    stopped: '字幕を終了しました',
    stoppedDesc: 'また使うときは {command} を実行してください。',
    stoppedByOptOut:
      '管理者が音声の保持を止めたため、Botは退出しました。`/caption start` を実行すると、音声を保持せずに字幕を再開できます。',
    engineTrouble: '字幕が遅れています',
    engineTroubleDesc:
      '音声認識エンジンが応答しないため、字幕を作れていません。エンジンが戻ると自動で再開します。続く場合はBot運営者に連絡してください。',
    unknownSpeaker: '参加者',
    consent: {
      title: '字幕の許可',
      explain:
        '字幕になるのは、許可した人の声だけです。許可すると、字幕の実行中にあなたの声がBot運営者の用意した音声認識サーバーに送られ、文字にしてVCのチャットに投稿されます。音声そのものは保存しません。許可はこのサーバーだけに適用され、{command} かボタンでいつでも取り消せます。',
      statusAllowed:
        '✅ このサーバーでは、あなたの声を字幕にすることを許可しています。',
      statusNotAllowed:
        'このサーバーでは、あなたの声は字幕になりません（許可していません）。',
      allowButton: '字幕を許可する',
      revokeButton: '許可を取り消す',
      allowedTitle: '字幕を許可しました',
      allowed:
        'このサーバーで字幕が動いているときは、あなたの声も文字になってVCのチャットに表示されます。取り消すには {command} を使ってください。',
      revokedTitle: '字幕の許可を取り消しました',
      revoked:
        'このサーバーでは、あなたの声は字幕になりません。まだ表示されていない分も破棄しました。また許可するには {command} を使ってください。',
    },
  },
};
