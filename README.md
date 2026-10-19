# X-Ecommerce

基于 EchoTik 的电商研究与内容创作平台。本项目按照保存的 Clipcat 界面和已确认的功能流程实现，使用自己的品牌、前后端代码和数据接入。当前版本 **0.2.0**，包含运营后台、账号与团队、工作空间隔离、额度账本和可配置支付/对象存储，数据库使用 **MySQL 8.4**。

> 本地页面、持久化和工作流可运行。EchoTik、Gemini、fal.ai、TikTok 尚无真实账户凭证，因此没有实际消费额度、生成视频或发布内容；对应连接器已实现；Stripe 和 S3 也提供可配置适配。真实供应商响应、应用审核和生产部署需在接入后联调。不能把本版称为已经通过全部生产验证的 1:1 替代品。

## 本机运行

需要 Node.js 22.19+（本次使用 25.9）和 MySQL 8.4。

```bash
npm ci
```

本机已安装 MySQL 时，使用独立实例，不修改系统实例：

```bash
npm run db:local
```

另开终端：

```bash
npm run dev
```

打开 **http://localhost:4317**。`db:local` 首次生成随机数据库密码，写入被 Git 忽略、权限为 600 的 `.env.local`；数据库文件在 `.local/mysql/`，仅监听 `127.0.0.1:3308`。MySQL 进程在前台运行，终止这个命令会关闭该独立实例。重新启动相同命令会继续使用已有数据。

如果使用已有 MySQL，复制 `.env.example` 为 `.env.local`，填写连接信息，先创建 `x_ecommerce` 数据库并授予该应用用户权限。启动时会自动创建表，不会删除表或已有记录。

也提供 `compose.yaml`。使用 Docker 时，配置 `.env` 中的 `MYSQL_PASSWORD` 和 `MYSQL_ROOT_PASSWORD` 后运行 `npm run db:docker`，不要同时在 3308 端口启动两个实例。

构建与运行构建产物：

```bash
npm run build
npm start
```

## 配置服务

进入“连接与设置”。凭证也可以通过环境变量传入；界面保存的配置优先。设置接口只返回凭证是否存在，不返回原值。空密码字段保留原配置，勾选“移除此凭证”才能清除。

| 服务                   | 配置                                             | 用途                                             |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------ |
| EchoTik                | `ECHOTIK_USERNAME`、`ECHOTIK_PASSWORD`           | 实时搜索、经营指标、评论、下载解析               |
| Gemini                 | `GEMINI_API_KEY`、`GEMINI_MODEL`                 | 视频理解、脚本、评论洞察、提示词提取与语义检索   |
| fal.ai                 | `FAL_KEY` 与四个模型配置                         | 图像生成、参考图编辑、商品转视频、角色参考、超分 |
| TikTok                 | Client Key、Client Secret、回调 URI、scopes      | OAuth、直接发布、草稿箱、内容分析                |
| 独立视频解析器（可选） | `DOWNLOAD_RESOLVER_URL`、`DOWNLOAD_RESOLVER_KEY` | 抖音链接解析；EchoTik 不提供这一能力             |

