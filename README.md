# X-Ecommerce

**0.3.0 · 团队自用版**。React + TypeScript、Node.js、MySQL 8.4、FFmpeg。连接“市场研究 → 机会 → 自有商品 → 分镜与生成 → 后期 → 审核发布 → 效果回收”。保留既有数据、供应商切换、额度账本与界面风格；不扩展订单/库存/采购 ERP 或对外收费 SaaS。

外部凭据未提供时，系统明确显示未配置。可以管理商品、机会、案例、分镜、素材和团队，使用本地后期、发布包和手工效果记录。**离线供应商契约测试不代表真实 EchoTik 数据、Kie/fal 成片质量、账单或 TikTok 审核通过**；联调状态见[验收记录](docs/acceptance.md)。

## 本机启动

需要 Node.js 22.19+、MySQL 8.4。FFmpeg/FFprobe 默认使用依赖自带程序，也可用环境变量指定系统版本；字幕需要包含中文字形的字体。

```bash
npm ci
npm run db:local
```

`db:local` 在前台运行独立的 3308 端口数据库，首次生成随机密码写入 `.env.local`，数据在 `.local/mysql/`，不替换系统数据库。另开终端：

```bash
npm run dev
```

打开 http://localhost:4317 。首次启用认证时创建管理员；新建团队空间后，在该空间填写连接配置。已有 MySQL 可复制 `.env.example` 为 `.env.local` 并填写连接信息。

```bash
npm run db:migrate
npm run build
COOKIE_SECURE=false npm start
```

本机 HTTP 使用 `COOKIE_SECURE=false`；HTTPS 部署设 `true`。`AUTH_REQUIRED=true` 启用账号认证。数据库迁移为增量升级，不重置历史表或队列。更完整的启动、升级、Docker、备份恢复见[部署手册](docs/deployment.md)。

## 团队流程

| 入口                     | 操作                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| 工作总览                 | 查看机会、待确认分镜、生成、待发布、异常及研究用量，进入商品/案例/素材                             |
| 灵感与选品               | 六个实体域、市场筛选、榜单/搜索、详情、趋势、评论回复、关联对象；保存搜索、收藏、CSV 和原始证据    |
| 自有商品 / 选品机会      | 保存 SKU、图、卖点、市场、限制；记录机会证据、负责人、状态；关联商品并创建项目                     |
| 竞品跟踪                 | 观察商品/视频/达人/店铺，运行同步并比较历史快照，转为机会或内容项目                                |
| 案例库                   | 从真实视频分析入库；来源去重、编辑、审阅、归档、商品匹配与复用；待分析素材不会伪装成已验证销售案例 |
| 项目与分镜               | 手工或 AI 分镜、调整顺序和时长、复刻、批次草稿、报价确认、逐段生成、局部重制/替换、版本历史        |
| 视频后期                 | 本地拼接、字幕编辑/SRT/VTT 导入导出、烧录、配音/BGM 混音、封面；旧成片保留                         |
| 素材 / 角色              | 图片、视频、音频批量上传、标签、搜索分页、批量 ZIP；引用保护与归档；角色带入兼容模型               |
| 发布中心                 | 审核、导出视频/封面/已有字幕/文案包、登记作品链接；具备资格时启用官方草稿/直发、排期改期取消       |
| 内容效果                 | 授权作品快照或手工指标；趋势和商品/项目/脚本版本/模型比较；制作估算与未知实际账单分开              |
| 自动化研究               | 新品/评论洞察、监控、案例采集、作品同步；预算、证据、运行历史、暂停和通知                          |
| 连接 / 团队 / 运行与审计 | 加密密钥、模型、价格、请求预算、成员角色、空间切换、会话撤销、账号恢复、审计与健康检查             |

生成视频、超分及发布由人工确认。自动化模板不会调用这些动作。素材被项目、确认快照、任务或发布记录引用后不能删除，可归档；图片/视频/音频引用均按工作空间检查。

## 配置服务和模型

密钥在“连接与设置”填写，使用 AES-256-GCM 加密保存。浏览器仅获知是否已配置，不读取旧密钥。环境变量仅作为 `local` 空间的初始后备，不会自动共享到其他团队空间。

| 服务       | 配置                                              | 能力                                                                |
| ---------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| EchoTik    | `ECHOTIK_USERNAME` / `ECHOTIK_PASSWORD`           | 专用 API Basic 凭据；市场数据、评论、原生图片搜索与 TikTok 下载解析 |
| Gemini     | `GEMINI_API_KEY` / `GEMINI_MODEL`                 | 视频理解、分镜、评论洞察、语义图片搜索、案例匹配                    |
| Kie.ai     | `KIE_API_KEY`                                     | Veo Fast、Seedance Mini 视频生成                                    |
| fal.ai     | `FAL_KEY` / 模型配置                              | 视频、AI 首帧、商品图生成/参考图编辑、兼容角色、超分                |
| TikTok     | Client Key / Secret / 回调 / scopes               | 官方 OAuth、授权作品指标、具备资格时草稿及直发                      |
| 可选解析器 | `DOWNLOAD_RESOLVER_URL` / `DOWNLOAD_RESOLVER_KEY` | 你的抖音解析服务，返回 `video_url`                                  |

