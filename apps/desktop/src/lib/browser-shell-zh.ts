import { isRecord, mergeTranslations } from '@hermes/shared/i18n'

import type { TranslationOverrides } from '@/i18n/define-locale'
import { en } from '@/i18n/en'
import type { Translations } from '@/i18n/types'

/**
 * Chinese for the browser build where zh.ts still falls back to English: pages the
 * cloud shows (Connectors, the chat's error and approval notes, keyboard shortcuts,
 * notifications …), worded for the user's instance rather than "this computer".
 * One line of i18n/catalog.ts applies it (see browser-shell.ts for the other hooks).
 *
 * Only entries still English in zh.ts apply, so a translation that lands upstream
 * wins over ours; browser-shell-zh.test.ts names those, to drop here after a merge.
 * Technical words (MCP, URL, OAuth, STDIO, command examples) stay as they are.
 */
export const CLOUD_ZH: TranslationOverrides = {
  connectors: {
    checking: '正在检查你的应用…'
  },

  connectorsPage: {
    searchPlaceholder: count => `搜索 ${count} 个应用`,
    filterCategory: '分类',
    categoryAll: '全部分类',
    uncategorised: '未分类',
    residencyLocal: '在实例里运行',
    segment: {
      all: '全部',
      available: '可用',
      connected: '已连接',
      off: '已关闭'
    },
    group: {
      connected: '已连接',
      connectedNote: '连接出错的排在前面。',
      available: '可用',
      off: '已关闭',
      offNote: '登录状态会保留。'
    },
    card: {
      kindManaged: '托管',
      kindCatalog: 'MCP · 目录',
      kindCustom: 'MCP · 自定义',
      kindPlugin: plugin => `MCP · 插件 ${plugin}`,
      inCatalog: '在 UniWork 目录里',
      hostedTwin: '有托管版本可用',
      alsoLocal: '实例里也有一份在运行',
      open: name => `打开 ${name}`,
      turnServerOn: name => `开启 ${name}`,
      turnServerOff: name => `关闭 ${name}`,
      state: {
        accessExpired: '授权已过期',
        available: '可用',
        connected: '已连接',
        connecting: '正在连接',
        connectionUnknown: '状态未知',
        couldNotConnect: '连接失败',
        offByYourOrganisation: '已被组织关闭',
        offForYou: '已为你关闭',
        serverConnecting: '正在连接…',
        serverError: '出错',
        serverNeedsAuth: '需要授权',
        serverOff: '已关闭',
        serverOn: '已开启',
        serverOnUnused: '已开启，未使用'
      },
      fact: {
        tools: count => `${count} 个工具`,
        toolsOff: count => `${count} 个工具已关闭`,
        toolsOn: count => `${count} 个工具已开启`,
        toolsSomeOn: (total, on) => `${total} 个工具，${on} 个已开启`
      },
      verb: {
        authenticate: '授权',
        connect: '连接',
        install: '安装',
        openLogs: '打开日志',
        reconnect: '重新连接',
        stopWaiting: '不再等待',
        tryAgain: '重试',
        turnBackOn: '重新开启'
      },
      reason: {
        finishSignIn: '请在浏览器里完成登录。',
        reconnect: '重新连接后这个应用才能继续用。',
        serverError: '服务器拒绝了连接。',
        serverNeedsAuth: '登录后这个服务器才会响应。'
      }
    },
    page: {
      loading: '正在读取目录和实例里的服务器',
      emptyTitle: '这里还没有应用。在实例里添加一个服务器就能开始用。',
      noMatchTitle: '没有匹配的应用',
      noMatchBody: '没有匹配的结果。可以把你自己的 MCP 服务器加进来。',
      clearSearch: '清除搜索',
      hostedFailedTitle: '连不上托管应用。',
      hostedFailedBody: '实例里的服务器不受影响，仍在运行，没有关闭任何东西。',
      retry: '重试',
      matchesElsewhere: count => `其他分组里还有 ${count} 个匹配。`,
      showAllMatches: '显示全部匹配',
      segmentNoMatch: segment => `「${segment}」里没有匹配，所以显示全部匹配。`,
      freeTierNote: '登录之前，连接只保存在实例里。',
      signInLine: '登录 Nous 后才能使用托管应用。',
      signIn: '登录',
      managedUnavailable: '这个账号暂时不能使用托管应用。',
      writeFailed: '这次修改没有保存。',
      refreshFailed: '工具列表没有刷新。',
      disconnectNoAccount: '这里没有可以断开的账号。刷新页面后再试。',
      disconnectRefused: 'Nous 暂时无法移除这个登录。可以先用开关关闭这个应用，或者稍后再试。'
    },
    add: {
      action: '添加自己的',
      title: '连接自定义 MCP',
      hint: '在实例的 mcp.json 里新增一条',
      pasteLabel: '粘贴一条命令或一段配置',
      pasteNoMatch: '没有识别出服务器配置，请改为填写下面的字段。',
      name: '名称',
      nameTaken: '这个名称已经被用了。',
      type: '类型',
      command: '启动命令',
      args: '参数',
      addArg: '+ 添加参数',
      envVars: '环境变量',
      addEnvVar: '+ 添加环境变量',
      passthrough: '透传的环境变量',
      addPassthrough: '+ 添加变量',
      cwd: '工作目录',
      headers: '请求头',
      addHeader: '+ 添加请求头',
      auth: '认证',
      authNone: '无',
      authBearer: 'Bearer 令牌',
      valuePlaceholder: '值',
      removeRow: '删除这一行',
      editJson: '编辑 mcp.json',
      saveFailed: '这个服务器没有保存。'
    },
    dialog: {
      disconnect: '断开',
      disconnectTitle: name => `断开 ${name}？`,
      disconnectBody: 'UniWork 将不再以这个账号操作。之后随时可以重新连接。',
      menuRefreshTools: '刷新工具',
      moreActions: '更多操作',
      removeServerTitle: name => `移除 ${name}？`,
      removeServerBody: '只会从实例的 mcp.json 里删掉这一条，别的都不会删。',
      appSwitch: name => `允许 UniWork 使用 ${name}`,
      waysTitle: name => `${name} 在哪里运行`,
      wayNotConnected: name => `还没连接。请在浏览器里登录 ${name}。`,
      wayHosted: '托管',
      bothOn: name => `两边都开着，UniWork 会把每个 ${name} 工具看到两次。`,
      turnOffLocal: '关闭实例里的服务器',
      providedByPlugin: plugin => `由插件 ${plugin} 提供`,
      openPlugins: '打开插件页',
      nousLine: 'Nous 应用跟着账号走，不跟着配置档。',
      rulesReadOnly: '现在不能修改规则。',
      rulesAppOff: name => `先开启 ${name}，才能修改它的工具。`,
      rulesSignIn: '登录后才能修改 UniWork 在这里能做什么。',
      orgNote: count => `你的组织关闭了 ${count} 个工具。`,
      orgLink: '打开连接器管理后台',
      connectEnded: '登录没有完成。',
      connectOpenAgain: '重新打开链接',
      tokensPerCall: '每次调用的 token 数',
      usesPerMonth: '30 天内的调用次数',
      advanced: '高级',
      advancedHint: 'mcp.json 里的配置和日志'
    },
    tools: {
      title: '工具',
      notInstalledBody: '安装后才能看到它带来的工具。',
      summaryTitle: name => `UniWork 可以用 ${name} 做什么`,
      summaryPreviewTitle: name => `连接后 UniWork 可以用 ${name} 做什么`,
      summaryCount: count => `${count} 个工具`,
      summaryAllTools: '全部工具',
      summaryOther: '其他',
      allToolsSwitch: '开启或关闭全部工具',
      summaryAllOn: '全部开启',
      summarySomeOn: (on, total) => `${total} 个中 ${on} 个已开启`,
      summaryOff: '已关闭',
      showAllTools: count => `显示全部 ${count} 个工具`,
      showSummary: '显示摘要',
      facetSwitch: facet => `开启或关闭「${facet}」类工具`,
      staleSignIn: '登录后才能读取最新的工具列表。',
      searchCountPlaceholder: count => `搜索 ${count} 个工具`,
      toolList: name => `${name} 的工具`,
      categorySelect: count => `${count} 个分类`,
      showDeprecated: count => `显示 ${count} 个已弃用的`,
      hideDeprecated: count => `隐藏 ${count} 个已弃用的`,
      quickReadOnly: '只读',
      quickNoDestructive: '关闭破坏性操作',
      quickEverythingOn: '全部开启',
      lockedHint: '已被组织关闭',
      turnToolOn: tool => `开启 ${tool}`,
      turnToolOff: tool => `关闭 ${tool}`,
      showDetails: tool => `查看 ${tool} 的作用`,
      hideDetails: tool => `收起 ${tool} 的作用`,
      noMatch: '没有符合这些筛选条件的工具。',
      loading: '正在读取工具列表',
      unavailableLine: '工具列表不可用。',
      needsAuthTitle: name => `登录 ${name} 后才能读取它的工具。`,
      needsAuthBody: '登录信息只保存在实例里，不会外传。',
      retry: '重试',
      goneTitle: name => `${name} 已从目录中移除。`,
      goneBody: 'UniWork 不能再调用它。这一行会一直保留到你移除为止，不会凭空消失。',
      remove: '移除',
      offTitle: name => `${name} 已关闭。`,
      offBody: '用上面的开关开启后，才能读取它带来的工具。',
      signedOutTitle: '登录 Nous 后才能读取工具列表。',
      signedOutBody: '实例里的服务器不受影响。',
      conflictTitle: '你编辑的时候，有人改了这条规则。',
      conflictBody: (theyOff, theyOn) => {
        const they = [
          theyOff > 0 ? `关闭了 ${theyOff} 个你开着的工具` : '',
          theyOn > 0 ? `保留开启了 ${theyOn} 个你关掉的工具` : ''
        ].filter(Boolean)

        return `${they.length > 0 ? `对方${they.join('，并且')}。` : ''}你的修改还在屏幕上，没有写入。`
      },
      conflictReload: '载入对方的版本',
      conflictSave: '用我的版本覆盖',
      saveFailed: '这些工具规则没有保存。',
      footerDirty: (off, backOn) => `${off} 个工具关闭，${backOn === 0 ? '没有' : `${backOn} 个`}重新开启`,
      discard: '放弃',
      save: '保存修改',
      saving: '正在保存…'
    },
    vocabulary: {
      facetRead: { label: '读取', long: '从这个应用里读数据，不改任何东西。' },
      facetWrite: { label: '写入', long: '在这个应用里新建或修改内容。' },
      facetDestructive: { label: '破坏性', long: '可能把这个应用里的东西永久删掉。' },
      facetUnclassified: { label: '作用不明', long: '这个应用没有说明这个工具做什么。' },
      hintReadOnly: { label: '只读', long: '这个工具声明自己只读取。' },
      hintCreate: { label: '新建', long: '创建新的内容。' },
      hintUpdate: { label: '修改', long: '修改已有的内容。' },
      hintDelete: { label: '删除', long: '删除内容。' },
      hintDestructive: { label: '破坏性', long: '它做的修改在这里无法撤销。' },
      hintIdempotent: { label: '可重复', long: '运行两次和运行一次的效果一样。' },
      hintOpenWorld: { label: '外部', long: '会访问这个应用之外的东西。' }
    }
  },

  notifications: {
    compressDeferredDone: '上下文压缩完成',
    errors: {
      storageFailure: 'UniWork 无法写入它的数据目录。',
      rpcOutOfSync: '页面和后端的版本不一致，需要两边都更新。',
      restartHermesFailed: '无法重启 UniWork'
    },
    actions: {
      restartHermes: '重启 UniWork',
      openKeys: '打开密钥设置',
      openGateways: '打开网关设置',
      openMaintenance: '打开维护'
    }
  },

  titlebar: {
    developerModeEnabled: '开发者模式已开启'
  },

  keybinds: {
    clear: '清除',
    actions: {
      'view.cycleSidebarGrouping': '切换会话分组方式',
      'view.toggleHud': '切换 HUD 模式',
      'hud.snapToPointer': '把 HUD 移到鼠标位置（全局，HUD 打开时）',
      'view.newTerminal': '新建终端',
      'view.nextTerminal': '下一个终端',
      'view.prevTerminal': '上一个终端',
      'view.closeTerminal': '关闭终端',
      'view.tabSlot.1': '切换到第 1 个标签页',
      'view.tabSlot.2': '切换到第 2 个标签页',
      'view.tabSlot.3': '切换到第 3 个标签页',
      'view.tabSlot.4': '切换到第 4 个标签页',
      'view.tabSlot.5': '切换到第 5 个标签页',
      'view.tabSlot.6': '切换到第 6 个标签页',
      'view.tabSlot.7': '切换到第 7 个标签页',
      'view.tabSlot.8': '切换到第 8 个标签页',
      'view.tabSlot.9': '切换到第 9 个标签页'
    }
  },

  settings: {
    toolsets: {
      terminalBackend: {
        unavailableTitle: '无法运行终端命令',
        unavailableMessage: backend =>
          `UniWork 现在无法运行命令：${backend} 还没就绪。可以改用本地运行，或者把 ${backend} 配置好后再试。`,
        openBackendSettings: '打开终端设置',
        useLocal: '改用本地',
        switchedToLocal: '终端命令改为在本地运行，新会话生效。'
      }
    }
  },

  skills: {
    hub: {
      installBlockedTitle: name => `无法安装 ${name}`,
      installBlockedMessage: (findings, unverified) =>
        `安全扫描发现${findings > 0 ? ` ${findings} 处` : '一些'}需要检查的风险内容${unverified ? '，而且这个技能来自未经验证的来源' : ''}。决定是否信任作者之前，请先看扫描结果。`,
      viewScan: '查看扫描结果',
      openLog: '打开日志'
    }
  },

  profiles: {
    status: {
      unread: count => `${count} 个会话有未读消息`,
      needsInput: count => `${count} 个会话在等你回答`,
      working: count => `${count} 个会话正在运行`
    }
  },

  cron: {
    lastRunFailed: '上次运行失败：',
    editJob: '编辑任务',
    runAgain: '再运行一次',
    overdueSince: '逾期开始于：'
  },

  sidebar: {
    storageCorrupt: {
      title: '会话数据库已损坏',
      body: profiles => `UniWork 读不全 ${profiles} 的会话记录。列表里缺的对话没有被删除，是存放它们的文件损坏了。`,
      action: '先退出这个配置档上的 UniWork，在不修改文件的前提下检查它，或者恢复一个快照：',
      guide: '恢复指南'
    }
  },

  composer: {
    hiddenQueued: '设置说明',
    url: '网址…'
  },

  assistant: {
    thread: {
      errorLayerBodies: {
        auth: 'AI 服务拒绝了你的登录凭据。请检查这个提供方的凭据，然后重新发送消息。',
        billing: '你在这个提供方的余额已用完。请充值或换一个提供方，然后重新发送。',
        disk: '磁盘已满，UniWork 无法保存这次对话。请清理一些空间后重试。',
        gateway: 'UniWork 在开始回复时遇到内部问题。请重新发送消息；如果反复出现，请发送诊断信息。',
        runtime: 'UniWork 在开始回复时遇到内部问题。请重新发送消息；如果反复出现，请发送诊断信息。'
      },
      errorCodes: {
        auth: {
          title: provider => `${provider} 拒绝了你的登录凭据`,
          body: provider => `为 ${provider} 保存的凭据没有通过验证。请在设置里修正，或换一个提供方，然后重新发送消息。`
        },
        auth_permanent: {
          title: provider => `${provider} 拒绝了你的登录凭据`,
          body: provider => `为 ${provider} 保存的凭据无效或已被撤销。请更新凭据或换一个提供方，然后重新发送消息。`
        },
        billing: {
          title: '余额已用完',
          body: provider => `你的 ${provider} 账户余额已用完。请充值或换一个提供方，然后重新发送。`
        },
        stream_drop: {
          title: '回复被中断了',
          body: '回复还没完成，连接就断了。点「重试」重新发送。'
        },
        upstream_blocked: {
          title: '请求被防火墙拦下了',
          body: provider =>
            `${provider} 前面的防火墙或 CDN 在请求到达模型之前就把它拦下了，你的密钥多半没问题。可以在设置里给这个提供方的 extra_headers 加一个 User-Agent 请求头，或者换一个提供方，然后重新发送消息。`
        },
        context_overflow: {
          title: '这段对话太长了',
          body: '对话已经超出模型能处理的长度。请压缩对话或新开一个对话，然后重新发送。'
        },
        payload_too_large: {
          title: '这条消息太大了',
          body: '请求超出了模型能接受的大小。请压缩对话或新开一个对话，然后重新发送。'
        },
        model_not_found: {
          title: '这个模型不可用',
          body: provider => `${provider} 没有在你的账户上提供这个模型。请换一个模型，然后重新发送消息。`
        },
        truncated: {
          title: '回复被截断了',
          body: '模型在回复完成之前就停下了。点「重试」获取完整回复。'
        },
        loop_error: {
          title: 'UniWork 陷入了循环',
          body: '回复一直在重复相同的步骤，UniWork 已经把它停下。请重试；如果再次出现，请新开一个对话。'
        },
        SESSION_NOT_OWNED: {
          title: '这个对话在别处打开着',
          body: '这个对话正在另一个 UniWork 窗口或终端里打开。请先在那边关掉再重新发送，或者在这里新开一个对话。'
        },
        disk_full: {
          title: '磁盘已满',
          body: '磁盘已满，UniWork 无法保存这次对话。请清理一些空间后重试。'
        },
        free_tier_disabled: {
          title: '暂时不能在未登录的情况下使用 UniWork',
          body: '用 Nous 账号登录就能继续聊，免费。'
        },
        free_tier_rate_limited: {
          title: '未登录可用的额度已经用完',
          body: '额度很快会恢复。用 Nous 账号登录可以获得更多额度，免费。'
        },
        free_tier_at_capacity: {
          title: '未登录使用的人太多了',
          body: '登录可以免排队，免费；也可以稍后再试。'
        },
        free_tier_model_not_free: {
          title: '这个模型需要登录才能用',
          body: 'UniWork 暂时使用免费模型。用 Nous 账号登录可以使用更多模型，免费。'
        },
        free_tier_route: {
          title: 'UniWork 在这条线路上连不到免费模型',
          body: '用 Nous 账号登录（免费），或者检查 NOUS_INFERENCE_BASE_URL 设置。'
        },
        free_tier_outage: {
          title: '免费模型现在响应有问题',
          body: '请过一分钟再发送一次。'
        },
        free_tier_refused: {
          title: 'UniWork 无法在未登录的情况下发送',
          body: '用 Nous 账号登录是免费的。'
        }
      },
      errorAuthKinds: {
        api_key: {
          title: provider => `${provider} 拒绝了你的 API 密钥`,
          body: provider => `为 ${provider} 保存的密钥无效或已被撤销。请更新后重试。`
        },
        oauth: {
          title: provider => `你在 ${provider} 的登录已过期`
        }
      },
      errorDetails: '详情',
      errorToastTitle: 'UniWork 没能完成回复',
      errorChooseModel: '选择模型',
      errorCompressConversation: '压缩对话',
      errorCompressFailed: '无法压缩对话',
      errorOpenHermesFolder: '打开 UniWork 文件夹',
      errorOpenHermesFolderFailed: '无法打开 UniWork 文件夹',
      errorUpdateApiKey: '更新 API 密钥',
      errorSignInFreeTier: '用 Nous 账号登录'
    },
    approval: {
      reconnect: '重新连接',
      timedOutSystemLine: '审批超时，命令没有执行。可以让 UniWork 再试一次，或者在 设置 → 安全 → 审批超时 里调大时限。',
      openSafetySettings: '打开安全设置',
      commandDetails: '命令详情'
    }
  },

  prompts: {
    reconnect: '重新连接'
  },

  errors: {
    boundaryDetails: '详情'
  }
}

/** The overrides whose Chinese is still the English fallback: `defineLocale` copies
 * en's value into zh for every key zh.ts leaves out, so it is the very same value. */
export function stillEnglish(overrides: unknown, zh: unknown, english: unknown): unknown {
  if (!isRecord(overrides)) {
    return zh === english ? overrides : undefined
  }

  const kept: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(overrides)) {
    const child = stillEnglish(value, isRecord(zh) ? zh[key] : undefined, isRecord(english) ? english[key] : undefined)

    if (child !== undefined) {
      kept[key] = child
    }
  }

  return Object.keys(kept).length > 0 ? kept : undefined
}

/** zh with the cloud's Chinese filled in, in the browser build only (i18n/catalog.ts).
 * Read from the build flag: the catalog loads before the bridge marks the document. */
export function withCloudChinese(zh: Translations): Translations {
  if (import.meta.env.VITE_HERMES_BROWSER_BUILD !== '1') {
    return zh
  }

  return mergeTranslations<Translations>(zh, stillEnglish(CLOUD_ZH, zh, en) as TranslationOverrides | undefined)
}
