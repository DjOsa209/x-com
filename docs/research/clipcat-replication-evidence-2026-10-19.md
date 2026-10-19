# Clipcat 视频复刻：本轮 REA 能确认到哪一步

核查日期：2026-10-19。问题：复刻是“原视频＋新商品图直接送视频模型”，还是“拆分镜、逐段生成、再拼接”？本轮只研究，没有改业务代码，没有登录、注册、运行 Clipcat 业务二进制、付费生成或发布。

## 结论

**追加项目详情页取证后，可以进一步确认：公开客户端具有“需求理解→分镜脚本→视频生成”的独立阶段，并明确消费视频任务的 `concatStatus`、在processing时显示“视频拼接中”。因此“没有拼接阶段证据”的早期结论已被新来源更新。但仍没有恢复到 Clipcat 后端实际发给供应商的payload，也没有观察到“每个镜头一次模型调用→拼接”的执行记录或源码。**

当前证据还支持：

1. raw 和 agent/replicate 是不同入口；部分模型的 raw 模式可以同时接受参考视频和商品图，但这不证明普通复刻实际照此调用。
2. Veo 的平台工作流提供16/24秒，而对应 raw helper限制8秒；新项目页还有专门的拼接状态。两者共同加强了平台生成后合成/编排的证据，**仍不证明按每个镜头独立渲染、不证明一定用FFmpeg concat，也不能排除模型/时长相关的不同策略**。
3. `videoTasks[] / scriptIndex / videoGenerationCount` 不是镜头分段证据。每个子视频具有可独立下载、编辑、发布的交付语义，官方skill也说明一个project可有多个script对应的视频。

因此可据证实现或对齐“需求/分镜/执行三个阶段”和可选合成状态；**不能冒称已经确认一镜一调用的渲染算法**。本轮按研究范围不改业务代码，也不能继续声称 Clipcat 就是参考视频直投模型。若要进一步确认精确粒度，需要自有账号的一次可核对任务及授权日志/服务端材料，且必须看到模型派发与最终渲染证据，单看网页请求还不够。

## 1. 这次确实重新运行了 REA

使用临时安装的 REA **6.7.0**，静态分析已保存公开客户端，代码作为惰性文本读取，没有执行目标bundle。运行参数、source_paths、文件哈希、coverage、producer Evidence ID及实时模型配置摘要在[本轮运行收据](clipcat-replication-rea-receipt-2026-10-19.json)。

| 运行                                   | 实际选择源文件                            | 结果                                                                                                               |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| replication-clients                    | 22639、46623、80350、page-c4、layout-f254 | 5文件196352字节、36模块、0解析失败；Evidence `ev_fabcbbfc66f11cbc3bbaa394536e4ca431c6aa977fc6c52666cda4d7e6a3d8d7` |
| model-helpers                          | 45824                                     | 1文件16912字节、2模块、0解析失败；Evidence `ev_886e685526abc000b365c4c5edc02bf10f293818aeb6ceabcdbb9699221c1d6c`   |
| anonymous-project-page-clients（追加） | 新项目页page-c725、12598                  | 2文件158800字节、42模块、0解析失败；Evidence `ev_341e0887cdc1ed9273d207424935264af1c793986eb9cf2ea95965503d3fc18a` |

三次选择性分析的整体/语义覆盖仍 partial；“没看到”只能限定为已取得客户端，不能推出私有服务端没有某条管线。完整Evidence存收据列出的 `/tmp` 文件，未重复向聊天输出大图。

**时效与追加取证：**最初shell/urllib重新下载6个已知chunk返回403，没有绕过/持续重试。随后主进程在**内置浏览器正常匿名访问**已观察到的项目路由占位ID `/en/project/research-preview`，页面正常加载公开ReactFlow/ClipcatAgent shell；未枚举真实项目、未登录或访问任何实际项目数据。通过CDP `Network.getResponseBody`保存10个HTTP200公开脚本，`project-public/acquisition.json`逐项记录URL/status/hash。该正常浏览器加载补上了新项目页来源，不能把之前的403描述成公开页面不可读。45824及31148当前浏览器响应与旧快照hash一致，其他旧文件仍不一概声称已重新核验。本轮公开只读`POST /api/config/model-configs`也成功；官方博客/模型页面属于供应商说明，不是生成执行记录。

## 2. 真正看到的客户端请求

下列坐标为原文件Python Unicode字符索引，0基左闭右开；哈希见收据，来源资源可直接对照。