申请及官方文档：[EchoTik API Keys](https://echotik.live/platform/api-keys)、[EchoTik 接口目录](https://opendocs.echotik.live/llms.txt)、[Gemini](https://aistudio.google.com/apikey)、[Kie](https://kie.ai/api-key)、[fal](https://fal.ai/dashboard/keys)、[TikTok 开发者](https://developers.tiktok.com/)。配置步骤见[连接与使用指南](docs/team-guide.md)。

保留既有默认模型，不自动替换。工作台提供可选的 **Seedance Mini 480p + 商品图首帧** 经济预设。Kie 每段默认直接上传商品图，或显式选择 fal 生成首帧；分镜按模型原生时长生成，再本地裁切拼接。复刻用 Gemini 分析参考视频，再按商品资料改编分镜，并非把完整原片直接当成所有模型的输入。详见[Kie 接入契约](docs/kie-integration.md)。

生成前显示模型、分辨率、首帧方式、片段数、原生秒数和费用。价格规则在项目页“报价规则”配置，记录币种、来源与更新时间。未知项显示未知；内部积分不代表供应商账单。确认冻结报价与输入。修改成功片段产生新任务；不修改的片段复用。仅改字幕/混音/封面走本地 FFmpeg。

提交结果不明进入“待核对”，不会自动再次提交。先核查供应商后台，有请求 ID 时查询状态；确认明确失败或主动重制后再创建新请求。部分成功保留成片，重试只处理失败任务。

## 研究预算与数据边界

运行、自动化每日、工作空间每月的外部请求上限通过 MySQL 事务原子预留。已发出的失败请求计入，缓存命中不计。达到上限后保留已取得的证据，显示预算停止与结果不完整。预算按 UTC 日期，不等于供应商计费次数或余额。

EchoTik 结果保留来源、接口、采集时间、指标窗口和预估标记。未收录、字段缺失与真实零值分别显示。GMV 情报不作为自有作品的已实现收入；不推算未经验证的 ROI。原生图片搜索使用官方 POST 接口（图片最多 2MB），其分页会话绑定工作空间。

## 发布边界

默认导出发布包，无需 TikTok 凭据。配置官方应用后，管理员在发布渠道设置登记资格和验证过的 URL 前缀，按实际权限开启草稿或直发。发布前检查账号、长度、隐私、互动选项、商业内容和 AI 标记，服务端托管视频使用经过验证域名的 `PULL_FROM_URL`。导出记录支持手工登记作品，并回链商品及项目。

TikTok 对纯内部上传工具有 Direct Post 审核限制，团队自用部署不保证获得公开直发资格。见[官方内容分享规范](https://developers.tiktok.com/docs/en/content-sharing-guidelines)。

## 自动验收

测试使用真实 MySQL 和 FFmpeg；供应商请求使用明确的离线契约 fixture。各集成脚本创建独立测试空间并清理，不需要外部 API Key。

```bash
npm test
npm run build
npm run test:foundation
npm run test:backend
npm run test:commerce
npm run test:operations
npm run test:video
npm run test:storage
npx playwright install chromium
npm run test:e2e
npm run test:deployment
```

`test:deployment` 需要创建临时数据库的管理账号，仅在新临时库演练恢复；普通应用账号不需创建数据库权限。可设置 `MYSQL_ADMIN_USER` / `MYSQL_ADMIN_PASSWORD`。`test:integration` 用于验收已经运行的本机服务。CI 运行独立 MySQL 和同样的核心链路。详细证据、截图与真实服务联调清单见[验收记录](docs/acceptance.md)。

## 运维与恢复

`npm run backup -- --out <目录>` 备份数据库、实际素材和加密主密钥；对象存储需另行保存桶内容。`npm run restore -- --help` 查看恢复参数，恢复工具拒绝覆盖非空数据库或非空素材目录。通过临时库验证后切换连接，而非清空现用库。管理员恢复入口在“运行与审计”；管理员本人无法登录时使用 `npm run admin:recovery -- --help`。

默认关闭商业计量，未启用时隐藏额度/支付导航。保留历史 Stripe 和 S3 配置能力；本次不引入新的付费 SaaS 功能。密钥、环境文件、原始数据库及上传文件都不提交 Git。
