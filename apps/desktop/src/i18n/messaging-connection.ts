import type { Locale } from './types'

export interface MessagingConnectionCopy {
  restoring: string
  restoreFailed: string
  ownership: string
  reconnecting: string
  disconnected: string
  saving: string
  restarting: string
  stopping: string
  checking: string
  applied: string
  saveFailed: string
  connecting: string
  savedFailed: string
  duplicateTitle: string
  duplicateDescription: string
  invalid: string
  network: string
  timeout: string
  unavailable: string
  newSecret: string
}

export const messagingConnectionCopy: Record<Locale, MessagingConnectionCopy> = {
  en: {
    reconnecting: 'The gateway is reconnecting using its built-in policy. Desktop chat is available.',
    disconnected: 'Some messaging connections are unavailable. Check the platform settings or logs. Desktop chat is available.',
    restoring: 'Restoring messaging connections…',
    restoreFailed: 'Messaging could not be restored. Desktop chat is available. Retry the connection or open logs.',
    ownership: 'The existing gateway’s ownership could not be verified. No new gateway was started. Open logs for details.',
    saving: "Validating and saving messaging settings…",
    restarting: "Messaging gateway is restarting… Other chat apps will disconnect briefly.",
    stopping: "Messaging gateway is stopping…",
    checking: "Checking messaging platform status…",
    applied: "Messaging settings applied.",
    saveFailed: "Could not save messaging settings. Your previous configuration is unchanged.",
    connecting: 'Connecting… Other chat apps may disconnect briefly.',
    savedFailed: 'Settings saved, but the messaging connection could not be restored. Retry the connection.',
    duplicateTitle: 'Bot already used on this device',
    duplicateDescription: 'Another account or Profile uses this bot. Continuing may disconnect it. Continue?',
    invalid: 'ID or Secret was rejected.',
    network: 'Could not reach the platform. Your saved settings are unchanged.',
    timeout: 'Validation timed out. Your saved settings are unchanged.',
    unavailable: 'The platform returned an unexpected response. Try again.',
    newSecret: 'Enter the Secret when changing the bot ID.'
  },
  zh: {
    reconnecting: '网关正在按原版策略重连，桌面聊天不受影响。',
    disconnected: '部分消息平台连接不可用，请检查平台配置或日志。桌面聊天不受影响。',
    restoring: '正在恢复消息平台连接…',
    restoreFailed: '消息平台自动连接失败，桌面聊天不受影响。可重试连接或查看日志。',
    ownership: '无法确认现有网关归属，未启动新的网关，请查看日志。',
    saving: "正在校验并保存消息平台配置…",
    restarting: "网关正在重启，其它消息平台会短暂断开…",
    stopping: "网关正在停止…",
    checking: "正在确认消息平台状态…",
    applied: "消息平台配置已应用。",
    saveFailed: "消息平台配置保存失败，原配置保持不变。",
    connecting: '正在连接，其它消息平台会短暂断开。',
    savedFailed: '配置已保存，但消息连接恢复失败，请重试连接。',
    duplicateTitle: '此机器人已在本机使用',
    duplicateDescription: '其它账号或 Profile 已使用此机器人，继续可能使其断开。是否继续？',
    invalid: 'ID 或 Secret 无效，请检查后重试。',
    network: '无法连接平台，原配置保持不变。',
    timeout: '校验超时，原配置保持不变。',
    unavailable: '平台响应异常，请稍后重试。',
    newSecret: '更换机器人 ID 时，请同时填写对应 Secret。'
  },
  'zh-hant': {
    reconnecting: '閘道正在按原版策略重新連線，桌面聊天不受影響。',
    disconnected: '部分訊息平台連線不可用，請檢查平台設定或日誌。桌面聊天不受影響。',
    restoring: '正在恢復訊息平台連線…',
    restoreFailed: '訊息平台自動連線失敗，桌面聊天不受影響。可重試連線或查看日誌。',
    ownership: '無法確認現有閘道歸屬，未啟動新的閘道，請查看日誌。',
    saving: "正在驗證並儲存訊息平台設定…",
    restarting: "閘道正在重新啟動，其他訊息平台會短暫斷線…",
    stopping: "閘道正在停止…",
    checking: "正在確認訊息平台狀態…",
    applied: "訊息平台設定已套用。",
    saveFailed: "訊息平台設定儲存失敗，原設定保持不變。",
    connecting: '正在連線，其他訊息平台會短暫斷線。',
    savedFailed: '設定已儲存，但訊息連線恢復失敗，請重試連線。',
    duplicateTitle: '此機器人已在本機使用',
    duplicateDescription: '其他帳號或 Profile 已使用此機器人，繼續可能使其斷線。是否繼續？',
    invalid: 'ID 或 Secret 無效，請檢查後重試。',
    network: '無法連線至平台，原設定保持不變。',
    timeout: '驗證逾時，原設定保持不變。',
    unavailable: '平台回應異常，請稍後重試。',
    newSecret: '更換機器人 ID 時，請同時填寫對應的 Secret。'
  },
  ja: {
    reconnecting: 'ゲートウェイが標準の方針で再接続しています。デスクトップチャットは利用できます。',
    disconnected: '一部のメッセージ接続が利用できません。設定やログを確認してください。デスクトップチャットは利用できます。',
    restoring: 'メッセージ接続を復元しています…',
    restoreFailed: 'メッセージ接続を復元できませんでした。デスクトップチャットは利用できます。再試行するかログを確認してください。',
    ownership: '既存ゲートウェイの所有元を確認できないため、新規起動はしていません。ログを確認してください。',
    saving: "メッセージ設定を検証して保存しています…",
    restarting: "メッセージゲートウェイを再起動しています。他のチャットは一時切断されます。",
    stopping: "メッセージゲートウェイを停止しています…",
    checking: "メッセージプラットフォームの状態を確認しています…",
    applied: "メッセージ設定を適用しました。",
    saveFailed: "設定を保存できませんでした。以前の設定は変更されていません。",
    connecting: '接続中です。他のチャットアプリは一時的に切断されます。',
    savedFailed: '設定は保存されましたが、接続を復元できませんでした。再試行してください。',
    duplicateTitle: 'この端末で使用中のボット',
    duplicateDescription:
      '別のアカウントまたは Profile が使用中です。続行すると切断される場合があります。続行しますか？',
    invalid: 'ID または Secret が拒否されました。',
    network: '接続できません。保存済み設定は変更されていません。',
    timeout: '検証がタイムアウトしました。設定は変更されていません。',
    unavailable: 'プラットフォームの応答が不正です。再試行してください。',
    newSecret: 'ボット ID を変更する場合は Secret も入力してください。'
  },
  ar: {
    reconnecting: 'تعيد البوابة الاتصال وفق سياستها الأصلية. الدردشة المكتبية متاحة.',
    disconnected: 'بعض اتصالات المراسلة غير متاحة. تحقق من إعدادات المنصة أو السجلات. الدردشة المكتبية متاحة.',
    restoring: 'جارٍ استعادة اتصالات المراسلة…',
    restoreFailed: 'تعذرت استعادة المراسلة. الدردشة المكتبية متاحة. أعد المحاولة أو افتح السجلات.',
    ownership: 'تعذر التحقق من ملكية البوابة الحالية. لم تُشغّل بوابة جديدة. افتح السجلات للتفاصيل.',
    saving: "جارٍ التحقق من إعدادات المراسلة وحفظها…",
    restarting: "جارٍ إعادة تشغيل بوابة المراسلة. ستنقطع التطبيقات الأخرى مؤقتًا.",
    stopping: "جارٍ إيقاف بوابة المراسلة…",
    checking: "جارٍ التحقق من حالة منصات المراسلة…",
    applied: "تم تطبيق إعدادات المراسلة.",
    saveFailed: "تعذر حفظ إعدادات المراسلة. لم تتغير الإعدادات السابقة.",
    connecting: 'جارٍ الاتصال. قد تنقطع تطبيقات المحادثة الأخرى مؤقتًا.',
    savedFailed: 'حُفظت الإعدادات ولكن تعذرت استعادة الاتصال. أعد المحاولة.',
    duplicateTitle: 'الروبوت مستخدم على هذا الجهاز',
    duplicateDescription: 'يستخدم حساب أو Profile آخر هذا الروبوت. قد يؤدي المتابعة إلى فصله. هل تريد المتابعة؟',
    invalid: 'تم رفض المعرّف أو السر.',
    network: 'تعذر الاتصال بالمنصة. لم تتغير الإعدادات المحفوظة.',
    timeout: 'انتهت مهلة التحقق. لم تتغير الإعدادات.',
    unavailable: 'استجابة المنصة غير متوقعة. حاول مجددًا.',
    newSecret: 'أدخل السر عند تغيير معرّف الروبوت.'
  },
  ru: {
    reconnecting: 'Шлюз переподключается по встроенным правилам. Чат на компьютере доступен.',
    disconnected: 'Некоторые подключения сообщений недоступны. Проверьте настройки или журнал. Чат на компьютере доступен.',
    restoring: 'Восстановление подключений сообщений…',
    restoreFailed: 'Не удалось восстановить сообщения. Чат на компьютере доступен. Повторите попытку или откройте журнал.',
    ownership: 'Не удалось проверить принадлежность шлюза. Новый шлюз не запущен. Подробности в журнале.',
    saving: "Проверка и сохранение настроек сообщений…",
    restarting: "Шлюз сообщений перезапускается. Другие чаты ненадолго отключатся.",
    stopping: "Шлюз сообщений останавливается…",
    checking: "Проверка состояния платформ сообщений…",
    applied: "Настройки сообщений применены.",
    saveFailed: "Не удалось сохранить настройки сообщений. Прежняя конфигурация не изменена.",
    connecting: 'Подключение… Другие чаты могут ненадолго отключиться.',
    savedFailed: 'Настройки сохранены, но подключение восстановить не удалось. Повторите попытку.',
    duplicateTitle: 'Бот уже используется на этом устройстве',
    duplicateDescription:
      'Другой аккаунт или Profile использует этого бота. Продолжение может отключить его. Продолжить?',
    invalid: 'ID или Secret отклонён.',
    network: 'Не удалось связаться с платформой. Настройки не изменены.',
    timeout: 'Время проверки истекло. Настройки не изменены.',
    unavailable: 'Неожиданный ответ платформы. Повторите попытку.',
    newSecret: 'При смене ID бота введите соответствующий Secret.'
  },
  fr: {
    reconnecting: 'La passerelle se reconnecte selon sa politique intégrée. Le chat reste disponible.',
    disconnected: 'Certaines connexions sont indisponibles. Vérifiez les paramètres ou les journaux. Le chat reste disponible.',
    restoring: 'Rétablissement des connexions de messagerie…',
    restoreFailed: 'Impossible de rétablir la messagerie. Le chat reste disponible. Réessayez ou consultez les journaux.',
    ownership: 'Le propriétaire de la passerelle existante n’a pas pu être vérifié. Aucune nouvelle passerelle n’a été lancée. Consultez les journaux.',
    saving: "Vérification et enregistrement des paramètres de messagerie…",
    restarting: "La passerelle redémarre. Les autres applications seront brièvement déconnectées.",
    stopping: "La passerelle de messagerie s’arrête…",
    checking: "Vérification de l’état des plateformes de messagerie…",
    applied: "Paramètres de messagerie appliqués.",
    saveFailed: "Impossible d’enregistrer les paramètres. La configuration précédente est inchangée.",
    connecting: 'Connexion… Les autres applications peuvent être brièvement déconnectées.',
    savedFailed: 'Paramètres enregistrés, mais la connexion n’a pas pu être rétablie. Réessayez.',
    duplicateTitle: 'Robot déjà utilisé sur cet appareil',
    duplicateDescription: 'Un autre compte ou Profile utilise ce robot. Continuer peut le déconnecter. Continuer ?',
    invalid: 'ID ou Secret refusé.',
    network: 'Plateforme inaccessible. Les paramètres enregistrés sont inchangés.',
    timeout: 'Délai de validation dépassé. Les paramètres sont inchangés.',
    unavailable: 'Réponse inattendue de la plateforme. Réessayez.',
    newSecret: 'Saisissez le Secret correspondant lors du changement d’ID.'
  },
  de: {
    reconnecting: 'Das Gateway verbindet sich nach seiner integrierten Richtlinie neu. Der Desktop-Chat bleibt verfügbar.',
    disconnected: 'Einige Nachrichtenverbindungen sind nicht verfügbar. Einstellungen oder Protokolle prüfen. Der Desktop-Chat bleibt verfügbar.',
    restoring: 'Nachrichtenverbindungen werden wiederhergestellt…',
    restoreFailed: 'Nachrichten konnten nicht wiederhergestellt werden. Der Desktop-Chat bleibt verfügbar. Erneut versuchen oder Protokolle öffnen.',
    ownership: 'Die Zuordnung des vorhandenen Gateways konnte nicht bestätigt werden. Kein neues Gateway wurde gestartet. Protokolle öffnen.',
    saving: "Nachrichteneinstellungen werden geprüft und gespeichert…",
    restarting: "Das Nachrichten-Gateway startet neu. Andere Chats werden kurz getrennt.",
    stopping: "Das Nachrichten-Gateway wird gestoppt…",
    checking: "Status der Nachrichtenplattformen wird geprüft…",
    applied: "Nachrichteneinstellungen angewendet.",
    saveFailed: "Einstellungen konnten nicht gespeichert werden. Die bisherige Konfiguration bleibt unverändert.",
    connecting: 'Verbindung wird hergestellt… Andere Chats werden kurz getrennt.',
    savedFailed: 'Einstellungen gespeichert, Verbindung konnte nicht wiederhergestellt werden. Bitte erneut versuchen.',
    duplicateTitle: 'Bot wird auf diesem Gerät verwendet',
    duplicateDescription:
      'Ein anderes Konto oder Profile verwendet diesen Bot. Fortfahren kann es trennen. Fortfahren?',
    invalid: 'ID oder Secret wurde abgelehnt.',
    network: 'Plattform nicht erreichbar. Gespeicherte Einstellungen bleiben unverändert.',
    timeout: 'Zeitüberschreitung bei der Prüfung. Einstellungen bleiben unverändert.',
    unavailable: 'Unerwartete Antwort der Plattform. Bitte erneut versuchen.',
    newSecret: 'Beim Ändern der Bot-ID auch das zugehörige Secret eingeben.'
  },
  es: {
    reconnecting: 'La pasarela se reconecta según su política integrada. El chat de escritorio sigue disponible.',
    disconnected: 'Algunas conexiones no están disponibles. Revisa la configuración o los registros. El chat de escritorio sigue disponible.',
    restoring: 'Restaurando las conexiones de mensajes…',
    restoreFailed: 'No se pudieron restaurar los mensajes. El chat de escritorio sigue disponible. Reinténtalo o abre los registros.',
    ownership: 'No se pudo verificar a quién pertenece la pasarela existente. No se inició otra pasarela. Consulta los registros.',
    saving: "Validando y guardando la configuración de mensajes…",
    restarting: "La pasarela se está reiniciando. Las otras aplicaciones se desconectarán brevemente.",
    stopping: "La pasarela de mensajes se está deteniendo…",
    checking: "Comprobando el estado de las plataformas de mensajes…",
    applied: "Configuración de mensajes aplicada.",
    saveFailed: "No se pudo guardar la configuración. La configuración anterior no ha cambiado.",
    connecting: 'Conectando… Las otras aplicaciones pueden desconectarse brevemente.',
    savedFailed: 'Configuración guardada, pero no se pudo restablecer la conexión. Reinténtalo.',
    duplicateTitle: 'Bot ya utilizado en este dispositivo',
    duplicateDescription: 'Otra cuenta o Profile utiliza este bot. Continuar puede desconectarlo. ¿Continuar?',
    invalid: 'ID o Secret rechazado.',
    network: 'No se pudo contactar con la plataforma. La configuración guardada no ha cambiado.',
    timeout: 'La validación agotó el tiempo. La configuración no ha cambiado.',
    unavailable: 'Respuesta inesperada de la plataforma. Reinténtalo.',
    newSecret: 'Al cambiar el ID del bot, introduce también el Secret correspondiente.'
  }
}
