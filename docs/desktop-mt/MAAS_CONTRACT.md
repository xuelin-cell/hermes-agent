# MaaS 登录与套餐接口

当前解析规则来自 `apps/desktop/electron/login/`。请求固定由 Electron 主进程发出，Renderer 不提供上游 URL、请求头或已登录身份声明。

## 请求

根地址：`https://maas.ai-yuanjing.com/app`。

| 动作 | 方法与路径 | 请求 |
| --- | --- | --- |
| 图形验证码 | `GET /login/captcha` | 无参数 |
| 短信发送 | `POST /login/sendCode` | JSON：`phone`、`captchaCode`、`captchaId` |
| 短信登录 | `POST /login/smsLogin` | JSON：`phone`、`smsCode`、`origin: app`、`application: uniwork` |
| 套餐查询 | `GET /gateway/uniwork/my-plan` | `Authorization: Bearer <登录 token>` |

请求使用 `Accept: application/json`，POST 为 JSON。超时 15 秒，拒绝跳转、不携带 Cookie、不缓存，不自动重试。

## 验证码与短信

验证码须 HTTP 成功且业务 `code` 为数值 `0` 或字符串 `"0"`；`data` 中须有非空 `captchaId` 和带 PNG／JPEG／GIF base64 前缀的 `b64s`，不接受 SVG 或普通 URL。

短信输入须为 11 位且以 1 开头的手机号，图片码非空且不超过六位，captchaId 非空。发送成功同样要求 HTTP 成功及 `code=0/"0"`，成功后冷却至少 60 秒。

HTTP 429 和有效 `Retry-After` 使用响应期限；429 无有效期限时等待 60 秒。未知业务失败不猜测限流语义。冷却只属于当前主进程发送器，不跨应用重启持久化。

## 登录身份

登录须 HTTP 成功，JSON 为对象；业务 `code` 允许 `0`、`"0"` 或缺失。存在 `data` 时必须是对象，否则使用根对象。

| 字段 | 解析 |
| --- | --- |
| `uid` | 去除两端空白的非空字符串，或非负安全整数转为字符串 |
| `token` | 去除两端空白的非空字符串 |
| `expiresAt` | Unix 毫秒安全整数，必须在未来且不超过日期范围 |
| `expireIn / expires_in` | `expiresAt` 缺失或为空时使用有限正秒数计算；`expireIn` 优先 |

缺失、过去或非法期限不补默认值，超出安全整数范围的数值 UID 不四舍五入。登录成功必须先完成加密存储。

身份域固定为 `maas.ai-yuanjing.com/uniwork`。本地恢复校验整份加密记录并沿用原 UID、token 和期限，不请求在线身份验证、不解析 JWT、不刷新或延长期限。

## 套餐与模型

套餐 JSON 允许根对象或合法 `data` 对象；业务 `code` 允许 `0`、`"0"` 或缺失，仍须完整校验字段。

- 仅 `apiKey=null` 且 `models=null` 作为 `empty`。
- 可用套餐须有非空字符串 `apiKey`，以及对象或 JSON 字符串形式的模型目录。
- 目录包含非空 `models` 数组，可选 `main_model_id`。模型名使用 `model`，缺少时使用有效 ID。
- 模型 ID 接受字符串或非负安全整数。默认按主模型 ID 匹配，未指定或未匹配取首项。
- 每个模型保留自己的 HTTP(S) 端点，不带账号密码、查询参数或片段；去掉末尾斜线后，缺少末尾 `/v1` 时补齐。
- 保留条目顺序，不按模型名合并不同端点。坏条目拒绝整份目录。

缺字段、缺 Key、坏 JSON、不完整目录、业务失败和网络错误为 `failed`，不作为空套餐。HTTP 401／403 另外标记 `reason: auth`，不自动注销。

完整目录和模型 Key 由主进程交给账号环境准备；新增 IPC 仅返回状态、模型名称与默认标记。落盘规则见[账号环境](02-local-environment.md#p13--专用模型-key)。

## 凭据与期限边界

登录 token 用于登录后的平台请求，`my-plan.apiKey` 用于模型调用，二者不可互换。套餐结果不验证登录身份，空套餐和 HTTP 200 不证明 token 有效。

运行中期限到达只触发客户端提示，任务继续。模型调用是否被平台拒绝以实际响应为准；客户端不推断登录 token 与模型 Key 同时到期。

## 验证范围

真实验证码取图及刷新有观察记录。短信、登录、套餐、失败响应和限流解析主要由受控响应测试覆盖；Windows 系统加密、跨进程恢复、配置写入及桌面链路由隔离夹具执行。

真实收信、登录响应、同账号跨登录 UID、有效无套餐和过期／撤销凭据的上游行为仍缺少完整验收记录。完整状态见[生命周期与验收](03-lifecycle-and-acceptance.md#p26--当前验收状态)。

不记录或回显完整手机号、验证码、短信码、token、Key 或未知响应原文。
