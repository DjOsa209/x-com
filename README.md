# X-Ecommerce

基于 EchoTik 的电商研究与内容创作平台。本项目按照保存的 Clipcat 界面和已确认的功能流程实现，使用自己的品牌、前后端代码和数据接入。当前交付为 **本机单工作区版本**，数据库使用 **MySQL 8.4**。

> 本地页面、持久化和工作流可运行。EchoTik、Gemini、fal.ai、TikTok 尚无真实账户凭证，因此没有实际消费额度、生成视频或发布内容；对应连接器已实现，但供应商返回数据与应用审核需在接入后联调。不能把本版称为已经通过全部生产验证的 1:1 替代品。

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

修改模型 ID 时，应同时检查该模型 schema，不能假设任意模型可替换。当前视频流程先根据商品图、角色与画幅生成首帧，再生成带声音的视频，属于两次供应商生成请求；复刻另含 Gemini 视频分析请求。实际费用由供应商决定，平台没有虚构积分或收费报价。

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

Clipcat 的登录、团队、多租户、订阅计费与积分结算不属于本机单工作区版本。当前没有用户隔离，不应直接绑定公网地址作为商业 SaaS。生产版本需另行完成身份、权限、租户隔离、对象存储、独立 worker、备份及运行部署。

## 数据与任务设计

- `records`：素材、角色、草稿、收藏、竞品、提示词、账号与加密 OAuth token。
- `jobs`：输入、结果、供应商请求 ID、状态、计划时间、幂等请求键。
- `cache_entries`：按接口和参数缓存响应。
- `api_usage`：实际请求成功/失败统计。
- `settings`：AES-256-GCM 加密配置。

加密主密钥在 `.local/master.key`，也可通过 `X_ENCRYPTION_KEY` 指定 64 位十六进制值。数据库备份必须同时妥善保留主密钥和本地素材；缺少主密钥无法恢复凭证。不要提交 `.local/`、`.env` 或 `.env.local`。

EchoTik 元数据保留 `source`、`endpoint`、`fetchedAt`、`metricPeriod`、`currency`、`coverage`、`isEstimated`。离线商业指标保守标记为含预估，不假设所有金额统一 USD。空响应不是零销量。评论分页使用官方 cursor，历史库使用 page_num/page_size。原始响应保留在界面，便于核对覆盖与分页。

本地预算统计按 UTC 月、本工作区成功请求计算，不等于供应商账单或全账号用量；分页和批量接口的供应商计价仍以合同为准。缓存可降低重复查询，免费的封面签名接口不计入本地预算。对外 SaaS 数据展示、缓存、导出和再分发应确认 EchoTik 专项许可，见 [API 调研](research/echotik-api-2026-10-19/README.md)。

提交结果不明确、服务重启时正在提交或轮询失败的任务进入 `review`，不自动重新提交付费请求。已保存供应商 ID 的任务可查询状态。若刚好在请求发出与 ID 保存之间中断，需在供应商后台核对。草稿箱状态 `inbox` 不冒充已发布。

TikTok 使用文件上传方式，不要求供应商媒体域名归属验证。初始化返回 publish_id 后先保存，再上传分块，最后查询实际发布状态；未审核应用仍受 TikTok 可见范围限制。OAuth 回调 URI 必须与开发者后台完全一致，生产使用 HTTPS。

## 验证

```bash
npm test
npm run test:integration  # 先保持 MySQL 和应用运行
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
