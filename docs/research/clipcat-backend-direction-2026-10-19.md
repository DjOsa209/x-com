# Clipcat 后台实现方向：公开客户端证据与 X-Ecommerce 建议

日期：2026-10-19。目的：支持 X-Ecommerce 完成真实后台，恢复可见接口和状态边界；不把猜测当作 Clipcat 服务端源码。没有编辑业务代码、执行 Clipcat 业务二进制或发送生成/付费/发布请求。

## 本轮实际核查

读取现有 `research/clipcat-rea-2026-10-19` 的公共资产、接口 registry 和 REA Evidence；另外用已安装的 **REA 6.7.0 CLI 真正重新分析**两个此前未纳入分析的用户/团队文件：`21041-06e858e2a763c1bf.js`、`78141-97fb64cfe33c5d7f.js`。新 Evidence：`ev_62ffe4deb66a1773a95f138d9f619709770fcb114a72b1f4a52d58772384c27a`；2文件100005字节、14模块、0解析失败。保留目录身份为 `92ed56b0c4eeb4d110582d406762edc80d8b2bd88a2401ae0202763f43389cef`；59文件未选，整体及语义覆盖仍 partial，不能据负结果断言后端没有某功能。

- [本轮运行收据](clipcat-backend-rea-receipt-2026-10-19.json)：版本、参数、身份、覆盖、完整输出位置。
- [本轮从 REA Evidence 摘取的16个 endpoint 节点](clipcat-backend-rea-endpoints-2026-10-19.json)：保留 node_id、源码位置及 AST authority，不是伪造的新 Evidence。
- 完整本轮输出：`/tmp/clipcat-backend-rea-evidence-20261019.json`（约35MB）；stdout JSON、stderr progress 分离。旧10文件 Evidence 为 `ev_877c9bd9c238a3f3d1ef800b1c41cb8818c3e03b46146ab986a4d83b592b9c15`。
- 原始客户端持久副本在 `research/clipcat-rea-2026-10-19/public-js-artifacts.zip`；下文还提供官方资源 URL，线上后续可能更新。

下文字符坐标均为原文件 **Python Unicode `[start,end)`、0基左闭右开**。REA JSON 的 line/column 是其原生坐标，不与 Python 坐标混用。

## 建议直接采用的后台边界

保留用户指定的 **MySQL**。按“业务记录 / 任务执行 / 外部供应商 / 配额账本”分层：项目和每条视频尝试分别建模；工作区隔离所有数据；供应商调用通过有租约的后台任务执行；真实费用用幂等账本记录。缺少供应商凭证或有效输出时明确 blocked/failed，不能把本地创建记录算生成成功。

以上是 X-Ecommerce 的实现建议，不是恢复出的 Clipcat 技术栈；Clipcat bundle 里的 PostgreSQL/Drizzle配置不能覆盖用户对MySQL的要求。

| 能力                         | 已恢复到什么程度                                          | 推荐实现范围                                                | 仍无法恢复                                     |
| ---------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| 项目详情/修改/确认/取消/重试 | 实际 wrapper 与页面状态判断                               | 完整项目生命周期、版本化脚本、子视频尝试、审计              | 服务端事务、provider取消能力、完整确认payload  |
| 用户/团队                    | 实际workspace/invite/member接口，owner/admin/operator角色 | 登录会话、租户隔离、服务端RBAC、邀请与成员管理              | 原平台session实现、精确各角色权限矩阵          |
| Credits/账单                 | 真余额/冻结/过期/流水/订单UI字段                          | 预留/结算/释放、幂等流水、账单订单、可配置真实支付          | 原平台支付路由、webhook、完整价格和退费规则    |
| 数据采集/提示库              | 搜索/榜单/详情/收藏/竞品同步请求                          | 定时采集、原始快照、来源/估算标记、人工审核入库、可检索案例 | Clipcat入库策略、GMV算法、向量/重排实现        |
| Storage/角色                 | usage、直传三阶段、角色抽帧请求                           | 资产权限/配额、上传确认、可清理孤儿文件、角色记录           | 真实存储部署、角色一致性/训练算法              |
| 模型与生成                   | 动态模型配置、两套生成schema、前端价格表                  | provider adapter、能力校验、服务端报价快照、真实异步轮询    | 供应商密钥/协议细节、编剧/分镜prompt、渲染拼接 |
| TikTok发布/定时              | OAuth前端/账户管理实代码；其余官方skill协议               | OAuth、账户状态、真实发布job、定时租约/取消/重试            | 真实publishing worker、token刷新/调度源码      |

