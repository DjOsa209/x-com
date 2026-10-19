# EchoTik API：数据能力、真实端点与接入边界

核查日期：2026-10-19（Asia/Shanghai）。仅阅读 EchoTik 官方文档及其提供的 OpenAPI Markdown，没有注册、领取凭证、联系销售或调用付费接口。申请、最新套餐价格和对外展示/转售条款由另份主报告核查，本文聚焦数据与认证。官方[文档目录](https://opendocs.echotik.live/llms.txt)列出了实际可访问的接口说明；以下是文档能力，不是实际数据质量测试结果。

## 结论

**技术上适合作为自建选品/内容研究平台的数据连接器。** 它具备关键词找商品/视频/达人、视频主评论和楼中楼回复、商品评论、商品与视频/达人/店铺关联，以及历史销量/GMV/趋势。不过必须明确分开：`realtime` 是当前公开界面信息，`echotik` 是 EchoTik 已收录的历史电商数据，后者有延迟和覆盖缺口。空结果不能解释为对象不存在。[平台数据介绍](https://opendocs.echotik.live/)、[视频详情说明](https://opendocs.echotik.live/echotik/video/detail)

**视频与达人 GMV 有明确“预估”字段，不能当作 TikTok 后台真实结算数据。** 视频详情的 `total_video_sale_cnt` 与 `total_video_sale_gmv_amt` 分别标注“总销量（预估）”“总销售额（预估）”；达人列表的总/30日 GMV 也标注预估。商品/店铺部分 schema 没有统一标注估算方法，也不能因此反推为审计实值。[视频详情 OpenAPI](https://opendocs.echotik.live/echotik/video/detail.md)、[达人列表 OpenAPI](https://opendocs.echotik.live/echotik/influencer/list.md)

## 认证与服务地址

- API base：`https://open.echotik.live/api/v3`。
- 官方接口认证采用 HTTP Basic：`Authorization: Basic base64(username:password)`；认证文档的“领取专属 username/password”直接链接到 [API Keys 控制台](https://echotik.live/platform/api-keys)。因此应使用在该控制台领取的API专用凭证，不能指导用户直接拿网站登录邮箱/登录密码做Basic认证。
- 营销页面称“Get API Key”，但具体 v3 文档没有把鉴权写成 `Bearer API_KEY` 或 `X-API-Key`。自行实现应按账户实际颁发凭证与官方 v3 文档处理，不猜测 API Key 的编码格式。
- 自己平台由后端保管凭证并代理请求，不能把 username/password 放到用户浏览器前端。该项是常规实现建议，非对商业展示/转售权限的结论。

来源：[官方认证说明](https://opendocs.echotik.live/authentication)、[营销 API 服务页](https://developers.echotik.live/en/api-service)。

## 最新发现：实时搜索与详情

下列均为 `GET`，路径相对于上述 base，字段名按官方 OpenAPI 保留，避免把 Clipcat CLI 自己的参数名误当成 EchoTik 原始参数。

| 场景 | 真实路径 | 核心参数与返回边界 |
|---|---|---|
| 视频关键词搜索 | `/realtime/video/search` | 必填 `keyword,region`；可选 `publish_time`（0/1/7/30/90/180）、`sort_type`（0相关性、1最多点赞）、`offset`；返回命中内容样本，不是全平台完整扫描 |
| 商品关键词搜索 | `/realtime/product/search` | 必填 `sk,region`；可选 `sort_type`（价格升/降、畅销、相关）、`price_range,live,cod,count,offset`；商品结果位置为 `data.body.sections[0].items`；结果不包含完整商品经营信息，需拿 product_id 再补详情 |
| 达人关键词搜索 | `/realtime/influencer/search` | 必填 `keyword,region`，可选 `offset`；候选发现，需接详情/视频列表继续研究 |
| 当前视频详情 | `/realtime/video/detail` | 必填 `video_id`；公开视频前台状态、互动、作者、音乐、挂链上下文，不等同历史带货 GMV |
| 当前达人详情 | `/realtime/influencer/detail` | 必填 `unique_id`；昵称、简介、粉丝、获赞、橱窗等前台资料 |
| 达人近期视频 | `/realtime/influencer/video/list` | 必填 `unique_id,offset`；region可选，未传默认US；下一页 offset 采用 `max_cursor` |

对应官方来源：[视频搜索](https://opendocs.echotik.live/realtime/video/search)、[商品搜索](https://opendocs.echotik.live/realtime/product/search)、[达人搜索](https://opendocs.echotik.live/realtime/influencer/search)、[实时视频详情](https://opendocs.echotik.live/realtime/video/detail)、[实时达人详情](https://opendocs.echotik.live/realtime/influencer/detail)、[实时达人视频](https://opendocs.echotik.live/realtime/influencer/video/list)。

商品实时搜索文档列出的地区为 `GB,ID,IE,US,DE,JP,IT,FR,MY,MX,ES,BR,SG,TH,PH,VN`（16个）。这是该接口的支持列表，不能据此保证所有接口都有相同覆盖或所有对象均可访问。实时接口文档提醒可能遇到风控，业务 `code=500` 不消耗调用额度；生产环境宜有限重试、退避并保留失败原因，不能无限循环。[商品搜索 OpenAPI](https://opendocs.echotik.live/realtime/product/search.md)

## 评论：能拿到评论文本，也有回复接口

| 场景 | 真实 GET 路径 | 参数 / 能拿到什么 |
|---|---|---|
| 视频主评论 | `/realtime/video/comments` | `video_id` 必填；`offset,count` 可选；例子 count=20。评论文本、发布时间、点赞、作者信息、回复数量等；`has_more=1` 后用返回 `cursor` 作为下次 offset |
| 视频楼中楼回复 | `/realtime/video/comments/replies` | `video_id,comment_id` 必填，offset可选；单条主评论下的回复链，亦用cursor翻页；主评论删除或分页变化会影响结果 |
| 已收录商品评论 | `/echotik/product/comment` | `product_id,page_num,page_size` 必填；`min_rating,max_rating`可选（0–5整数）；page_num从1，page_size最多10。返回 `display_text,rating,review_id,review_timestamp,sku_id,sku_specification`；仅限EchoTik已收录评论 |
| 当前商品评论 | `/realtime/product/comment` | `product_id,region,offset` 必填；offset从1，后续使用 `next_cursor`（当has_more=true）。文本、评分、购买身份、晒单媒体、SKU规格等；没有文档化rating服务端过滤参数 |

官方来源：[视频评论](https://opendocs.echotik.live/realtime/video/comments)、[评论回复](https://opendocs.echotik.live/realtime/video/comments/replies)、[历史商品评论](https://opendocs.echotik.live/echotik/product/comment)、[实时商品评论](https://opendocs.echotik.live/realtime/product/comment)。

**适合用户痛点挖掘，但不承诺评论全集或无偏样本。** 主评论和回复应分开采集、保留 comment_id/reply关系、时间与数据源；拿到公开评论文本不等于可把身份资料任意转售。本报告不判定商业授权。

## 商品、视频、店铺、达人的 GMV 从哪里取

均为 `GET /echotik/...` 历史库接口。

| 对象 | 真实路径 | 主要参数和能力 |
|---|---|---|
| 商品经营详情 | `/echotik/product/detail` | `product_ids`，英文逗号分隔，最多10个；价格、佣金、评分、seller_id、总销量/GMV，以及1/7/15/30/60/90日直播与视频销量、GMV和关联数量 |
| 视频带货详情 | `/echotik/video/detail` | `video_ids`，最多10个；总播放、互动、近1/7/30日播放/点赞增量、是否AI、视频销量与销售额（后两项明确预估） |
| 店铺经营详情 | `/echotik/seller/detail` | `seller_id`；总销量/GMV，近1/7/30/90日增量、SKU价格带、商品/达人/视频/直播规模、店铺画像 |
| 达人经营详情 | `/echotik/influencer/detail` | `user_ids` 或 `unique_ids`，单次最多10人；总/30日GMV、内容和带货表现；字段意义参照达人列表，GMV为预估 |
| 商品日级趋势 | `/echotik/product/trend` | `product_id,start_date,end_date,page_num,page_size`；最多近180天，总销量/GMV、单日增量、均价和关联数量 |
| 视频日级趋势 | `/echotik/video/trend` | `video_id,start_date,end_date,page_num,page_size`；最多近180天，互动与带货曲线，销量/销售额标预估 |

官方来源：[商品详情](https://opendocs.echotik.live/echotik/product/detail)、[视频详情](https://opendocs.echotik.live/echotik/video/detail)、[店铺详情](https://opendocs.echotik.live/echotik/seller/detail)、[达人详情](https://opendocs.echotik.live/echotik/influencer/detail)、[达人列表字段定义](https://opendocs.echotik.live/echotik/influencer/list)、[商品趋势](https://opendocs.echotik.live/echotik/product/trend)、[视频趋势](https://opendocs.echotik.live/echotik/video/trend)。

“自动找新品”可先从商品榜单而不是任意实时搜索 ID 开始：`/echotik/product/ranklist` 支持日期、地区、本土/跨境、三级类目、日/周/月榜和分页；返回榜单周期**增量**。视频榜单 `/echotik/video/ranklist` 支持AI视频、图文类型等筛选。周榜日期为周一、月榜为每月1日；不能混淆周期增量与累计总量。[商品榜单](https://opendocs.echotik.live/echotik/product/ranklist)、[视频榜单](https://opendocs.echotik.live/echotik/video/ranklist)

关联查询也已文档化：`/echotik/product/video/list`、`/echotik/influencer/video/list`、`/echotik/video/product/list`、`/echotik/seller/product/list`。其中达人视频可按product_id筛选，按播放/销量/GMV/发布时间排序；店铺商品列表可按总/7日销量或GMV排序。以上依然只覆盖历史库已收录对象，店铺清单不等于当前前台全部在售商品。[达人视频](https://opendocs.echotik.live/echotik/influencer/video/list)、[店铺商品](https://opendocs.echotik.live/echotik/seller/product/list)、[商品视频](https://opendocs.echotik.live/echotik/product/video/list)、[视频商品](https://opendocs.echotik.live/echotik/video/product/list)

## 时效、覆盖和币种的具体限制

1. **历史库不全。** 多数 `/echotik` 文档明确有延迟，空响应表示尚未收录。实时搜索发现的商品/视频不保证能补到历史GMV；不能把“未收录”当销量为0。[商品详情](https://opendocs.echotik.live/echotik/product/detail)、[视频详情](https://opendocs.echotik.live/echotik/video/detail)
2. **历史窗口按接口。** 营销页称可追溯最多1000天，但商品/视频趋势文档明确最多近180天，不宜对客户承诺每个接口1000天。套餐或定制历史另询，按明确接口合同实现。[营销介绍](https://developers.echotik.live/en/api-service)、[商品趋势](https://opendocs.echotik.live/echotik/product/trend)、[视频趋势](https://opendocs.echotik.live/echotik/video/trend)
3. **分页方案不同。** 历史库通常page_num/page_size≤10；实时搜索/视频评论用cursor；实时商品评论offset从1并用next_cursor；达人近期视频用max_cursor。应写独立adapter，不能共用“page++”。[历史商品评论](https://opendocs.echotik.live/echotik/product/comment)、[实时商品评论](https://opendocs.echotik.live/realtime/product/comment)、[达人近期视频](https://opendocs.echotik.live/realtime/influencer/video/list)
4. **没有找到EchoTik原始API的统一美元保证。** 已读官方接口文档没有为所有金额字段声明统一USD。商品详情示例 `skus[].real_price.currency=PHP`，实时店铺商品示例出现 `currency_name=USD`，表明至少嵌套原始价格带币种上下文。聚合GMV的统一口径/汇率基准需要确认；不能把Clipcat自己输出统一USD的规则当成EchoTik原始API规则。[商品详情示例](https://opendocs.echotik.live/echotik/product/detail.md)、[实时店铺商品示例](https://opendocs.echotik.live/realtime/seller/product/list.md)
5. **API能力不等于销量归因。** 高GMV与某视频结构相关，不能证明复制结构会产生同样销量；预估口径、投流、折扣、商品与达人差异均需独立分析。

## 对自己平台的最小接法（建议）

用后台连接器封装两条数据流：历史榜单/趋势产出可核对的机会候选；实时详情/评论补充当前状态和需求证据。保留 `source,fetched_at,metric_period,currency,coverage_status,is_estimated`，将未收录、接口失败、真0值分开。一次API查询或一页评论都计入调用预算，聚合同一实体和缓存，避免每个界面组件重复查询。

候选链路：商品榜单 → 商品详情/趋势 → 关联视频/达人 → 视频评论+重点回复 → 商品差评 → 机会卡。自有店铺利润、库存、真实订单仍需店铺授权数据或用户输入，EchoTik公共/历史数据不能直接替代ERP。