EchoTik 使用 API 专属 username/password 的 HTTP Basic，不是 TikTok 密码或默认 Bearer Key。官方入口：[API Keys](https://echotik.live/platform/api-keys)、[认证说明](https://opendocs.echotik.live/authentication)。

当前媒体请求 schema 对应：

- `fal-ai/flux/schnell`：无参考图的文生图。
- `fal-ai/nano-banana-2/edit`：最多 5 张参考图的图片生成及视频首帧构图。
- `fal-ai/kling-video/v3/standard/image-to-video`：图生视频，可传角色 elements。
- `fal-ai/topaz/upscale/video`：超分，按短边目标尺寸计算 upscale_factor。

修改模型 ID 时，应同时检查该模型 schema，不能假设任意模型可替换。当前视频流程先根据商品图、角色与画幅生成首帧，再生成带声音的视频，属于两次供应商生成请求；复刻另含 Gemini 视频分析请求。实际费用由供应商决定，平台内部额度可自行配置，不代表供应商收费报价。

独立解析器的约定为 `POST <DOWNLOAD_RESOLVER_URL>`，JSON 输入 `{ "url": "公开视频分享链接" }`，可选 `Authorization: Bearer <KEY>`，JSON 返回 `{ "video_url": "https://.../video.mp4" }`。该配置指向你自己的适配服务；本项目未预置、购买或验证第三方抖音数据服务。

## Clipcat 功能对照

| 能力       | 本版实现                                                       | 实际外部依赖                               |
| ---------- | -------------------------------------------------------------- | ------------------------------------------ |
| 工作台     | 商品图片、内容要求、模式、语言、比例、角色、草稿               | MySQL；生成需下列服务                      |
| 数据智能   | 78 个独立官方 GET 接口；榜单、最新搜索、详情、趋势、评论与关联 | EchoTik                                    |
| 商品研究   | 商品详情与当前评价组合任务，保留原始响应                       | EchoTik；进一步痛点分析需 Gemini           |
| 竞品       | 保存达人/店铺清单，同步一页关联带货视频                        | EchoTik；当前为手动同步                    |
| 提示词库   | 从真实视频分析入库、保留来源、搜索、复用；原创模板单独标识     | Gemini；TikTok 链接解析另需 EchoTik        |
| 视频分析   | 本地视频或链接，脚本、分镜、钩子、音乐与销售原因推断           | Gemini；分享链接另需解析                   |
| 一键复刻   | 分析参考视频 → 用自有产品改写 → 首帧 → 视频                    | Gemini + fal.ai；TikTok 参考链接需 EchoTik |
| 商品转视频 | 多张商品图、UGC/演示/访谈风格、首帧构图、图生视频              | fal.ai                                     |
| 图片生成   | 文生图与最多 5 张参考图编辑                                    | fal.ai                                     |
| 视频超分   | 720p、1080p、2K 短边目标，读取素材尺寸计算放大倍数             | fal.ai / Topaz                             |
| 可复用角色 | 图片角色、浏览器视频抽帧、MySQL 保存、生成时传模型 elements    | 本地可创建；生成需 fal.ai                  |
| 素材库     | 上传、预览、搜索、标签、重命名、下载、删除                     | MySQL + 本地文件                           |
| 任务       | 持久队列、状态轮询、定时、取消、供应商查询与重启恢复           | MySQL；本地服务保持运行                    |
| 发布       | TikTok OAuth、账号信息、显式可见范围、发布/30 天内定时/草稿箱  | TikTok 应用、scopes 与审核                 |
| 分析       | 真实任务和接口用量；已授权账号的视频表现                       | 本地数据；账号内容需 video.list            |
| 下载       | TikTok 经 EchoTik 解析，视频直链下载；抖音走可配置独立解析器   | 对应数据/解析服务                          |

**本版没有复制 Clipcat 的专有提示词数据库、后台算法、模型账户或视频素材。** 提示词库从实际视频逐步积累；没有虚构高 GMV 案例或模拟生成成功。销售原因属于推断，不是因果或业绩保证。

2026-10-19 对视频复刻再次进行了 REA 核查：[证据报告](docs/research/clipcat-replication-evidence-2026-10-19.md)。Clipcat 公开项目页明确区分需求理解、分镜脚本与视频生成，并消费 `concatStatus` 拼接状态；raw 可按模型能力提交视频与图片混合参考。仍未取得其服务端模型派发、逐镜任务映射和拼接算法。当前 X-Ecommerce 的 Gemini 分析 → 商品首帧 → Kling 图生视频是本项目独立实现，不能称为已经确认与 Clipcat 的生成算法一致。本轮只更新研究证据，未据猜测改变生成链路。

## 新增后台与使用入口

- **项目与分镜**：草稿 → 脚本生成 → 等待确认 → 编辑分镜 → 确认 1–4 条视频 → 子任务。确认保存版本快照，相同确认请求不会重复生成；部分成功时仅重试失败子项。复刻项目可通过 API 设置 `input.mode=replicate` 并提供参考视频，从分析开始。
- **自动采集与机会**：按 15 分钟到 30 天的间隔采集 EchoTik AI 带货视频榜单，或组合商品榜单、详情、评论及 Gemini 分析；采集证据进入观察/机会库。可选择提取前 2 条视频的提示词。服务运行时才执行计划。
- **模型与高级生成**：已适配模型目录及原始 JSON 输入；模型限制在配置的四个适配器及平台环境 `FAL_EXTRA_MODELS_JSON` 白名单内。更换模型要检查 schema。
- **账号与团队**：首位管理员初始化、密码散列、服务端会话、邀请注册、已有账号接受邀请、空间切换、成员角色修改/移除、退出空间、账号停用、操作审计。角色为 owner/admin/operator/viewer，viewer 为本项目扩展。
- **额度与订单**：可选平台内部额度计量、发放、任务预留、成功结算、失败/未提交取消释放、幂等流水和订单状态。内部单位不是供应商价格。只有平台管理员可以发放额度、修改任务单价和存储限额；默认未启用计量。
- **素材存储**：本地文件或 S3 兼容存储；签名上传 → 大小/类型/文件头校验 → 独立素材对象确认。上传申请会预留容量，过期由 worker 清理。
- **独立 worker**：`npm run worker`；MySQL 锁保证单个调度者，任务锁防止手动查询和后台轮询同时推进两阶段生成。单个任务失败不会自动重复提交不确定的付费请求。

这些是依据公开客户端证据独立实现的后台，并非 Clipcat 的服务端源码。REA 实际运行收据、接口节点和无法恢复的边界见 [后台逆向方向](docs/research/clipcat-backend-direction-2026-10-19.md)。本项目尚未提供 Clipcat 专有案例库、积分批次有效期/到期扣除、退款/争议的自动追缴、企业 SSO、邮件投递或生产监控告警。支付侧当前支持购买/订阅到账与幂等发放；退款、取消订阅可先在 Stripe 管理后台处理，自动账务联动尚未实现。

## 登录与部署配置

`npm run dev` 默认是仅面向本机的可信开发模式；访问 `/account` 可初始化管理员。需要验证用户权限或共享访问时，设置 `AUTH_REQUIRED=true` 并重启。`npm start` 在 production 环境默认要求登录。首位初始化管理员会接管已有 local 工作空间；后续用户通过邀请加入。部署时先完成首位管理员初始化，再开放给用户。临时测试账号均由测试自动清理，没有替用户创建管理员或设置密码。

部署使用稳定的 `X_ENCRYPTION_KEY`（64 位十六进制，备份时同时保留）、MySQL 连接信息、`APP_PUBLIC_URL=https://你的域名`、`X_ALLOWED_HOSTS=你的域名` 和 HTTPS 反向代理。Web 服务可设置 `WORKER_EXTERNAL=true`，单独运行 `npm run worker`；多个 worker 可以启动，但同一时刻只有一个获得 MySQL 调度锁。开发绑定仍为 `127.0.0.1`，公网监听需要显式配置 HOST。反向代理转发原始 Host，并保持同域 API。

### Stripe（可选）

平台环境变量（不通过租户设置下发）：

```dotenv
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
APP_PUBLIC_URL=http://localhost:4317
BILLING_PACKS_JSON=[]
```

`BILLING_PACKS_JSON` 格式：`[{"id":"starter","name":"入门额度","priceId":"price_你的真实价格ID","credits":100,"mode":"payment"}]`，订阅使用 `mode=subscription`。需要先在自己的 Stripe 测试环境建立 Price，再配置；未配置时购买入口不启用。Webhook 地址 `/api/billing/webhook`，支持 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`checkout.session.expired`、`invoice.paid`。必须使用原始 body 验签，发放通过 session/invoice 唯一引用去重；浏览器成功回跳不直接发放额度。订阅周期通过实际 paid invoice 确认。

### S3 / R2 / MinIO（可选）

```dotenv
STORAGE_DRIVER=s3
S3_ENDPOINT=
S3_REGION=auto
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=false
```

AWS S3 通常不填 endpoint，并填写实际 region；R2/MinIO 填兼容 endpoint，MinIO 通常使用 path style。存储桶保持私有，浏览器直传需要桶 CORS 允许自己的站点发起 PUT 和 Content-Type 请求头。签名有效期 10 分钟；确认后的素材使用独立对象 key，旧上传链接不能覆盖它。服务端代理预览/下载前检查登录及所属空间。原有本地素材继续按原路径读取，不会自动迁移。

备份范围包括 MySQL、加密主密钥、`.local/uploads/` 或整个对象存储桶；缓存不是备份。需要自行配置桶生命周期/数据库备份并演练恢复。不要把工作区 API 返回的数据直接当成已获准再分发的数据产品。

## 数据与任务设计

- `records`：素材、角色、草稿、收藏、竞品、提示词、账号与加密 OAuth token。
- `jobs`：输入、结果、供应商请求 ID、状态、计划时间、幂等请求键。
- `cache_entries`：按工作空间、接口和参数缓存响应。
- `api_usage`：实际请求成功/失败统计。
- `settings`：按空间 AES-256-GCM 加密配置；只有 local 空间可回退读取环境中的供应商凭证。
- `users/sessions/workspaces/memberships/invites/audit_log`：账号、空间、邀请和审计。
- `projects/project_confirmations`：项目、版本和不可替换的确认快照。
- `credit_wallets/credit_reservations/credit_ledger/billing_orders`：可用/冻结额度、结算流水和实际支付订单。
- `automations/system_state/oauth_states`：自动任务、worker 心跳和持久授权状态。

加密主密钥在 `.local/master.key`，也可通过 `X_ENCRYPTION_KEY` 指定 64 位十六进制值。数据库备份必须同时妥善保留主密钥和本地素材；缺少主密钥无法恢复凭证。不要提交 `.local/`、`.env` 或 `.env.local`。

EchoTik 元数据保留 `source`、`endpoint`、`fetchedAt`、`metricPeriod`、`currency`、`coverage`、`isEstimated`。离线商业指标保守标记为含预估，不假设所有金额统一 USD。空响应不是零销量。评论分页使用官方 cursor，历史库使用 page_num/page_size。原始响应保留在界面，便于核对覆盖与分页。

本地预算统计按 UTC 月、本工作区成功请求计算，不等于供应商账单或全账号用量；分页和批量接口的供应商计价仍以合同为准。缓存可降低重复查询，免费的封面签名接口不计入本地预算。对外 SaaS 数据展示、缓存、导出和再分发应确认 EchoTik 专项许可，见 [API 调研](research/echotik-api-2026-10-19/README.md)。

提交结果不明确、服务重启时正在提交或轮询失败的任务进入 `review`，不自动重新提交付费请求。已保存供应商 ID 的任务可查询状态。若刚好在请求发出与 ID 保存之间中断，需在供应商后台核对。草稿箱状态 `inbox` 不冒充已发布。

TikTok 使用文件上传方式，不要求供应商媒体域名归属验证。初始化返回 publish_id 后先保存，再上传分块，最后查询实际发布状态；未审核应用仍受 TikTok 可见范围限制。OAuth 回调 URI 必须与开发者后台完全一致，生产使用 HTTPS。

## 验证

```bash
npm test
npm run test:integration  # 先保持 MySQL 和本机开发应用运行
npm run test:backend      # 真实 MySQL，临时 HTTP 服务及测试账号
npm run test:storage      # 真实 MySQL + 本地 S3 协议服务，不连接云账户
npm run build
```

自动测试覆盖接口参数、长 ID/币种/空值、鉴权、请求去重、失败计数、预算、媒体地址边界及加密防篡改。集成测试对真实 MySQL 和 HTTP 服务检查记录保存、独立连接可见性、文件字节、角色引用和错误状态，清理自己创建的测试数据；不会调用付费供应商。

官方接口目录来源 [EchoTik llms.txt](https://opendocs.echotik.live/llms.txt)。更新命令 `npm run catalog:refresh` 会读取公开 OpenAPI 文档并按路径去重。81 份接口定义中有三组类目重复，当前为 **78 个独立 GET 路径**；这不代表每个市场和每个对象均已实测。

## 项目结构

```text
src/                     React 界面、路由与交互
server/app.ts            HTTP API 与数据操作
server/echotik.ts        官方接口白名单、参数校验、缓存与元数据
server/providers.ts      Gemini / fal.ai 适配
server/jobs.ts           持久任务与生成阶段切换
server/tiktok.ts         OAuth、分块上传与状态查询
server/media.ts          素材与公开视频解析
server/data/             从官方文档生成的接口目录
scripts/                 MySQL 启动、目录更新与集成检查
tests/                   不消费外部额度的自动测试
research/                Clipcat 参考证据与 EchoTik 调研
```

实现参考：[fal 队列 API](https://docs.fal.ai/model-apis/model-endpoints/queue)、[Kling v3 schema](https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video/api)、[Nano Banana 编辑 schema](https://fal.ai/models/fal-ai/nano-banana-2/edit/api)、[Topaz 视频 schema](https://fal.ai/models/fal-ai/topaz/upscale/video/api)、[Gemini 视频理解](https://ai.google.dev/gemini-api/docs/video-understanding)、[TikTok Direct Post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)。