## 1. 项目接口与状态

**客户端事实。** [layout-f254ec1278905a8f.js](<https://clipcat.ai/_next/static/chunks/app/%5Blocale%5D/(agent)/layout-f254ec1278905a8f.js>) 模块96957、字符`[4850,6360)`：

```text
POST   /api/project                       # 编排式生成，JSON body
POST   /api/project/raw                   # 模型裸调，另一套body
GET    /api/project?page&limit&status&favoriteOnly&q&scope
GET    /api/project/{id}
PATCH  /api/project/{id}                   # JSON patch
DELETE /api/project/{id}
POST   /api/project/{id}/confirm           # {modifiedData,videoGenerationCount}
POST   /api/project/{id}/retry
POST   /api/project/{id}/cancel
POST   /api/project/batch-download         # {ids}
```

实际可见 PATCH 用途包括title/isFavorite；`modifiedData`内部完整结构没有被当前资产恢复，不能自行声称其schema就是某个特定脚本格式。网页confirm接口也不等同CLI文档中的confirmId协议。[80350-12a591116ae87047.js](https://clipcat.ai/_next/static/chunks/80350-12a591116ae87047.js) `[11200,12400)`可见改标题及收藏handler。

[page-c4aad586e833e1f5.js](<https://clipcat.ai/_next/static/chunks/app/%5Blocale%5D/(workspace)/workspace/page-c4aad586e833e1f5.js>) `[29500,31000)`直接判断`taskStatus=processing/waiting_confirmation/failed`，其他位置包括completed；`videoAgentStatus`与`videoTasks[]`独立。`80350...js` `[20100,21300)`对子视频判断generating/completed/failed；失败提示是否“退款”还看项目整体失败、costCredits>0，以及相同scriptIndex是否已有completed视频。这只能证明UI有分项结果/退款表达，不能当作结算事务已恢复。

**X-Ecommerce建议状态机：**

```text
draft → queued → processing(script) → waiting_confirmation
      → confirmed(version) → queued(render) → processing(render)
      → completed / partially_completed / failed
cancel_requested → cancelled（若provider不可取消，明确保留继续执行/已产生成本状态）
retry：失败子项创建新attempt，不覆盖已成功子项，不重复结算旧attempt
```

`queued/partially_completed/cancel_requested`是本项目推荐补足的状态，不是声称在Clipcat服务端发现。每个转换用条件更新/版本号、workspace_id与幂等键约束；confirm必须绑定脚本版本，生成后禁止静默修改该版本。重复confirm只返回同一批任务；terminal任务取消/重试条件应明确返回409。详情返回项目、脚本版本、子任务、素材来源、费用摘要和错误/重试能力。

## 2. 用户、工作区与邀请

**REA与实际代码证据。** [21041-06e858e2a763c1bf.js](https://clipcat.ai/_next/static/chunks/21041-06e858e2a763c1bf.js) `[3900,5450)`：

| 请求                                   | body                              |
| -------------------------------------- | --------------------------------- |
| GET/POST/PATCH/DELETE `/api/workspace` | 创建/改名`{name}`；删除无业务字段 |
| POST `/api/workspace/invite`           | `{email?,role?}`                  |
| DELETE `/api/workspace/invite`         | `{id}`                            |
| DELETE `/api/workspace/members`        | `{userId}`                        |
| PATCH `/api/workspace/members`         | `{userId,role}`                   |
| GET `/api/workspace/invite/{code}`     | 邀请预览                          |
| POST `/api/workspace/invite/accept`    | `{code}`                          |
| POST `/api/workspace/leave`            | 无业务字段                        |

`[8600,9000)`角色选择枚举是`admin/operator`，结合owner判断可知三种可见角色为 **owner/admin/operator**；不是member。`[39700,40800)`为三角色渲染不同页面。邀请卡带expiresAt、pendingInvites等字段。不能仅根据隐藏按钮恢复完整权限矩阵。

[78141-97fb64cfe33c5d7f.js](https://clipcat.ai/_next/static/chunks/78141-97fb64cfe33c5d7f.js) `[1200,1700)`：POST `/api/user/get-user-info`、`/api/user/get-user-credits`；`[6200,7240)`工作区状态按用户ID缓存，退出/换用户时隔离缓存。新REA endpoint节点 `jag_node_2420c92f8426adc4814613b109386eca5d728354516591ef376ef3661008e14e` 为members，真实源码range和多次请求观察见端点JSON。

**建议。** owner管理workspace/账单/所有成员；admin管理业务与operator但不能删除owner/接管账单；operator只操作授权范围业务。此矩阵是本项目设计。所有list/get/update/download/provider任务均在服务端按workspace与创建者授权；邀请保存token hash、有效期、接受时间并事务消费，限制重复加入与最后owner移除。API Key保存hash及权限，创建仅显示一次明文；原平台前端可复制key不代表本项目应保存可读明文。

## 3. Credits、订单与账单

**客户端事实。** `21041...js` `[50600,54200)`：

- POST `/api/user/orders`返回items、isWorkspaceOwnerLedger、billingProfile、ledgerEmail。
- POST `/api/user/credits-list` body `{transactionType:grant|consume|未设,scope,page,limit:30}`；返回items、remainingCredits、frozenCredits、latestExpiresAt、earliestFrozenExpiresAt。
- POST `/api/user/apikeys`（scope）、`/apikeys/create`、`/apikeys/delete`（id）。
- `[64300,65550)`流水显示transactionNo、transactionType、credits、scene、actorName、createdAt、expiresAt。
- `[45200,45700)` POST `/api/user/billing-profile`，字段name/company/address/taxId；`[47500,48200)` POST `/api/user/orders/{orderNo}/billing-document {type}`返回application/pdf，类型receipt/invoice。

这些支持工作区owner账本、冻结额度和到期信息的存在；看不到真实支付checkout/webhook或数据库账本算法。

**建议。** MySQL使用wallet＋reservation＋append-only ledger＋billing_order：submit时原子预留、成功结算、明确失败/未派发取消释放；供应商超时不可当成未执行，先对账再退款。以job/attempt/外部支付event作唯一reference，余额更改需事务和行锁；不得仅靠UI余额检查。credit产品套餐/支付商配置与生成模型价格分开；没有真实支付配置时显示未配置，不制造paid订单。到期credit批次与冻结reserve要能回放；本轮若只实现不带到期的余额，界面不能伪称完整复现Clipcat到期规则。

## 4. 数据采集、竞品同步与提示库入库

**客户端事实。** [57427-a2d1163420589d79.js](https://clipcat.ai/_next/static/chunks/57427-a2d1163420589d79.js) `[122000,125850)`为inspiration的trends/categories/search、product-videos、competitors CRUD/sync/videos、favorites和quota wrappers；`POST /api/inspiration/competitors/{id}/sync` body`{syncCount}`且timeout=300秒，证明存在用户触发同步入口，不证明后台定时任务实现。

同文件`[28800,30550)`及[87044-4a92d13d5a255712.js](https://clipcat.ai/_next/static/chunks/87044-4a92d13d5a255712.js) `[7850,8850)`、`[26450,27500)`：

```text
GET /api/inspiration/prompt-search?q&region&category&video_type&source
GET /api/viral-prompt/list?page&page_size&region&category&video_type&hook&presenter&duration&period&sort
GET /api/viral-prompt/detail?slug=...
```

UI消费weakMatch/degraded/locked/required、promptZh/promptEn、来源视频、GMV指标和hook/painPoint/visualElements等标签。**没有任何已恢复前端接口证明管理员如何入库、embedding模型、逆向prompt、审核或重新索引。** 不能编造“Clipcat使用某向量数据库”。

**建议自行实现真实流水线。** ingestion job选择市场/类目/时间窗口 → EchoTik发现与详情 → 保存原始快照和来源时间/估算口径 → 去重实体/视频 → 分析为结构化script/shot/hook/claim → draft案例 → 人工review/publish → 建立文本索引，embedding可作为独立可配置增强。没有embedding时使用明确标注的关键词检索；弱匹配阈值可配置。用实际来源构建案例，不能把模型编造的prompt包装成原始生成prompt或真实高GMV证据。

推荐本项目新增后台接口为`/api/ingestion/runs`、`/api/ingestion/schedules`、`/api/prompt-library/:id/review`、`/api/prompt-library/reindex`，这些是**本项目新设计**。历史/实时采集adapter分开分页与缓存，区分未收录、真0值、错误；遵循已调查的EchoTik商业数据授权边界。

## 5. Storage、素材和角色

**客户端事实。** [24079-51494679e372f9fe.js](https://clipcat.ai/_next/static/chunks/24079-51494679e372f9fe.js) `[6700,7650)` GET `/api/storage/usage`返回usedBytes/limitBytes，前端缓存60秒并可主动失效；`[14430,16250)`是POST `/api/storage/upload-asset {filename,contentType}`→data.uploadUrl/key→PUT文件→POST `/api/storage/confirm-upload {key,assetType,name?,tags?}`→url/fileSize/asset。

[50113-fb1c803b035b9a41.js](https://clipcat.ai/_next/static/chunks/50113-fb1c803b035b9a41.js) `[2700,3500)`素材列表、`asset/size`；`[3700,5400)`参考视频压缩后走upload-reference-video＋PUT＋confirm，遥测称r2_put；不能仅凭这个名确定生产部署。

`page-c4...js` `[1400,3500)`浏览器canvas抽JPEG帧；`[34500,36150)`POST `/api/character/from-video-frame` FormData `{name,videoTaskId,sec,frame?}`，以及character CRUD。角色训练/一致性算法不可恢复。

**建议。** 本地文件系统可先完整实现同等资产生命周期，storage adapter支持以后接S3兼容服务。上传前预留配额、上传后校验真实bytes/MIME/媒体时长再确认；用opaque ID而非任意路径提供下载；服务端校验workspace与生成依赖，删除采用tombstone＋清理孤儿文件。角色只关联可访问图片/视频帧，绝不把保存角色记录当成已训练身份模型。

## 6. 模型配置、报价与生成执行

**客户端事实。** 项目wrapper的POST `/api/config/model-configs`与`/image-models`传locale。[45824-8fda6813bea7b70e.js](https://clipcat.ai/_next/static/chunks/45824-8fda6813bea7b70e.js) `[0,2100)`含fallback模型记录与raw能力：available、resolutions、durations、creditMode、resolutionDurationCredits/creditsPerSecond、freeUserAllowed、raw.enabled/imageModes/maxImages/minImages/maxVideos/maxAudios/maxVideoTotalSec等；`[11300,12600)`有前端价格计算/会员条件。fallback不是当前后台实际可用清单，不能直接当供应商契约。

[22639-944483e554ca68a4.js](https://clipcat.ai/_next/static/chunks/22639-944483e554ca68a4.js) `[6840,7465)`的编排body：model、generationMode、userPrompt、productImages、referenceVideoType/Value/Id、characterId、resolution、duration、language、aspectRatio、enhanceEnabled/Target、deliveryMode。[46623-633d29565140baba.js](https://clipcat.ai/_next/static/chunks/46623-633d29565140baba.js) `[29900,31450)`裸调body则为prompt、imageMode、referenceImages、referenceVideos/Audios、referenceFile/Link或first/lastFrameImage等。

**建议。** 服务端动态ModelCatalog按provider是否配置返回available及缺失原因；validate/quote/submit共用同一规范化参数和价格版本，确认保存不可变快照。adapter统一submit/poll/cancel、限制和错误分类；供应商request id与attempt、超时、恢复租约持久化。真实产物验证后登记asset再完成。生成与enhance为不同可重试stage，enhance失败保留原视频，不扣成功增强费；价格和provider成本/用户credit不要混用。没有供应商实现就blocked，拒绝用无语义HTTP占位返回伪成功。

## 7. TikTok账号、发布与定时调度

**实际前端。** [84859-a50024b495052bb2.js](https://clipcat.ai/_next/static/chunks/84859-a50024b495052bb2.js) `[900,3000)` POST `/api/tiktok/connect {locale}`→authorizeUrl/state，ready后每2秒GET `/api/tiktok/connect/status?state=...`；可见loading/ready/blocked/connected，以及expired/denied/quota/failed分支。`[11200,13200)`GET `/api/tiktok/accounts`→accounts/quota；POST `/api/tiktok/disconnect {openId}`；GET `/api/tiktok/connect/adopt?state&locale`。这是真实账户管理逻辑。

当前57个公共JS文件没有恢复到发布worker或scheduler源代码。官方[skill固定commit发布协议](https://github.com/Clipcat-ai/clipcat-skill/blob/7888594dfb5fea29e40a50077d51a7dade97f66f/skills/clipcat/SKILL.md#L331-L347)说明direct/draft、账号隐私能力查询、两步确认、带时区schedule、后台上传与任务取消；[schedule说明](https://github.com/Clipcat-ai/clipcat-skill/blob/7888594dfb5fea29e40a50077d51a7dade97f66f/skills/clipcat/SKILL.md#L349-L362)描述定时Agent，但这些是**文档证据**，不是后台代码。TikTok应用scope/audit约束见[官方Content Posting API](https://developers.tiktok.com/doc/content-posting-api-get-started)。

**建议自行实现。** OAuth state一次性且绑定用户/workspace/到期，token加密存储并由后端刷新；disconnect禁止后续调度使用该账号。发布按`draft→validated→confirmed→scheduled/queued→uploading→processing→published/draft_delivered/failed/cancelled`建模；published必须有TikTok发布状态或可核对结果，draft_delivered不叫公开发布。scheduled保存UTC执行时间与原始IANA时区/offset，worker用MySQL租约及幂等publish key领取到期job；重启可恢复；取消只对尚未上传/可取消阶段生效。对外动作需要用户批准的快照，定时执行也只用已批准参数。定时采集与定时发布分离权限，前者不能意外触发发布。

## 可直接用于验收的检查

1. 角色越权与跨workspace读写/下载/确认均失败；重复接受邀请与移除owner边界稳定。
2. 同一项目confirm两次只创建一批render attempts；重试只重跑失败子项；取消与worker并发不会重复派发。
3. 真实费用预留/结算/释放可幂等回放；同一支付event不重复加款；供应商超时后查询状态再决定退款。
4. 上传未confirm不进入可用素材；超配额/伪MIME/不归属素材拒绝；删除不破坏已批准job引用。
5. 供应商未配置、不支持参数、EchoTik未收录、检索降级和弱匹配均有明确状态；不生成假成功或假GMV。
6. worker重启后恢复到期任务；已发布/草稿已送达与queued/failed清楚分开；无TikTok授权时不能伪发布。

这些是实现的验收建议，而不是本研究已执行的业务测试。

## 新资产身份与复核

| 文件                      | SHA-256                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| 21041-06e858e2a763c1bf.js | e1c2d58a1897559fe84b2abc9308253a122478b3403951ebfa2e073eb3c529ea |
| 78141-97fb64cfe33c5d7f.js | 0f846d5f1582396c846d75cd02c668e02b9191c4772cd846c067b5003222d16d |
| 45824-8fda6813bea7b70e.js | a272545c325a46eba8afa35d390913a6d9cb54cc2b94fe136cfa32c0aa1016e3 |
| 84859-a50024b495052bb2.js | 045760b1e35dfefcf09bcb07a55d0adaa8de78722d80eb78287b857c4ba98ba2 |

其他文件哈希与更细前端流程见[旧前端报告](../../research/clipcat-rea-2026-10-19/frontend-findings.md)。本轮新增REA运行命令及producer结果身份已保存收据，完整原始Evidence未塞入业务代码。未取得Clipcat私有服务端、数据库、供应商账号或付费网络行为，因此报告明确区分：AST实际观察、官方文档、X-Ecommerce自主设计。