**agent/普通复刻入口：**[22639-944483e554ca68a4.js](https://clipcat.ai/_next/static/chunks/22639-944483e554ca68a4.js) `[6840,7465)` builder包含：

```text
model, generationMode, userPrompt, productImages[],
referenceVideoType?, referenceVideoValue?, referenceVideoId?, characterId?,
resolution, duration, language, aspectRatio, enhanceEnabled, enhanceTarget?, deliveryMode
```

该文件`[19050,19570)`实际提交到project wrapper。[layout-f254ec1278905a8f.js](<https://clipcat.ai/_next/static/chunks/app/%5Blocale%5D/(agent)/layout-f254ec1278905a8f.js>) `[5250,5510)`将body送到 **Clipcat自己的** `POST /api/project`；另有`POST /api/project/raw`。

**能证明：**客户端把参考视频引用、商品图、模型与时长交给Clipcat后端。**不能证明：**后端把这些字段原样转发供应商，还是分析后只发prompt、首帧、参考图，或进行多次生成。

**raw入口：**[46623-633d29565140baba.js](https://clipcat.ai/_next/static/chunks/46623-633d29565140baba.js) `[29900,31450)` builder：reference模式包含`referenceImages[]`与`referenceVideos/Audios:[{url,durationSec}]`、可选file/link；frames模式包含firstFrameImage/lastFrameImage；`[52000,52580)`提交到`POST /api/project/raw`。raw具备视频＋图片混合请求的**客户端协议**，不是普通复刻的供应商协议。

`22639...js` `[50700,54650)`的similar/keep_hook/swap_shots等功能只是附加自然语言要求：保留结构、替换部分画面/台词。出现“分镜”一词说明创意要求，不能证明一个分镜就是一个供应商job。

## 3. 官方确实说先提结构、再生成

[官方Codex×Clipcat说明](https://clipcat.ai/zh/blog/codex-tiktok-video-generator-skill)的Replicate/Generate段明确分两步：参考提取钩子、镜头、节奏、人物并形成schema约束prompt，随后把prompt路由到Seedance。另[官方复刻教程](https://clipcat.ai/zh/blog/how-to-clone-viral-tiktok-video)说明解析参考结构、使用新商品/角色生成原创同款。

这直接反对“普通复刻只是不分析地透传原视频和图片”的笼统描述。但这些文档没有披露：是否向生成模型同时传参考视频、每次生成包含多少镜头、是否多段拼接、哪一个供应商端点、有没有extension、最终render命令。

本轮`git ls-remote`确认skill HEAD仍为`7888594dfb5fea29e40a50077d51a7dade97f66f`。[固定版本生成说明](https://github.com/Clipcat-ai/clipcat-skill/blob/7888594dfb5fea29e40a50077d51a7dade97f66f/skills/clipcat/SKILL.md#L298-L319)区分：replicate/product_video有编剧和storyboard；raw透传prompt/素材、不做编剧、storyboard或商品图合成。[同版raw说明](https://github.com/Clipcat-ai/clipcat-skill/blob/7888594dfb5fea29e40a50077d51a7dade97f66f/skills/clipcat/SKILL.md#L692-L698)说raw直接调用模型、没有stitching；这不能逻辑倒推成**所有**replicate必然stitch，更不能推出逐镜独立生成。

## 4. 模型与时长分支：有编排证据，没有逐镜实现证据

主进程本轮公开只读取得`/api/config/model-configs`，响应`code=0`；原始文件：`/var/folders/2b/z81n4myx7k765ws80j1fgvc00000gn/T/rea-clipcat-review-wvebubsa/replication-check-20261019/model-configs.json`，SHA-256 `d11bd9bbd42b8467aeb77c6b3da4deea9eda73cd3f8a6930623c698bfecdca0c`。持久副本：[模型配置](clipcat-replication-model-configs-2026-10-19.json)、[公开请求采集收据](clipcat-replication-public-api-receipt-2026-10-19.json)。REA运行收据保存选定model的原始字段及JSON pointer。

| 当前配置                                                                         | 能确认的能力信息                                         | 不能据此推断                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| veo3.1fast available=true，常规durations720p=[8,16,24]；raw仅frames，maxVideos=0 | 平台常规时长比raw单段能力更宽，raw入口不能直接传参考视频 | agent一定每镜头调用，或服务端绝不会使用其他视频处理/延展路径 |
| seedance2 / mini raw支持reference+frames，maxVideos=3、maxImages=9               | raw模型入口可接受混合参考                                | 普通replicate必然透传整条原视频给同一端点                    |

实际helpers：[45824-8fda6813bea7b70e.js](https://clipcat.ai/_next/static/chunks/45824-8fda6813bea7b70e.js) `[3990,4650)`的Veo常规时长为8/16/24；`[9960,10480)`将Veo raw duration折成8秒、Omni折成10秒；`46623...js` `[6100,6470)`将该helper别名Y用于raw时长选择。价格helper`45824...js` `[11300,12180)`存在按ceil(duration/8)计费的分支；**计费单位不是渲染镜头数量**。

[Clipcat官方Veo页](https://clipcat.ai/zh/models/veo-3-1)说明其原生单段8秒、平台增强输出16/24秒，用户不必手工下载和拼接多段素材。结合helper与当前配置，可确认平台对这类长成片提供额外编排/增强；新项目页进一步确认其客户端存在拼接阶段协议；具体的片段划分、延展/合成策略及供应商服务，仍未公开。不能把“无需用户手动拼接”写成已经审到FFmpeg concat代码。

[Clipcat官方Seedance页](https://clipcat.ai/zh/models/seedance-2-0)说明9图/3视频/3音频多模态参考；这里只用于核对其平台声明，与raw字段相符，不把第三方平台文案当作字节官方协议或普通复刻的真实payload。

## 5. 三个容易误读的对象

### videoTasks / scriptIndex / videoGenerationCount

[80350-12a591116ae87047.js](https://clipcat.ai/_next/static/chunks/80350-12a591116ae87047.js) `[18300,21200)`对每个videoTask独立提供下载、`/editor/{videoId}`、发布、角色提取；还按自身generating/completed/failed显示状态。`[20900,21020)`的scriptIndex用于判断同一脚本是否已有完成视频，决定失败提示是否称为退款。

[31148-c2e484da6376747f.js](https://clipcat.ai/_next/static/chunks/31148-c2e484da6376747f.js) `[18500,19800)`把completed videoTasks映射为可以挑选复刻的clips（videoTaskId/url/cover/name）。[官方skill同版说明](https://github.com/Clipcat-ai/clipcat-skill/blob/7888594dfb5fea29e40a50077d51a7dade97f66f/skills/clipcat/SKILL.md#L324-L327)也明确一个project可有多个视频，每条script对应视频。

所以这些对象更接近**完整成片/脚本版本/尝试**；不能把confirm接口中的`videoGenerationCount`解释成镜头数量。当前没有发现shotIndex→供应商task→merge的可核对关系。

### rawMaterials

`80350...js` `[1800,6800)`组件消费`images/videos/audios/firstFrame/lastFrame/file/link/videoTotalSec`，标签明确为raw输入素材；`[10900,11450)`从某个videoTask拿rawMaterials并在详情中展示。**这是裸调提交的用户素材列表，不是分镜生成片段或剪辑时间线。**

### stitch / concat 字符串

只读扫描旧官方CLI字节发现`stitch`主要属于TikTok Stitch互动开关，`concat`属于Go runtime字符串拼接；例如字节`[3738590,3738870)`含allow-stitch/allow_stitch，`[4097721,4098001)`含runtime.concatstrings。`scriptIndex`只见JSON返回结构标签，例如`[4502706,4502986)`。不能用这些二进制关键词命中冒充视频拼接证据；追加项目页确实有独立的concatStatus证据（见下一节），来源不同。本轮没有执行该二进制或反编译到供应商管线。二进制身份见收据。

## 6. 追加项目详情页：三阶段、可编辑分镜与明确的拼接状态

**来源与身份：**正常匿名内置浏览器加载的[项目详情页公开脚本 page-c72560085e6ccc94.js](https://clipcat.ai/_next/static/chunks/app/%5Blocale%5D/project/%5Bid%5D/page-c72560085e6ccc94.js)，120257字节，SHA-256 `00a6d362c043815c3d6cbf7c6d436594cae1bce0a5be8e009541afebef6a364b`。[公开采集收据](clipcat-replication-project-client-acquisition-2026-10-19.json)记录请求来源与HTTP200；追加的第三次REA运行分析该脚本和12598，Evidence `ev_341e0887cdc1ed9273d207424935264af1c793986eb9cf2ea95965503d3fc18a`。以下仍为Python Unicode字符坐标，不是字节或REA的UTF-16列。

| 具体代码位置                     | 实际可确认的客户端行为                                                                                                                                                                                                | 结论边界                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `[72600,75250)`                  | 消费`requirementAgentStatus / storyboardAgentStatus / videoAgentStatus`，根据pending、processing、waiting_confirmation、completed、failed切换DIRECTOR→SCRIPTWRITER→EXEC_DIRECTOR三个阶段；guide显示确认，fast自动推进 | 三阶段及确认协议真实存在于公开客户端；没有观察到登录任务的实际执行                                                                     |
| `[69700,71180)`                  | 将`storyboardResult`归一成数组，每项`shots`可为数组或JSON字符串；每个shot展示和编辑`timestamp / visual / voiceover`，兼容description/narration，可添加shot                                                            | 可以确认编辑分镜时间线。没有每镜头provider job、model、imagePrompt字段，不能据此认定每镜头一次调用                                     |
| `[85400,87150)`                  | 收集所有`storyboard`节点并排序，将每组所有镜头序列化成`storyboards:[{shots:JSON.stringify(storyboard),character?:...}]`；同时保留首组`shots / character`字段，调用confirm                                             | 确认提交的是整组分镜；character在smart角色时提交描述，并非每镜头单独发生成请求                                                         |
| `[114300,116200)`                | wrapper执行`POST /api/project/{id}/confirm`，body为`{modifiedData,videoGenerationCount}`；GET详情、retry、cancel同在此模块                                                                                            | 这是Clipcat自己的后端接口，不能称为模型供应商接口                                                                                      |
| `[71180,72540)`                  | `videoTask.scriptIndex`选择`storyboardResult`组；同脚本可有多条videoTask；建立`sb-N→vid-M`边，并把`concatStatus`从videoTask放入video节点                                                                              | graph按脚本组映射成片；shots数量在这段代码只用于布局高度，不能把videoTasks当镜头片段                                                   |
| `[31900,32500)`、`[36500,37000)` | VideoNode计算`y = "processing" === e.concatStatus`；标题选择`y ? t("video_concatenating") : t("video_generating")`                                                                                                    | **公开客户端明确具有拼接阶段字段和状态展示**；这是比营销文案更直接的协议证据。但并未拿到一条实际processing任务、生成片段清单或合成命令 |
| `[82900,84400)`                  | 每5秒GET项目详情；raw项目通过CM判定后跳转`/workspace/assets`；完成、失败、取消后停轮询                                                                                                                                | 这套三阶段画布面向agent项目，而不只是raw素材展示；仍不暴露服务端到供应商的派发                                                         |

实际恢复的确认结构可写为下列客户端协议（不是supplier payload）：

```json
{
  "modifiedData": {
    "storyboards": [
      {
        "shots": "[{\"id\":\"1\",\"timestamp\":\"00:00 - 00:08\",\"visual\":\"...\",\"voiceover\":\"...\"}]",
        "character": "..."
      }
    ],
    "shots": "首组shots的同一JSON字符串",
    "character": "首组character"
  }
}
```

`videoGenerationCount`可由同一wrapper携带，分镜确认路径没有传该可选参数；需求确认路径`[84200,85400)`在数量大于1时才传入。因此该字段仍更符合成片版本数量，不能改称分镜数量。

**对实现充分性的判断：**这些证据足以对齐“需求→可编辑分镜→执行→可选拼接状态”的接口与状态大框架。按模型单次时长把长脚本拆段再合成，是一种可行的**自主工程设计**，但现有来源不足以声称这就是Clipcat的切段规则；更不能确认一镜一调用、FFmpeg实现、先生成每镜首帧或某个供应商请求结构。按用户“确认后再实施”的限制，本轮不采用猜测算法修改业务代码。

## 7. 可接受的最终回答边界

| 命题                                                     | 本轮结论                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Clipcat普通复刻会分析参考结构并准备脚本/分镜提示词       | **官方说明＋新项目页三个阶段、storyboardResult与确认body可确认；不是运行期逐步观测** |
| 公开客户端有concatStatus拼接阶段协议及“视频拼接中”显示   | **新项目页真实代码可确认；未观察到实际项目的合成执行日志**                           |
| raw可在支持的模型上同时传视频参考和商品图                | **客户端协议及当前能力元数据可确认**                                                 |
| 普通复刻把原视频和商品图原样送给上游视频模型             | **未确认，不能统一这样描述**                                                         |
| 平台Veo支持超出raw8秒的16/24秒长成片                     | **当前配置、实际helper和官方说明一致**                                               |
| 所有复刻都按每个镜头分段生成再拼接                       | **未确认**                                                                           |
| 具体使用FFmpeg concat / 某个extension API / 多次模型派发 | **未确认**                                                                           |
| videoGenerationCount就是分镜数量                         | **不能据此成立：现有证据不足且成片/脚本语义更强**                                    |

后续若补证，至少需要：每次provider请求的规范化payload、provider task ID与script/shot/segment的映射、最终输出时长、拼接/延展阶段日志或官方服务端实现。普通用户浏览器最多看到Clipcat自己的API，不一定能看到服务器到模型供应商的请求；不能承诺仅登录就能恢复这些细节。

本轮按用户限制仅提交研究报告和小型真实REA收据。业务实现保持原状，明确向用户说明未定案部分。
