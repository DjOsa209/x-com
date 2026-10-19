# EchoTik API：申请、价格、数据与平台接入

核查日期：2026-10-19。来源为官方 API 服务页、接口文档、服务协议；价格通过内置浏览器读取动态页面。没有注册账户、购买套餐或调用需要凭证的 API，因此这里区分“文档支持”与“实际数据质量已验证”。

## 结论

EchoTik 提供可接入自建后端的 REST API，覆盖最新搜索、视频与商品评论、商品/视频/店铺/达人 GMV、趋势及关联关系，足以作为选品与内容研究平台的一项上游。最新搜索和评论属于 realtime 路由；GMV 主要来自 EchoTik 已收录的商业数据库，部分字段明确为预估，不能理解为实时结算数据。

技术接入可行，但购买 API 套餐不等于获得无限数据转售权。对外收费平台的数据展示、缓存、导出、衍生分析及多租户使用，需要确认 API 专项商业授权。

## 申请与认证

1. 在 [EchoTik 注册](https://echotik.live/register)。
2. 进入 [API 控制台](https://echotik.live/platform/dashboard)，领取试用或选择套餐。
3. 在 [API Keys 页面](https://echotik.live/platform/api-keys)领取专属 API username/password。
4. 自建后端请求 `https://open.echotik.live/api/v3`，使用 HTTP Basic：`Authorization: Basic base64(username:password)`。

营销页面称 API Key，但认证文档明确使用专属 API 用户名和密码，不应假设是 Bearer Token，也不应使用 TikTok 密码或自行假设网站登录密码就是 API 密码。控制台未登录时需要登录并出现验证码，本次没有继续登录。

来源：[认证文档](https://opendocs.echotik.live/authentication)、[API 服务](https://developers.echotik.live/en/api-service)。

## 当前公开价格

| 套餐 | 价格 | 额度 | 备注 |
|---|---|---|---|
| Free | $0 | 套餐卡写 3 天、50 次、只能领取一次 | 同页顶部和开户介绍仍写 100 次，存在冲突，以实际领取额度为准 |
| Basic | $139/月 | 100,000 次/月 | 额度全用完相当于 $1.39/千次；这是套餐折算，不是按量报价 |
| Pro | 当前 $659/月 | 500,000 次/月 | 原价划线 $694，当前标示 5% 折扣；折算 $1.318/千次 |
| Custom | 询价，年付 | 100,000 次/年起 | 宣传最低 ¥1/千次，未披露享受最低价的购买量与条件 |

这些是 API 套餐，不能与网页分析会员的价格混用。分页、多个关联接口和定时刷新都应纳入请求预算；尚未确认批量查询按一次请求还是按实体另计、超额价格、额度结转和重置时区。

官方 FAQ：HTTP 200 且业务 `code=0` 的请求计费；失败请求不扣额度。离线数据通常 T+1。限速说明写 Free 10 req/s、Pro 30 req/s、Enterprise 定制，未列出 Basic 的 QPS。

来源：[API 服务与价格](https://developers.echotik.live/en/api-service)。本地留存：[页面文字](api-service-rendered.txt)、[完整页面截图](api-service-pricing.jpg)。部分 FAQ 曾单独展开核查，留存的最终文字快照只展开限速条目。

## 关键数据能力

以下路径均相对 `/api/v3`，均为 GET；更细参数与边界见 [接口专项报告](../echotik-api-data-2026-10-19.md)。

| 需求 | 接口例子 | 说明 |
|---|---|---|
| 最新视频搜索 | `/realtime/video/search` | keyword、region；发布时间及排序筛选、分页 |
| 最新商品搜索 | `/realtime/product/search` | 商品关键词参数为 sk；region、价格/销量排序等；完整 GMV 需另查详情 |
| 达人搜索与当前资料 | `/realtime/influencer/search`、`/realtime/influencer/detail` | 关键词、地区、账号信息；与历史带货能力结合使用 |
| 视频评论及回复 | `/realtime/video/comments`、`/realtime/video/comments/replies` | 正文、时间、点赞、作者、回复；分页取回，不代表保证完整历史 |
| 商品评价 | `/realtime/product/comment`、`/echotik/product/comment` | 最新评价与历史收录评价两套；历史接口有评分筛选，每页最多 10 条 |
| 商品/视频/店铺/达人经营指标 | `/echotik/{product,video,seller,influencer}/detail` | GMV、销量、时间窗口等因对象而异；视频与达人部分 GMV 字段明确为预估 |
| 趋势与排行 | `/echotik/product/trend`、`/echotik/video/trend`、相关 ranklist | 商品/视频趋势文档最多近 180 天，不可把宣传“1000 天”套到所有接口 |
| 对象关联 | `/echotik/product/video/list`、`/echotik/video/product/list` 等 | 商品关联视频、视频关联商品、店铺商品、达人视频，用于把选品和素材证据串起来 |

另有直播、关键词、音乐、话题、广告及图片搜商品等接口，具体能力与市场以各端点文档为准。

主要来源：[视频搜索](https://opendocs.echotik.live/realtime/video/search)、[商品搜索](https://opendocs.echotik.live/realtime/product/search)、[视频评论](https://opendocs.echotik.live/realtime/video/comments)、[评论回复](https://opendocs.echotik.live/realtime/video/comments/replies)、[商品评价](https://opendocs.echotik.live/realtime/product/comment)、[商品详情](https://opendocs.echotik.live/echotik/product/detail)、[视频详情](https://opendocs.echotik.live/echotik/video/detail)、[商品趋势](https://opendocs.echotik.live/echotik/product/trend)。

## 数据边界

- `/realtime` 搜索和评论不意味着 GMV 同样实时。离线经营指标通常 T+1，且一些 GMV 是模型预估。
- `/echotik` 依赖已收录对象。最新搜索找到的 ID 可能查不到历史 GMV；返回空不能标成零销量。
- 商品搜索文档列出 16 个市场：GB、ID、IE、US、DE、JP、IT、FR、MY、MX、ES、BR、SG、TH、PH、VN。不同接口、字段、时间跨度的覆盖需要分别核验。
- 未发现原始 API 所有金额统一 USD 的保证。保存币种，向供应商确认各聚合 GMV 字段单位；不能直接套用 Clipcat 的输出归一化规则。
- API 提供外部市场情报，不能据此获得自己店铺真实订单、库存、采购成本或利润；这些还需对接店铺授权接口/ERP。
- 本次没有实测返回率、评论完整性、实时延迟或 GMV 与真实后台的误差。

## 商业平台许可

官方 [服务协议](https://echotik.live/en/service-agreement)（标注生效日 2026-04-29）将 API 纳入服务范围，同时限制账户转售/共享，以及超出授权范围的数据转售、二次分发和商用。官方 [数据说明文章](https://www.echotik.live/blog/tiktok-shop-data/)又明确提到 API 可服务内部仪表盘、SaaS、达人 CRM 等，并要求确认端点、限额和商业条款。

因此结论是：有二次开发产品路径，但对外收费产品需要 API 专项许可，不能只凭通用月付套餐推断授权完整。建议联系 API 页公布的 `massif@echotik.live`，书面确认：

1. 允许在自有收费 SaaS 向多个客户展示哪些原始指标、评论和衍生分析，是否需署名。
2. 缓存期限、历史留存、客户下载/导出、原始数据再分发的权限。
3. 多租户授权与账户规则，以及模型训练/分析用途的边界。
4. 实际套餐报价、Basic QPS、分页/批量计费、超额费、额度重置与终止服务后的数据处理。
5. 目标市场的收录率、T+1 定义、GMV 估算口径、币种及无法收录时的行为。

本次未发送联系信息。

## 适合我们先做的验证

接入结构：平台前端 → 自己的后端 → EchoTik → 统一实体/币种/时间口径与缓存 → 选品分析和工作流。凭证保存在后端；对每项指标记录来源、采集时间、统计窗口、币种和是否预估。

先用试用额度验证少量目标市场商品和视频：最新搜索能否关联历史 GMV、趋势是否有足够覆盖、评论分页是否可用。随后按一个月 Basic 评估选品流程；在购买前确认上述商业许可。可形成的第一条流程是“关键词/榜单发现候选商品 → 拉趋势与竞争数据 → 关联带货视频 → 抽取评论痛点 → 输出有证据的候选机会”。EchoTik 在这里负责数据，上层评分、利润约束、任务流与 ERP/CRM 协同由我们实现。
